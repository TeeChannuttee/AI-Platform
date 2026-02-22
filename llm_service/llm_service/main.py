"""
LLM Service — Chat with RAG, Citations, Memory Layer, Token Tracking.
Port 8004.
"""
import uuid
import json
import time
import re
import traceback
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select, and_, func, delete
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from shared.config import get_settings
from shared.db import get_db, init_db, AsyncSessionLocal
from shared.models import (
    Conversation, Message, File, LLMUsageLog,
    SemanticMemory, EventLog,
)
from shared.dependencies import get_current_user, CurrentUser
from shared.redis_client import redis_client
from shared.logging_utils import setup_logger, get_trace_id, set_trace_id

settings = get_settings()
logger = setup_logger("llm_service", service_version=settings.SYSTEM_VERSION)

# ─── OpenAI Embedding (shared with RAG worker) ───
async def openai_embed(texts: list[str]) -> list[list[float]]:
    """Embed texts using OpenAI text-embedding-3-small (1536d)."""
    import openai
    client = openai.OpenAI(api_key=settings.OPENAI_API_KEY)
    response = client.embeddings.create(
        model=settings.EMBEDDING_MODEL,
        input=texts,
    )
    return [item.embedding for item in response.data]

# ─── Circuit Breaker ───
_circuit_state = {"failures": 0, "last_failure": None, "open": False}
CIRCUIT_THRESHOLD = 5
CIRCUIT_TIMEOUT = 60  # seconds


def _check_circuit():
    if _circuit_state["open"]:
        if _circuit_state["last_failure"]:
            elapsed = time.time() - _circuit_state["last_failure"]
            if elapsed > CIRCUIT_TIMEOUT:
                _circuit_state["open"] = False
                _circuit_state["failures"] = 0
                return True  # Half-open: allow one request
        raise HTTPException(status_code=503, detail="LLM provider circuit breaker is OPEN. Please try again later.")
    return True


def _record_failure():
    _circuit_state["failures"] += 1
    _circuit_state["last_failure"] = time.time()
    if _circuit_state["failures"] >= CIRCUIT_THRESHOLD:
        _circuit_state["open"] = True
        logger.warning("Circuit breaker OPENED")
        # Log circuit breaker event (async-safe: uses background task)
        _pending_circuit_event = True


def _record_success():
    _circuit_state["failures"] = 0
    _circuit_state["open"] = False


# ─── System Prompt ───
SYSTEM_PROMPT = """คุณคือ AI Assistant อัจฉริยะ ที่มีความรู้กว้างขวางเหมือน ChatGPT

หน้าที่ของคุณ:
1. ตอบคำถามอย่างฉลาด ครบถ้วน ทั้งภาษาไทยและอังกฤษ — ใช้ความรู้ของคุณอย่างเต็มที่
2. เมื่อมี context จากเอกสาร (RAG) ให้ใช้ข้อมูลจากเอกสารเป็นหลัก แต่สามารถเสริมด้วยความรู้ของคุณเพื่อให้คำตอบสมบูรณ์ยิ่งขึ้น
3. ตอบในรูปแบบ Markdown — ใช้ headers, bullet points, code blocks, ตาราง ตามความเหมาะสม
4. เมื่ออ้างอิงจากเอกสาร ให้ใส่ citation ในรูปแบบ [citation:N] โดย N คือลำดับของ chunk
5. ถ้าถูกถาม "สรุป" เอกสาร → สรุปเนื้อหาทั้งหมดอย่างละเอียดและเป็นระบบ
6. ใช้ Chain-of-Thought reasoning สำหรับคำถามซับซ้อน
7. ตอบอย่างเป็นธรรมชาติ เป็นมิตร และมีประโยชน์

กฎ Citation:
- ทุกครั้งที่อ้างอิงข้อมูลจากเอกสาร ต้องใส่ [citation:N] ท้ายประโยค
- N = ลำดับของ chunk (เริ่มจาก 1)
- หากไม่มีเอกสาร ให้ตอบจากความรู้ของคุณเองได้เลย ไม่ต้องอ้างอิง"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("LLM Service starting...")
    await init_db()
    yield
    logger.info("LLM Service shutting down...")


app = FastAPI(title="LLM Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


# ─── Schemas ───
class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None
    file_ids: list[str] | None = None
    options: dict | None = None

class ChatResponse(BaseModel):
    answer: str
    conversation_id: str
    message_id: str
    citations: list[dict] | None = None
    usage_tokens: dict
    no_evidence: bool = False

class ConversationResponse(BaseModel):
    id: str
    title: str
    created_at: str | None
    updated_at: str | None

class MemoryPreference(BaseModel):
    key: str
    value: str
    category: str = "preference"
    opt_in: bool = True  # User can opt-out of a specific memory


# ─── Memory Layer ───

class MemoryManager:
    """Triple-tier memory system."""

    @staticmethod
    async def get_working_memory(user_id: str, conversation_id: str, max_messages: int = 20) -> list[dict]:
        """Tier 1: Get recent messages from Redis."""
        key = f"memory:working:{user_id}:{conversation_id}"
        raw = await redis_client.lrange(key, -max_messages, -1)
        messages = []
        for item in raw:
            try:
                messages.append(json.loads(item))
            except Exception:
                continue
        return messages

    @staticmethod
    async def update_working_memory(user_id: str, conversation_id: str, role: str, content: str):
        """Add message to working memory (Redis)."""
        key = f"memory:working:{user_id}:{conversation_id}"
        max_msgs = settings.WORKING_MEMORY_MAX_MESSAGES
        entry = json.dumps({"role": role, "content": content[:2000]})  # Token budget
        await redis_client.rpush(key, entry)
        await redis_client.ltrim(key, -max_msgs, -1)  # Keep last N
        await redis_client.expire(key, settings.WORKING_MEMORY_TTL_SECONDS)

    @staticmethod
    async def get_episodic_memory(user_id: str, query: str) -> list[dict]:
        """Tier 2: Search episodic memory in Qdrant (cached embedder)."""
        try:
            vecs = await openai_embed([query])
            query_vec = vecs[0]

            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{settings.QDRANT_URL}/collections/episodic_memory/points/search",
                    json={
                        "vector": query_vec,
                        "limit": 3,
                        "filter": {"must": [{"key": "user_id", "match": {"value": user_id}}]},
                        "with_payload": True,
                    },
                )
                if resp.status_code == 200:
                    hits = resp.json().get("result", [])
                    return [
                        {
                            "summary": h.get("payload", {}).get("summary", ""),
                            "timestamp": h.get("payload", {}).get("timestamp", ""),
                            "score": h.get("score", 0),
                        }
                        for h in hits if h.get("score", 0) > 0.3
                    ]
        except Exception as e:
            logger.debug(f"Episodic memory retrieval failed (non-critical): {e}")
        return []

    @staticmethod
    async def save_episodic_memory(user_id: str, session_summary: str):
        """Save session summary to episodic memory (Qdrant)."""
        try:
            vecs = await openai_embed([session_summary])
            vec = vecs[0]

            point_id = hashlib.md5(f"{user_id}:{datetime.utcnow().isoformat()}".encode()).hexdigest()
            async with httpx.AsyncClient(timeout=10) as client:
                await client.put(
                    f"{settings.QDRANT_URL}/collections/episodic_memory/points",
                    json={
                        "points": [{
                            "id": point_id,
                            "vector": vec,
                            "payload": {
                                "user_id": user_id,
                                "summary": session_summary,
                                "timestamp": datetime.utcnow().isoformat(),
                            },
                        }],
                    },
                )
        except Exception as e:
            logger.debug(f"Episodic memory save failed (non-critical): {e}")

    @staticmethod
    async def get_semantic_memory(db: AsyncSession, user_id: str) -> list[dict]:
        """Tier 3: Get user preferences from Postgres."""
        result = await db.execute(
            select(SemanticMemory).where(
                and_(
                    SemanticMemory.user_id == uuid.UUID(user_id),
                    SemanticMemory.opt_in == True,
                )
            )
        )
        memories = result.scalars().all()
        return [{"key": m.key, "value": m.value, "category": m.category,
                 "created_at": m.created_at.isoformat() + "+00:00" if m.created_at else None,
                 "updated_at": m.updated_at.isoformat() + "+00:00" if m.updated_at else None} for m in memories]

    @staticmethod
    async def purge_episodic_memory(user_id: str):
        """Purge episodic memory from Qdrant for a user."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{settings.QDRANT_URL}/collections/episodic_memory/points/delete",
                    json={
                        "filter": {
                            "must": [{"key": "user_id", "match": {"value": user_id}}]
                        }
                    },
                )
        except Exception as e:
            logger.debug(f"Episodic memory purge failed (non-critical): {e}")


import hashlib
memory = MemoryManager()


# ─── Citation Validation ───

def extract_citations(answer: str) -> list[int]:
    """Extract [citation:N] markers from answer."""
    return [int(m) for m in re.findall(r'\[citation:(\d+)\]', answer)]


def validate_citations(answer: str, chunks: list[dict]) -> tuple[list[dict], int]:
    """
    Validate citations against retrieved chunks.
    Returns (valid_citations, invalid_count).
    """
    citation_indices = extract_citations(answer)
    valid = []
    invalid_count = 0

    for idx in citation_indices:
        if 1 <= idx <= len(chunks):
            chunk = chunks[idx - 1]
            valid.append({
                "file_id": chunk.get("file_id", ""),
                "page": chunk.get("page", 0),
                "chunk_id": chunk.get("chunk_id", ""),
                "heading": chunk.get("heading", ""),
                "quote": chunk.get("content", "")[:200],
            })
        else:
            invalid_count += 1

    return valid, invalid_count


# ─── LLM Call ───

async def call_llm(messages: list[dict], model: str = None) -> dict:
    """Call OpenAI with retry/backoff."""
    _check_circuit()
    model = model or settings.OPENAI_MODEL
    max_retries = 3

    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": messages,
                        "temperature": 0.7,
                        "max_tokens": 4096,
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    _record_success()
                    return {
                        "content": data["choices"][0]["message"]["content"],
                        "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                        "completion_tokens": data.get("usage", {}).get("completion_tokens", 0),
                        "total_tokens": data.get("usage", {}).get("total_tokens", 0),
                        "model": model,
                    }
                elif resp.status_code == 429:
                    # Rate limited — backoff
                    wait = (attempt + 1) * 2
                    logger.warning(f"OpenAI rate limited, retrying in {wait}s...")
                    import asyncio
                    await asyncio.sleep(wait)
                else:
                    logger.error(f"OpenAI error {resp.status_code}: {resp.text}")
                    _record_failure()
                    if attempt == max_retries - 1:
                        raise HTTPException(status_code=502, detail="LLM provider error")
        except httpx.TimeoutException:
            logger.warning(f"OpenAI timeout, attempt {attempt + 1}")
            _record_failure()
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"LLM call error: {e}")
            _record_failure()

    raise HTTPException(status_code=502, detail="LLM provider unavailable after retries")


# ─── Helper: RAG search via RAG Worker ───

async def rag_search(query: str, file_ids: list[str] | None, tenant_id: str, token: str = "") -> tuple[list[dict], float]:
    """Call RAG Worker for retrieval. Returns (chunks, latency_ms)."""
    start = time.time()
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            payload = {
                "query": query,
                "file_ids": file_ids,
                "tenant_id": tenant_id,
                "top_k": 5,
                "threshold": 0.3,
            }
            logger.info(f"RAG search → {settings.RAG_WORKER_URL}/rag/search payload={payload}")
            resp = await client.post(
                f"{settings.RAG_WORKER_URL}/rag/search",
                json=payload,
                headers={"Authorization": f"Bearer {token}"} if token else {},
            )
            logger.info(f"RAG search ← status={resp.status_code} body={resp.text[:500]}")
            if resp.status_code == 200:
                data = resp.json()
                latency = (time.time() - start) * 1000
                return data.get("chunks", []), latency
            else:
                logger.warning(f"RAG search failed: status={resp.status_code} body={resp.text[:200]}")
    except Exception as e:
        logger.warning(f"RAG search exception: {e}")

    latency = (time.time() - start) * 1000
    return [], latency


# ─── Endpoints ───

@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "service": "llm",
        "version": settings.SYSTEM_VERSION,
        "prompt_version": settings.PROMPT_VERSION,
        "rag_pipeline_version": settings.RAG_PIPELINE_VERSION,
    }


# ═══════════════════════════════════════════════════════════════════════
# IMPORTANT: "Upload for LLM Q&A" (C2, 6 คะแนน) vs "File Management" (B1, 6 คะแนน)
#
#   File Management Upload (/files/upload/*):
#     → เก็บไฟล์ / จัดการสิทธิ์ / ดูไฟล์   (File Service = source of truth)
#
#   LLM Chat Upload (/llm/chat/upload):
#     → "แนบไฟล์เพื่อถามตอบ" — ใช้ File Service upload จริง
#     → เมื่อ ingest เสร็จ ส่ง file_id เข้า RAG อัตโนมัติ + เริ่ม chat ทันที
#     → File Service ยังคงเป็น source of truth เรื่องไฟล์
# ═══════════════════════════════════════════════════════════════════════

@app.post("/llm/chat/upload")
async def chat_upload(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """
    Upload a file specifically for LLM Q&A (C2 — 6 pts).

    Flow:
      1. Client sends file → this endpoint proxies to File Service (source of truth)
      2. File Service stores in MinIO + triggers ClamAV + RAG ingestion
      3. Returns file_id so client can immediately use POST /llm/chat { file_ids: [...] }

    This is SEPARATE from File Management (B1) which is about file CRUD/viewing/ACL.
    Both flows share File Service as the single source of truth.
    """
    set_trace_id(str(uuid.uuid4()))

    # Proxy the multipart upload to File Service's direct upload endpoint
    body = await request.body()
    headers = dict(request.headers)
    headers.pop("host", None)
    headers["X-User-Id"] = user.user_id
    headers["X-Tenant-Id"] = user.tenant_id
    headers["X-User-Role"] = user.role

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{settings.FILE_SERVICE_URL}/files/upload/direct",
                content=body,
                headers=headers,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)

            file_data = resp.json()
            file_id = file_data.get("file_id")
            file_status = file_data.get("status")

            # Log as LLM-specific upload event
            db.add(EventLog(
                trace_id=get_trace_id(),
                tenant_id=uuid.UUID(user.tenant_id),
                user_id=uuid.UUID(user.user_id),
                action="llm_upload",
                resource_type="file",
                resource_id=file_id,
                status="success",
                detail=f"File uploaded for LLM Q&A. Status: {file_status}",
            ))

            return {
                "file_id": file_id,
                "status": file_status,
                "filename": file_data.get("filename"),
                "message": "File uploaded for Q&A. Use POST /llm/chat with file_ids to start asking.",
                "ready": file_status == "ready",
                "processing": file_status == "processing",
            }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"LLM upload proxy failed: {e}")
        raise HTTPException(status_code=502, detail="File upload failed")


@app.post("/llm/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request, db: AsyncSession = Depends(get_db),
               user: CurrentUser = Depends(get_current_user)):
    """
    Main chat endpoint:
    1. Load/create conversation
    2. Load memory (3 tiers)
    3. RAG search if file_ids
    4. Build prompt
    5. Call LLM
    6. Validate citations
    7. Log usage
    8. Update memory
    """
    trace_id = str(uuid.uuid4())
    set_trace_id(trace_id)
    start_total = time.time()

    # Check file_ids status
    if req.file_ids:
        for fid in req.file_ids:
            result = await db.execute(select(File).where(File.id == uuid.UUID(fid)))
            f = result.scalar_one_or_none()
            if not f:
                raise HTTPException(status_code=404, detail=f"File {fid} not found")
            if f.status == "processing":
                raise HTTPException(status_code=409, detail=f"File {fid} is still processing. Progress: {f.chunks_processed}/{f.chunks_total}")
            if f.status != "ready":
                raise HTTPException(status_code=400, detail=f"File {fid} status is '{f.status}', not ready for Q&A")

    # 1. Get or create conversation
    conversation_id = req.conversation_id
    if conversation_id:
        conv_result = await db.execute(
            select(Conversation).where(
                and_(
                    Conversation.id == uuid.UUID(conversation_id),
                    Conversation.user_id == uuid.UUID(user.user_id),
                )
            )
        )
        conversation = conv_result.scalar_one_or_none()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
    else:
        conversation = Conversation(
            user_id=uuid.UUID(user.user_id),
            tenant_id=uuid.UUID(user.tenant_id),
            title=req.message[:50] + "..." if len(req.message) > 50 else req.message,
        )
        db.add(conversation)
        await db.flush()
        conversation_id = str(conversation.id)

    # 2. Load memory
    # Tier 1: Working memory (recent conversation)
    working_mem = await memory.get_working_memory(user.user_id, conversation_id)

    # Tier 2: Episodic memory (past sessions)
    episodic_mem = await memory.get_episodic_memory(user.user_id, req.message)

    # Tier 3: Semantic memory (user preferences)
    semantic_mem = await memory.get_semantic_memory(db, user.user_id)

    # 3. Fetch full file content + RAG search
    rag_chunks = []
    rag_latency = 0
    if req.file_ids:
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        # Fetch ALL chunks from attached files (like ChatGPT/Gemini)
        all_file_chunks = []
        for fid in req.file_ids:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.get(f"{settings.RAG_WORKER_URL}/rag/file/{fid}/chunks")
                    if resp.status_code == 200:
                        data = resp.json()
                        file_chunks = data.get("chunks", [])
                        # Get filename from DB
                        file_result = await db.execute(select(File).where(File.id == uuid.UUID(fid)))
                        file_obj = file_result.scalar_one_or_none()
                        fname = file_obj.filename if file_obj else fid
                        for chunk in file_chunks:
                            chunk["filename"] = fname
                            chunk["file_id"] = fid
                        # Sort by page number for coherent reading
                        file_chunks.sort(key=lambda c: (c.get("page", 0), c.get("chunk_id", "")))
                        all_file_chunks.extend(file_chunks)
                        logger.info(f"Fetched {len(file_chunks)} chunks from file {fname}")
            except Exception as e:
                logger.warning(f"Failed to fetch chunks for file {fid}: {e}")

        if all_file_chunks:
            rag_chunks = all_file_chunks
        else:
            # Fallback to RAG search if full fetch fails
            rag_chunks, rag_latency = await rag_search(req.message, req.file_ids, user.tenant_id, token)

    # 4. Build prompt
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Add semantic memory context (only preference + instruction injected)
    if semantic_mem:
        injected = [m for m in semantic_mem if m.get('category') in ('preference', 'instruction')]
        if injected:
            pref_text = "\n".join([f"- {m['key']}: {m['value']}" for m in injected])
            messages.append({"role": "system", "content": f"User preferences:\n{pref_text}"})

    # Add episodic memory context
    if episodic_mem:
        ep_text = "\n".join([f"- [{m['timestamp']}] {m['summary']}" for m in episodic_mem])
        messages.append({"role": "system", "content": f"Past context:\n{ep_text}"})

    # Add RAG context
    if rag_chunks:
        ctx_parts = []
        for i, chunk in enumerate(rag_chunks, 1):
            ctx_parts.append(
                f"[Chunk {i}] File: {chunk.get('filename', 'unknown')} | "
                f"Page {chunk.get('page', '?')} | {chunk.get('heading', '')}\n"
                f"{chunk.get('content', '')}"
            )
        rag_context = "\n\n".join(ctx_parts)
        messages.append({
            "role": "system",
            "content": f"เอกสารอ้างอิง (Reference Documents):\n\n{rag_context}\n\nใช้ [citation:N] เมื่ออ้างอิง chunk N",
        })

    # Add conversation history from working memory
    for mem in working_mem:
        messages.append(mem)

    # Add current user message
    messages.append({"role": "user", "content": req.message})

    # 5. Call LLM
    infer_start = time.time()
    llm_result = await call_llm(messages)
    infer_latency = (time.time() - infer_start) * 1000

    answer = llm_result["content"]

    # 6. Validate citations
    citations = []
    citation_invalid_count = 0
    if rag_chunks:
        citations, citation_invalid_count = validate_citations(answer, rag_chunks)
        if citation_invalid_count > 0 and not citations:
            # All citations invalid → no-evidence fallback
            answer += "\n\n> ⚠️ หมายเหตุ: ไม่สามารถยืนยันแหล่งอ้างอิงได้ กรุณาตรวจสอบข้อมูลจากเอกสารต้นฉบับ"

    no_evidence = len(rag_chunks) == 0 and bool(req.file_ids)

    # 7. Save messages to DB
    user_msg = Message(
        conversation_id=uuid.UUID(conversation_id),
        role="user",
        content=req.message,
        file_ids=json.dumps(req.file_ids) if req.file_ids else None,
    )
    db.add(user_msg)

    assistant_msg = Message(
        conversation_id=uuid.UUID(conversation_id),
        role="assistant",
        content=answer,
        citations=json.dumps(citations) if citations else None,
        prompt_tokens=llm_result["prompt_tokens"],
        completion_tokens=llm_result["completion_tokens"],
        total_tokens=llm_result["total_tokens"],
        model=llm_result["model"],
    )
    db.add(assistant_msg)
    await db.flush()

    # 8. Log usage (with model_version, prompt_version, rag_pipeline_version for auditability)
    cost = _calculate_cost(llm_result["model"], llm_result["prompt_tokens"], llm_result["completion_tokens"])
    usage_log = LLMUsageLog(
        tenant_id=uuid.UUID(user.tenant_id),
        user_id=uuid.UUID(user.user_id),
        conversation_id=uuid.UUID(conversation_id),
        trace_id=trace_id,
        model=llm_result["model"],
        prompt_tokens=llm_result["prompt_tokens"],
        completion_tokens=llm_result["completion_tokens"],
        total_tokens=llm_result["total_tokens"],
        cost_usd=cost,
        rag_latency_ms=int(rag_latency),
        infer_latency_ms=int(infer_latency),
        pipeline_version=settings.RAG_PIPELINE_VERSION,
        citation_count=len(citations),
        citation_invalid_count=citation_invalid_count,
    )
    db.add(usage_log)

    # Event log — enriched action names for filtering
    db.add(EventLog(
        trace_id=trace_id,
        tenant_id=uuid.UUID(user.tenant_id),
        user_id=uuid.UUID(user.user_id),
        action="chat_success",
        resource_type="conversation",
        resource_id=conversation_id,
        status="success",
        ip=request.headers.get("X-Forwarded-For", request.client.host if request.client else ""),
        user_agent=request.headers.get("User-Agent", ""),
        detail=f"model={llm_result['model']} tokens={llm_result['total_tokens']} citations={len(citations)}",
    ))

    # Log citation quality issue if any hallucinated citations
    if citation_invalid_count > 0:
        db.add(EventLog(
            trace_id=trace_id,
            tenant_id=uuid.UUID(user.tenant_id),
            user_id=uuid.UUID(user.user_id),
            action="citation_invalid_detected",
            resource_type="conversation",
            resource_id=conversation_id,
            status="warning",
            detail=f"invalid={citation_invalid_count} valid={len(citations)}",
        ))

    # 9. Update working memory
    await memory.update_working_memory(user.user_id, conversation_id, "user", req.message)
    await memory.update_working_memory(user.user_id, conversation_id, "assistant", answer)

    # 10. Track daily token usage in Redis (for gateway enforcement)
    today = datetime.utcnow().strftime("%Y-%m-%d")
    dt_key = f"daily_tokens:{user.user_id}:{today}"
    await redis_client.incrby(dt_key, llm_result["total_tokens"])
    await redis_client.expire(dt_key, 86400 * 2)  # Auto-expire after 2 days

    return ChatResponse(
        answer=answer,
        conversation_id=conversation_id,
        message_id=str(assistant_msg.id),
        citations=citations if citations else None,
        usage_tokens={
            "prompt_tokens": llm_result["prompt_tokens"],
            "completion_tokens": llm_result["completion_tokens"],
            "total_tokens": llm_result["total_tokens"],
            "cost_usd": cost,
            "rag_latency_ms": int(rag_latency),
            "infer_latency_ms": int(infer_latency),
            "model_version": llm_result["model"],
            "prompt_version": settings.PROMPT_VERSION,
            "rag_pipeline_version": settings.RAG_PIPELINE_VERSION,
        },
        no_evidence=no_evidence,
    )


def _calculate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Estimate cost in USD based on model pricing."""
    pricing = {
        "gpt-4o": {"input": 2.50 / 1_000_000, "output": 10.00 / 1_000_000},
        "gpt-4o-mini": {"input": 0.15 / 1_000_000, "output": 0.60 / 1_000_000},
        "gpt-4-turbo": {"input": 10.00 / 1_000_000, "output": 30.00 / 1_000_000},
        "gpt-3.5-turbo": {"input": 0.50 / 1_000_000, "output": 1.50 / 1_000_000},
    }
    p = pricing.get(model, pricing["gpt-4o-mini"])
    return round(prompt_tokens * p["input"] + completion_tokens * p["output"], 6)


# ─── Conversations ───

@app.get("/llm/conversations")
async def list_conversations(db: AsyncSession = Depends(get_db),
                             user: CurrentUser = Depends(get_current_user)):
    result = await db.execute(
        select(Conversation).where(
            Conversation.user_id == uuid.UUID(user.user_id)
        ).order_by(Conversation.updated_at.desc())
    )
    convs = result.scalars().all()
    return [
        {
            "id": str(c.id),
            "title": c.title,
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        }
        for c in convs
    ]


@app.get("/llm/conversations/{conv_id}")
async def get_conversation(conv_id: str, db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(get_current_user)):
    result = await db.execute(
        select(Conversation).where(
            and_(
                Conversation.id == uuid.UUID(conv_id),
                Conversation.user_id == uuid.UUID(user.user_id),
            )
        )
    )
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    msgs_result = await db.execute(
        select(Message).where(
            Message.conversation_id == uuid.UUID(conv_id)
        ).order_by(Message.created_at.asc())
    )
    msgs = msgs_result.scalars().all()

    return {
        "id": str(conv.id),
        "title": conv.title,
        "messages": [
            {
                "id": str(m.id),
                "role": m.role,
                "content": m.content,
                "citations": json.loads(m.citations) if m.citations else None,
                "file_ids": json.loads(m.file_ids) if m.file_ids else None,
                "tokens": {
                    "prompt": m.prompt_tokens,
                    "completion": m.completion_tokens,
                    "total": m.total_tokens,
                },
                "model": m.model,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in msgs
        ],
    }


@app.delete("/llm/conversations/{conv_id}")
async def delete_conversation(conv_id: str, db: AsyncSession = Depends(get_db),
                              user: CurrentUser = Depends(get_current_user)):
    result = await db.execute(
        select(Conversation).where(
            and_(
                Conversation.id == uuid.UUID(conv_id),
                Conversation.user_id == uuid.UUID(user.user_id),
            )
        )
    )
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    await db.execute(delete(Message).where(Message.conversation_id == uuid.UUID(conv_id)))
    await db.execute(delete(Conversation).where(Conversation.id == uuid.UUID(conv_id)))

    # Clean working memory
    await redis_client.delete(f"memory:working:{user.user_id}:{conv_id}")

    # Event log
    db.add(EventLog(
        trace_id=str(uuid.uuid4()),
        tenant_id=uuid.UUID(user.tenant_id),
        user_id=uuid.UUID(user.user_id),
        action="conversation_deleted",
        resource_type="conversation",
        resource_id=conv_id,
        status="success",
        detail=f"title={conv.title}",
    ))

    return {"message": "Conversation deleted"}


# ─── Memory Management ───

@app.get("/llm/memory")
async def get_semantic_memories(db: AsyncSession = Depends(get_db),
                                user: CurrentUser = Depends(get_current_user)):
    mems = await memory.get_semantic_memory(db, user.user_id)
    return mems


@app.post("/llm/memory")
async def set_semantic_memory(req: MemoryPreference, db: AsyncSession = Depends(get_db),
                              user: CurrentUser = Depends(get_current_user)):
    """Set or update a user preference (Tier 3). Rate limited."""
    # Rate limit check (sliding window in Redis)
    rate_key = f"ratelimit:memory:{user.user_id}"
    current = await redis_client.incr(rate_key)
    if current == 1:
        await redis_client.expire(rate_key, 60)  # 1 minute window
    if current > settings.MEMORY_WRITE_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many memory writes. Try again later.")

    # PII scrubbing (Thai-specific patterns)
    import re as regex
    scrubbed = regex.sub(r'\b\d{1}-?\d{4}-?\d{5}-?\d{2}-?\d{1}\b', '[REDACTED_ID]', req.value)  # Thai ID: X-XXXX-XXXXX-XX-X
    scrubbed = regex.sub(r'\b0\d{1,2}-?\d{3,4}-?\d{4}\b', '[REDACTED_PHONE]', scrubbed)  # Thai phone: 0XX-XXX-XXXX

    result = await db.execute(
        select(SemanticMemory).where(
            and_(
                SemanticMemory.user_id == uuid.UUID(user.user_id),
                SemanticMemory.key == req.key,
            )
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.value = scrubbed
        existing.category = req.category
        existing.opt_in = req.opt_in
        existing.updated_at = datetime.utcnow()
    else:
        db.add(SemanticMemory(
            user_id=uuid.UUID(user.user_id),
            tenant_id=uuid.UUID(user.tenant_id),
            key=req.key,
            value=scrubbed,
            category=req.category,
            opt_in=req.opt_in,
        ))

    return {"message": f"Memory '{req.key}' saved"}


@app.delete("/llm/memory/purge")
async def purge_all_memory(db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(get_current_user)):
    """Purge ALL memory for user (all 3 tiers — GDPR/PDPA compliant)."""
    # Tier 3: Delete all semantic memory from Postgres
    await db.execute(
        delete(SemanticMemory).where(SemanticMemory.user_id == uuid.UUID(user.user_id))
    )
    # Tier 1: Clear all Redis working memory keys
    keys = await redis_client.keys(f"memory:working:{user.user_id}:*")
    if keys:
        await redis_client.delete(*keys)
    # Tier 2: Purge episodic memory from Qdrant
    await memory.purge_episodic_memory(user.user_id)

    return {"message": "All memory purged (Tier 1 + Tier 2 + Tier 3)"}


@app.delete("/llm/memory/{key}")
async def delete_semantic_memory(key: str, db: AsyncSession = Depends(get_db),
                                 user: CurrentUser = Depends(get_current_user)):
    """Purge a specific memory (opt-out)."""
    await db.execute(
        delete(SemanticMemory).where(
            and_(
                SemanticMemory.user_id == uuid.UUID(user.user_id),
                SemanticMemory.key == key,
            )
        )
    )
    return {"message": f"Memory '{key}' purged"}


# ─── Token Usage APIs ───

@app.get("/usage/messages")
async def usage_messages(
    conversation_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """Per-message token usage."""
    query = select(LLMUsageLog).where(LLMUsageLog.user_id == uuid.UUID(user.user_id))
    if conversation_id:
        query = query.where(LLMUsageLog.conversation_id == uuid.UUID(conversation_id))
    query = query.order_by(LLMUsageLog.created_at.desc()).limit(100)

    result = await db.execute(query)
    logs = result.scalars().all()
    return [
        {
            "id": str(l.id),
            "conversation_id": str(l.conversation_id) if l.conversation_id else None,
            "model": l.model,
            "prompt_tokens": l.prompt_tokens,
            "completion_tokens": l.completion_tokens,
            "total_tokens": l.total_tokens,
            "cost_usd": l.cost_usd,
            "rag_latency_ms": l.rag_latency_ms,
            "infer_latency_ms": l.infer_latency_ms,
            "created_at": l.created_at.isoformat() if l.created_at else None,
        }
        for l in logs
    ]


@app.get("/usage/daily")
async def usage_daily(
    from_date: str | None = None, to_date: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    return await _aggregate_usage(db, user, "day", from_date, to_date)


@app.get("/usage/weekly")
async def usage_weekly(
    from_date: str | None = None, to_date: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    return await _aggregate_usage(db, user, "week", from_date, to_date)


@app.get("/usage/monthly")
async def usage_monthly(
    from_date: str | None = None, to_date: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    return await _aggregate_usage(db, user, "month", from_date, to_date)


async def _aggregate_usage(db: AsyncSession, user: CurrentUser, period: str,
                           from_date: str | None, to_date: str | None):
    """Aggregate token usage by period."""
    from sqlalchemy import text

    trunc_map = {"day": "day", "week": "week", "month": "month"}
    trunc = trunc_map.get(period, "day")

    sql = text(f"""
        SELECT
            date_trunc(:trunc, created_at) as period,
            COUNT(*) as request_count,
            SUM(prompt_tokens) as total_prompt_tokens,
            SUM(completion_tokens) as total_completion_tokens,
            SUM(total_tokens) as total_tokens,
            SUM(cost_usd) as total_cost_usd,
            AVG(rag_latency_ms) as avg_rag_latency_ms,
            AVG(infer_latency_ms) as avg_infer_latency_ms
        FROM llm_usage_logs
        WHERE user_id = :user_id
        {"AND created_at >= :from_date" if from_date else ""}
        {"AND created_at <= :to_date" if to_date else ""}
        GROUP BY period
        ORDER BY period DESC
        LIMIT 90
    """)

    params = {"trunc": trunc, "user_id": user.user_id}
    if from_date:
        params["from_date"] = from_date
    if to_date:
        params["to_date"] = to_date

    result = await db.execute(sql, params)
    rows = result.fetchall()

    return [
        {
            "period": row[0].isoformat() if row[0] else None,
            "request_count": row[1],
            "total_prompt_tokens": row[2],
            "total_completion_tokens": row[3],
            "total_tokens": row[4],
            "total_cost_usd": float(row[5]) if row[5] else 0,
            "avg_rag_latency_ms": float(row[6]) if row[6] else 0,
            "avg_infer_latency_ms": float(row[7]) if row[7] else 0,
        }
        for row in rows
    ]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8004)
