"""
RAG Ingestion Worker — Parse, Chunk, Embed, Upsert to Qdrant.
Also serves retrieval pipeline (search + rerank).
Port 8003.
"""
import uuid
import hashlib
import io
import json
import traceback
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from minio import Minio
import httpx

from shared.config import get_settings
from shared.db import get_db, init_db, AsyncSessionLocal
from shared.models import File
from shared.dependencies import get_current_user, CurrentUser
from shared.logging_utils import setup_logger, get_trace_id, set_trace_id

settings = get_settings()
logger = setup_logger("rag_worker", service_version=settings.SYSTEM_VERSION)

# MinIO client
minio_client = Minio(
    settings.MINIO_ENDPOINT,
    access_key=settings.MINIO_ACCESS_KEY,
    secret_key=settings.MINIO_SECRET_KEY,
    secure=settings.MINIO_USE_SSL,
)

# ─── OpenAI Embedding (high quality) ───
async def openai_embed(texts: list[str]) -> list[list[float]]:
    """Embed texts using OpenAI text-embedding-3-small (1536d)."""
    import openai
    client = openai.OpenAI(api_key=settings.OPENAI_API_KEY)
    response = client.embeddings.create(
        model=settings.EMBEDDING_MODEL,
        input=texts,
    )
    return [item.embedding for item in response.data]


# ─── FlashRank Reranker (lazy loaded) ───
_reranker = None

def get_reranker():
    global _reranker
    if _reranker is None:
        from flashrank import Ranker
        _reranker = Ranker(model_name="ms-marco-MultiBERT-L-12")
        logger.info("Loaded FlashRank reranker: ms-marco-MultiBERT-L-12")
    return _reranker


# Qdrant REST helpers
async def qdrant_request(method: str, path: str, json_data=None):
    async with httpx.AsyncClient(timeout=30) as client:
        url = f"{settings.QDRANT_URL}{path}"
        resp = await client.request(method, url, json=json_data)
        if resp.status_code not in (200, 201):
            logger.error(f"Qdrant {method} {path} failed: {resp.text}")
        return resp.json() if resp.status_code in (200, 201) else None


async def ensure_collection():
    """Create collection if not exists."""
    result = await qdrant_request("GET", f"/collections/{settings.QDRANT_COLLECTION}")
    if result and result.get("status") == "ok":
        return
    await qdrant_request("PUT", f"/collections/{settings.QDRANT_COLLECTION}", {
        "vectors": {"size": settings.EMBEDDING_DIM, "distance": "Cosine"},
    })
    logger.info(f"Created Qdrant collection: {settings.QDRANT_COLLECTION}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("RAG Worker starting...")
    await init_db()
    try:
        await ensure_collection()
    except Exception as e:
        logger.warning(f"Qdrant init failed (will retry): {e}")
    yield
    logger.info("RAG Worker shutting down...")


app = FastAPI(title="RAG Ingestion Worker", version=settings.SYSTEM_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


# ─── Schemas ───
class IngestRequest(BaseModel):
    file_id: str
    storage_key: str
    mime_type: str
    # tenant_id / owner_id / filename are verified from File record in DB
    # (not trusted from body — prevents spoofing even on internal calls)

class SearchRequest(BaseModel):
    query: str
    file_ids: list[str] | None = None
    tenant_id: str | None = None
    top_k: int = 10
    threshold: float = 0.3
    # Internal: called by LLM Service only (no JWT needed)

class ChunkResult(BaseModel):
    chunk_id: str
    file_id: str
    page: int
    heading: str
    content: str
    score: float


# ─── Document Parsing ───

def parse_pdf(data: bytes) -> list[dict]:
    """Parse PDF into pages. Returns list of {page, text, heading}."""
    import fitz  # PyMuPDF
    pages = []
    doc = fitz.open(stream=data, filetype="pdf")

    if doc.page_count > 500:
        doc.close()
        raise ValueError(f"PDF has {doc.page_count} pages (max 500)")

    for i, page in enumerate(doc):
        text = page.get_text("text")
        if text.strip():
            # Extract first line as heading
            lines = text.strip().split("\n")
            heading = lines[0][:100] if lines else f"Page {i+1}"
            pages.append({"page": i + 1, "text": text, "heading": heading})
    doc.close()
    return pages


def parse_docx(data: bytes) -> list[dict]:
    """Parse DOCX into sections."""
    import docx
    doc = docx.Document(io.BytesIO(data))
    pages = []
    current_text = []
    current_heading = "Document Start"
    page_num = 1

    for para in doc.paragraphs:
        if para.style.name.startswith("Heading"):
            if current_text:
                pages.append({
                    "page": page_num,
                    "text": "\n".join(current_text),
                    "heading": current_heading,
                })
                page_num += 1
            current_heading = para.text[:100]
            current_text = [para.text]
        else:
            current_text.append(para.text)

    if current_text:
        pages.append({"page": page_num, "text": "\n".join(current_text), "heading": current_heading})
    return pages


def parse_text(data: bytes) -> list[dict]:
    """Parse plain text / CSV."""
    text = data.decode("utf-8", errors="replace")
    # Split into ~2000 char pages
    pages = []
    chunk_size = 2000
    for i in range(0, len(text), chunk_size):
        pages.append({
            "page": i // chunk_size + 1,
            "text": text[i:i + chunk_size],
            "heading": f"Section {i // chunk_size + 1}",
        })
    return pages


# ─── Chunking ───

def smart_chunk(pages: list[dict], max_tokens: int = 800, overlap_tokens: int = 100) -> list[dict]:
    """
    Semantic chunking: split by paragraph boundaries, then merge small paragraphs
    up to max_tokens. Produces higher quality chunks that respect text structure.
    """
    chunks = []
    for page in pages:
        text = page["text"].strip()
        if not text:
            continue

        # Split by paragraph boundaries (double newline, or heading patterns)
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        if not paragraphs:
            paragraphs = [text]

        # Merge small paragraphs into chunks up to max_tokens
        current_chunk = ""
        current_tokens = 0

        for para in paragraphs:
            para_tokens = len(para.split())  # Word-approximate tokens

            if current_tokens + para_tokens <= max_tokens:
                current_chunk += ("\n\n" if current_chunk else "") + para
                current_tokens += para_tokens
            else:
                # Save current chunk
                if current_chunk and current_tokens > 15:
                    chunks.append({
                        "page": page["page"],
                        "heading": page["heading"],
                        "content": current_chunk,
                    })

                # If single paragraph is too large, split it with overlap
                if para_tokens > max_tokens:
                    words = para.split()
                    for i in range(0, len(words), max_tokens - overlap_tokens):
                        segment = " ".join(words[i:i + max_tokens])
                        if len(segment.split()) > 15:
                            chunks.append({
                                "page": page["page"],
                                "heading": page["heading"],
                                "content": segment,
                            })
                    current_chunk = ""
                    current_tokens = 0
                else:
                    # Start new chunk with overlap from previous
                    if current_chunk:
                        overlap_text = " ".join(current_chunk.split()[-overlap_tokens:])
                        current_chunk = overlap_text + "\n\n" + para
                        current_tokens = len(current_chunk.split())
                    else:
                        current_chunk = para
                        current_tokens = para_tokens

        # Don't forget the last chunk
        if current_chunk and current_tokens > 15:
            chunks.append({
                "page": page["page"],
                "heading": page["heading"],
                "content": current_chunk,
            })

    return chunks


# ─── Endpoints ───

@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "service": "rag_worker",
        "version": settings.SYSTEM_VERSION,
        "rag_pipeline_version": settings.RAG_PIPELINE_VERSION,
        "embedding_model": settings.EMBEDDING_MODEL,
    }


@app.post("/rag/ingest")
async def ingest(req: IngestRequest):
    """
    Ingest a file: parse → chunk → embed → upsert to Qdrant.
    Tenant/owner/filename verified from DB File record (not trusted from body).
    Idempotent: deterministic chunk IDs allow safe retry without duplication.
    """
    set_trace_id(str(uuid.uuid4()))
    logger.info(f"Starting ingestion for file {req.file_id}")

    try:
        # 0. Verify file record from DB (source of truth for tenant/owner)
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(File).where(File.id == uuid.UUID(req.file_id)))
            file_record = result.scalar_one_or_none()

        if not file_record:
            return {"status": "failed", "detail": "File not found in DB"}

        tenant_id = str(file_record.tenant_id)
        owner_id = str(file_record.owner_id)
        filename = file_record.filename
        mime_type = file_record.mime_type or req.mime_type

        # 1. Download from MinIO
        response = minio_client.get_object(settings.MINIO_BUCKET, req.storage_key)
        data = response.read()
        response.close()
        response.release_conn()

        # 2. Parse based on MIME
        if mime_type == "application/pdf":
            pages = parse_pdf(data)
        elif mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            pages = parse_docx(data)
        else:
            pages = parse_text(data)

        if not pages:
            await _update_file_status(req.file_id, "failed", detail="No content extracted")
            return {"status": "failed", "detail": "No content extracted"}

        # 3. Chunk
        chunks = smart_chunk(pages)
        logger.info(f"File {req.file_id}: {len(pages)} pages → {len(chunks)} chunks")

        # Update chunks_total in File record
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(File).where(File.id == uuid.UUID(req.file_id)))
            f = result.scalar_one_or_none()
            if f:
                f.chunks_total = len(chunks)
                f.chunks_processed = 0
                await db.commit()

        # 4. Embed
        texts = [c["content"] for c in chunks]
        # Batch embed with OpenAI (max 2048 per batch)
        embeddings = []
        for i in range(0, len(texts), 2048):
            batch = texts[i:i + 2048]
            batch_embeddings = await openai_embed(batch)
            embeddings.extend(batch_embeddings)

        # 5. Upsert to Qdrant (deterministic IDs → idempotent on retry)
        points = []
        for i, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
            chunk_id = hashlib.md5(
                f"{req.file_id}:{chunk['page']}:{i}".encode()
            ).hexdigest()

            points.append({
                "id": chunk_id,
                "vector": embedding,
                "payload": {
                    "file_id": req.file_id,
                    "tenant_id": tenant_id,       # from DB (verified)
                    "owner_id": owner_id,          # from DB (verified)
                    "filename": filename,           # from DB (verified)
                    "page": chunk["page"],
                    "heading": chunk["heading"],
                    "content": chunk["content"],
                    "chunk_hash": hashlib.md5(chunk["content"].encode()).hexdigest(),
                    "chunk_index": i,
                },
            })

        # 6. Batch upsert (100 at a time) with progress tracking
        batch_size = 100
        for i in range(0, len(points), batch_size):
            batch = points[i:i + batch_size]
            await qdrant_request("PUT", f"/collections/{settings.QDRANT_COLLECTION}/points", {
                "points": batch,
            })
            # Update chunks_processed (accurate progress)
            async with AsyncSessionLocal() as db:
                result = await db.execute(select(File).where(File.id == uuid.UUID(req.file_id)))
                f = result.scalar_one_or_none()
                if f:
                    f.chunks_processed = min(i + batch_size, len(points))
                    await db.commit()

        # 7. Mark complete
        await _update_file_status(req.file_id, "ready")
        logger.info(f"Ingestion complete for {req.file_id}: {len(points)} chunks indexed")

        return {"status": "ready", "chunks": len(points), "pages": len(pages)}

    except Exception as e:
        logger.error(f"Ingestion failed for {req.file_id}: {traceback.format_exc()}")
        await _update_file_status(req.file_id, "failed", detail=str(e))
        return {"status": "failed", "detail": str(e)}


async def _update_file_status(file_id: str, status: str, detail: str = None):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(File).where(File.id == uuid.UUID(file_id)))
        f = result.scalar_one_or_none()
        if f:
            f.status = status
            await db.commit()


@app.post("/rag/search")
async def search(req: SearchRequest):
    """
    Retrieval pipeline: embed query → search Qdrant → rerank → filter.
    """
    set_trace_id(str(uuid.uuid4()))

    # Embed query
    # Embed query with OpenAI
    query_vecs = await openai_embed([req.query])
    query_vec = query_vecs[0]

    # Build Qdrant filter
    must_conditions = []
    if req.tenant_id:
        must_conditions.append({
            "key": "tenant_id",
            "match": {"value": req.tenant_id},
        })
    if req.file_ids:
        must_conditions.append({
            "key": "file_id",
            "match": {"any": req.file_ids},
        })

    search_body = {
        "vector": query_vec,
        "limit": req.top_k * 3,  # Over-fetch 3x for cross-encoder reranking
        "with_payload": True,
        "score_threshold": req.threshold,
    }
    if must_conditions:
        search_body["filter"] = {"must": must_conditions}

    result = await qdrant_request(
        "POST",
        f"/collections/{settings.QDRANT_COLLECTION}/points/search",
        search_body,
    )

    if not result or "result" not in result:
        return {"chunks": [], "no_evidence": True}

    hits = result["result"]

    if not hits:
        return {"chunks": [], "no_evidence": True}

    # ─── FlashRank Cross-Encoder Reranking ───
    try:
        from flashrank import RerankRequest
        reranker = get_reranker()
        rerank_passages = [
            {"id": i, "text": h.get("payload", {}).get("content", ""), "meta": h}
            for i, h in enumerate(hits)
        ]
        rerank_result = reranker.rerank(
            RerankRequest(query=req.query, passages=rerank_passages)
        )
        # Rebuild hits in reranked order
        reranked_hits = [p["meta"] for p in rerank_result]
        top_hits = reranked_hits[:req.top_k]
    except Exception as e:
        logger.warning(f"FlashRank reranking failed, falling back to score sort: {e}")
        hits.sort(key=lambda x: x.get("score", 0), reverse=True)
        filtered = [h for h in hits if h.get("score", 0) >= req.threshold]
        top_hits = filtered[:req.top_k]

    chunks = []
    for hit in top_hits:
        payload = hit.get("payload", {})
        chunks.append({
            "chunk_id": str(hit.get("id", "")),
            "file_id": payload.get("file_id", ""),
            "filename": payload.get("filename", ""),
            "page": payload.get("page", 0),
            "heading": payload.get("heading", ""),
            "content": payload.get("content", ""),
            "score": hit.get("score", 0),
        })

    return {"chunks": chunks, "no_evidence": False}


@app.get("/rag/file/{file_id}/chunks")
async def get_file_chunks(file_id: str):
    """
    Get all chunks for a specific file (for citation validation).
    Uses scroll pagination to handle files with >1000 chunks.
    Internal endpoint — called by LLM Service only.
    """
    all_points = []
    offset = None  # Qdrant scroll offset (None = start)

    while True:
        scroll_body = {
            "filter": {
                "must": [{"key": "file_id", "match": {"value": file_id}}]
            },
            "limit": 500,
            "with_payload": True,
        }
        if offset is not None:
            scroll_body["offset"] = offset

        result = await qdrant_request(
            "POST",
            f"/collections/{settings.QDRANT_COLLECTION}/points/scroll",
            scroll_body,
        )
        if not result or "result" not in result:
            break

        points = result["result"].get("points", [])
        all_points.extend(points)

        # Qdrant returns next_page_offset for pagination
        next_offset = result["result"].get("next_page_offset")
        if not next_offset or len(points) == 0:
            break  # No more pages
        offset = next_offset

    return {
        "chunks": [
            {
                "chunk_id": str(p.get("id", "")),
                "page": p.get("payload", {}).get("page", 0),
                "heading": p.get("payload", {}).get("heading", ""),
                "content": p.get("payload", {}).get("content", ""),
            }
            for p in all_points
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8003)
