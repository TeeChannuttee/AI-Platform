"""
File Service — Upload/Download/View with proxy upload, virus scan, ACL.
Port 8002.
"""
import uuid
import hashlib
import io
from datetime import datetime, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile, File as FastAPIFile, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from minio import Minio

from shared.config import get_settings
from shared.db import get_db, init_db
from shared.models import File, FileACL, EventLog
from shared.dependencies import get_current_user, CurrentUser
from shared.logging_utils import setup_logger, get_trace_id, set_trace_id

settings = get_settings()
logger = setup_logger("file_service", service_version=settings.SYSTEM_VERSION)

# Allowed MIME types
ALLOWED_MIMES = {
    "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain", "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "image/png", "image/jpeg", "image/jpg", "image/gif",
}
MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB

# MinIO client (internal — for server-side operations)
minio_client = Minio(
    settings.MINIO_ENDPOINT,
    access_key=settings.MINIO_ACCESS_KEY,
    secret_key=settings.MINIO_SECRET_KEY,
    secure=settings.MINIO_USE_SSL,
)




@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("File Service starting...")
    await init_db()
    # Ensure MinIO bucket
    try:
        if not minio_client.bucket_exists(settings.MINIO_BUCKET):
            minio_client.make_bucket(settings.MINIO_BUCKET)
            logger.info(f"Created MinIO bucket: {settings.MINIO_BUCKET}")
    except Exception as e:
        logger.warning(f"MinIO bucket check failed (will retry): {e}")
    yield
    logger.info("File Service shutting down...")


app = FastAPI(title="File Service", version=settings.SYSTEM_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


# ─── Schemas ───
class UploadInitRequest(BaseModel):
    filename: str
    mime_type: str
    size: int = 0

class UploadInitResponse(BaseModel):
    file_id: str
    upload_url: str
    storage_key: str

class FileResponse(BaseModel):
    id: str
    filename: str
    mime_type: str | None
    size: int
    status: str
    chunks_total: int
    chunks_processed: int
    created_at: str | None


# ─── Helpers ───
async def _log_event(db: AsyncSession, action: str, user_id=None, tenant_id=None,
                     resource_type=None, resource_id=None, status_str="success",
                     ip=None, ua=None, detail=None):
    db.add(EventLog(
        trace_id=get_trace_id(), tenant_id=tenant_id, user_id=user_id,
        action=action, resource_type=resource_type, resource_id=resource_id,
        status=status_str, ip=ip, user_agent=ua, detail=detail,
    ))


async def _check_file_permission(db: AsyncSession, file_id: uuid.UUID, user: CurrentUser) -> File:
    """Check that user owns the file or has ACL access."""
    result = await db.execute(select(File).where(File.id == file_id))
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    # Owner check
    if str(f.owner_id) == user.user_id:
        return f

    # Admin can access anything in same tenant
    if user.role == "admin" and str(f.tenant_id) == user.tenant_id:
        return f

    # ACL check
    acl_result = await db.execute(
        select(FileACL).where(
            and_(
                FileACL.file_id == file_id,
                FileACL.principal_id == user.user_id,
                FileACL.permission.in_(["read", "write", "admin"]),
            )
        )
    )
    if acl_result.scalar_one_or_none():
        return f

    raise HTTPException(status_code=403, detail="Access denied")


# ─── Endpoints ───

@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "file", "version": settings.SYSTEM_VERSION}


@app.post("/files/upload/init", response_model=UploadInitResponse)
async def upload_init(req: UploadInitRequest, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(get_current_user)):
    set_trace_id(str(uuid.uuid4()))

    # Validate MIME type
    if req.mime_type not in ALLOWED_MIMES:
        raise HTTPException(status_code=400, detail=f"File type not allowed: {req.mime_type}")

    # Validate size
    if req.size > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large. Max: {MAX_FILE_SIZE // (1024*1024)}MB")

    file_id = uuid.uuid4()
    storage_key = f"{user.tenant_id}/{user.user_id}/{file_id}/{req.filename}"

    # Create file record
    file_record = File(
        id=file_id,
        tenant_id=uuid.UUID(user.tenant_id),
        owner_id=uuid.UUID(user.user_id),
        filename=req.filename,
        mime_type=req.mime_type,
        size=req.size,
        storage_key=storage_key,
        status="uploading",  # awaiting client PUT to presigned URL
    )
    db.add(file_record)
    await db.flush()

    # Generate presigned upload URL (internal — for server-side upload)
    try:
        upload_url = minio_client.presigned_put_object(
            settings.MINIO_BUCKET,
            storage_key,
            expires=timedelta(hours=1),
        )
    except Exception as e:
        logger.error(f"Failed to generate presigned URL: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate upload URL")

    await _log_event(db, "upload_init", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "file", str(file_id), "success")

    return UploadInitResponse(
        file_id=str(file_id),
        upload_url=upload_url,
        storage_key=storage_key,
    )


@app.post("/files/upload/direct")
async def upload_direct(file: UploadFile = FastAPIFile(...),
                        db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)):
    """Direct multipart upload — file goes through this service to MinIO.
    Works in Docker without browser-to-MinIO direct access."""
    set_trace_id(str(uuid.uuid4()))

    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")

    mime = file.content_type or "application/octet-stream"
    if mime not in ALLOWED_MIMES:
        raise HTTPException(status_code=400, detail=f"File type not allowed: {mime}")

    # Read file content
    content = await file.read()
    size = len(content)

    if size > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large. Max: {MAX_FILE_SIZE // (1024*1024)}MB")

    file_id = uuid.uuid4()
    storage_key = f"{user.tenant_id}/{user.user_id}/{file_id}/{file.filename}"

    # Create file record
    file_record = File(
        id=file_id,
        tenant_id=uuid.UUID(user.tenant_id),
        owner_id=uuid.UUID(user.user_id),
        filename=file.filename,
        mime_type=mime,
        size=size,
        storage_key=storage_key,
        status="uploading",
    )
    db.add(file_record)
    await db.flush()

    # Upload to MinIO
    try:
        minio_client.put_object(
            settings.MINIO_BUCKET,
            storage_key,
            io.BytesIO(content),
            length=size,
            content_type=mime,
        )
    except Exception as e:
        logger.error(f"Failed to upload to MinIO: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file")

    # SHA-256
    sha = hashlib.sha256(content)
    file_record.sha256 = sha.hexdigest()

    # Virus scan
    file_record.status = "scanning"
    await db.flush()

    scan_result = await _virus_scan(file_record.storage_key)
    if scan_result == "INFECTED":
        file_record.status = "quarantined"
        try:
            minio_client.remove_object(settings.MINIO_BUCKET, file_record.storage_key)
        except Exception:
            pass
        await _log_event(db, "virus_detected", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                         "file", str(file_id), "failure", detail="Virus detected")
        await db.commit()
        raise HTTPException(status_code=400, detail="File quarantined: virus detected")

    # Queue RAG if document
    file_record.status = "processing" if mime in {
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain", "text/csv"
    } else "ready"
    await db.commit()

    # Queue RAG processing if applicable
    if file_record.status == "processing":
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{settings.RAG_WORKER_URL}/rag/ingest",
                    json={"file_id": str(file_id), "storage_key": storage_key,
                          "mime_type": mime},
                    headers={"Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"},
                )
        except Exception as e:
            logger.warning(f"Failed to queue RAG: {e}")

    await _log_event(db, "upload_direct", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "file", str(file_id), "success")

    return {
        "file_id": str(file_id),
        "filename": file.filename,
        "status": file_record.status,
        "size": size,
    }


@app.post("/files/upload/complete")
async def upload_complete(file_id: str, db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(get_current_user)):
    """Confirm upload, trigger virus scan, queue RAG if document."""
    set_trace_id(str(uuid.uuid4()))

    result = await db.execute(
        select(File).where(
            and_(File.id == uuid.UUID(file_id),
                 File.owner_id == uuid.UUID(user.user_id))
        )
    )
    file_record = result.scalar_one_or_none()
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")

    # Verify file exists in MinIO
    try:
        stat = minio_client.stat_object(settings.MINIO_BUCKET, file_record.storage_key)
        file_record.size = stat.size
    except Exception:
        raise HTTPException(status_code=400, detail="File not found in storage. Upload may have failed.")

    # Compute SHA-256
    try:
        response = minio_client.get_object(settings.MINIO_BUCKET, file_record.storage_key)
        sha = hashlib.sha256()
        for chunk in response.stream(8192):
            sha.update(chunk)
        file_record.sha256 = sha.hexdigest()
        response.close()
        response.release_conn()
    except Exception as e:
        logger.warning(f"SHA256 computation failed: {e}")

    # Virus scan (ClamAV via clamd)
    file_record.status = "scanning"
    await db.flush()

    scan_result = await _virus_scan(file_record.storage_key)
    if scan_result == "INFECTED":
        file_record.status = "quarantined"
        # Delete infected file from storage
        try:
            minio_client.remove_object(settings.MINIO_BUCKET, file_record.storage_key)
        except Exception:
            pass
        await _log_event(db, "virus_detected", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                         "file", file_id, "failure", detail="Virus detected")
        from shared.models import SecurityLog
        from shared.security import hash_token
        db.add(SecurityLog(
            trace_id=get_trace_id(), tenant_id=uuid.UUID(user.tenant_id),
            user_id=uuid.UUID(user.user_id), event_type="virus_detected",
            severity="CRITICAL", detail=f"File {file_id} quarantined",
        ))
        return {"file_id": file_id, "status": "quarantined", "message": "⚠️ Virus detected!"}

    file_record.status = "ready"  # clean, no RAG needed

    # If document type, trigger RAG ingestion
    doc_mimes = {"application/pdf",
                 "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 "text/plain", "text/csv"}
    if file_record.mime_type in doc_mimes:
        file_record.status = "processing"
        # Queue to RAG worker (async via HTTP)
        import httpx
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{settings.RAG_WORKER_URL}/rag/ingest",
                    json={
                        "file_id": str(file_record.id),
                        "storage_key": file_record.storage_key,
                        "mime_type": file_record.mime_type,
                    },
                )
        except Exception as e:
            logger.warning(f"RAG worker queue failed (will retry): {e}")

    await _log_event(db, "upload_complete", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "file", file_id, "success")

    return {"file_id": file_id, "status": file_record.status}


async def _virus_scan(storage_key: str) -> str:
    """Scan file for malware. Uses built-in EICAR/pattern detection + ClamAV if available."""
    try:
        # Download file from MinIO
        response = minio_client.get_object(settings.MINIO_BUCKET, storage_key)
        data = response.read()
        response.close()
        response.release_conn()

        # --- Built-in threat detection (always runs) ---
        # EICAR test string (standard antivirus test file)
        EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
        if EICAR in data:
            logger.warning(f"EICAR test file detected in {storage_key}")
            return "INFECTED"

        # Common malicious patterns
        MALICIOUS_PATTERNS = [
            b"<%@ Page Language",      # Web shell (ASP)
            b"<?php eval(",            # PHP backdoor
            b"<?php system(",          # PHP system exec
            b"powershell -enc",        # Encoded PowerShell
            b"cmd.exe /c ",            # Command injection
            b"/bin/sh -c",             # Shell injection
        ]
        for pattern in MALICIOUS_PATTERNS:
            if pattern in data:
                logger.warning(f"Malicious pattern detected in {storage_key}: {pattern[:20]}")
                return "INFECTED"

        # --- ClamAV scan (optional, if available) ---
        try:
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            sock.connect((settings.CLAMAV_HOST, settings.CLAMAV_PORT))
            sock.send(b"zINSTREAM\0")
            chunk_size = 2048
            for i in range(0, len(data), chunk_size):
                chunk = data[i:i + chunk_size]
                sock.send(len(chunk).to_bytes(4, "big") + chunk)
            sock.send(b"\x00\x00\x00\x00")
            result = sock.recv(4096).decode()
            sock.close()
            if "FOUND" in result:
                return "INFECTED"
        except Exception:
            pass  # ClamAV not available — built-in scan already ran

        return "CLEAN"
    except Exception as e:
        logger.warning(f"Virus scan failed (graceful pass): {e}")
        return "CLEAN"


@app.post("/files/upload/direct")
async def upload_direct(
    file: UploadFile = FastAPIFile(...),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """Direct upload with virus scan (alternative to presigned URL flow)."""
    set_trace_id(str(uuid.uuid4()))

    if file.content_type and file.content_type not in ALLOWED_MIMES:
        raise HTTPException(status_code=400, detail=f"File type not allowed: {file.content_type}")

    # Pre-check Content-Length header to reject oversized files early
    if file.size and file.size > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    # Read file content (streamed from client, buffered for scan + upload)
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    file_id = uuid.uuid4()
    storage_key = f"{user.tenant_id}/{user.user_id}/{file_id}/{file.filename}"

    # Upload to MinIO
    try:
        minio_client.put_object(
            settings.MINIO_BUCKET,
            storage_key,
            io.BytesIO(content),
            length=len(content),
            content_type=file.content_type or "application/octet-stream",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    sha = hashlib.sha256(content).hexdigest()

    file_record = File(
        id=file_id,
        tenant_id=uuid.UUID(user.tenant_id),
        owner_id=uuid.UUID(user.user_id),
        filename=file.filename or "unnamed",
        mime_type=file.content_type,
        size=len(content),
        storage_key=storage_key,
        sha256=sha,
        status="scanning",
    )
    db.add(file_record)
    await db.flush()

    # Virus scan (ClamAV) — same as presigned flow
    scan_result = await _virus_scan(storage_key)
    if scan_result == "INFECTED":
        file_record.status = "quarantined"
        try:
            minio_client.remove_object(settings.MINIO_BUCKET, storage_key)
        except Exception:
            pass
        await _log_event(db, "virus_detected", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                         "file", str(file_id), "failure", detail="Virus detected")
        from shared.models import SecurityLog
        db.add(SecurityLog(
            trace_id=get_trace_id(), tenant_id=uuid.UUID(user.tenant_id),
            user_id=uuid.UUID(user.user_id), event_type="virus_detected",
            severity="CRITICAL", detail=f"File {file_id} quarantined (direct upload)",
        ))
        return {"file_id": str(file_id), "status": "quarantined", "message": "⚠️ Virus detected!"}

    file_record.status = "ready"

    # If document type, queue RAG ingestion
    doc_mimes = {"application/pdf",
                 "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 "text/plain", "text/csv"}
    if file.content_type in doc_mimes:
        file_record.status = "processing"
        import httpx
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{settings.RAG_WORKER_URL}/rag/ingest",
                    json={
                        "file_id": str(file_id),
                        "storage_key": storage_key,
                        "mime_type": file.content_type,
                    },
                )
        except Exception as e:
            logger.warning(f"RAG worker queue failed: {e}")

    await _log_event(db, "upload_direct", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "file", str(file_id), "success")

    return {"file_id": str(file_id), "status": file_record.status, "filename": file_record.filename}


@app.get("/files/{file_id}")
async def get_file_detail(file_id: str, db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(get_current_user)):
    """Get single file metadata."""
    f = await _check_file_permission(db, uuid.UUID(file_id), user)
    return {
        "id": str(f.id),
        "filename": f.filename,
        "mime_type": f.mime_type,
        "size": f.size,
        "status": f.status,
        "chunks_total": f.chunks_total,
        "chunks_processed": f.chunks_processed,
        "created_at": f.created_at.isoformat() + "+00:00" if f.created_at else None,
    }

@app.get("/files/{file_id}/status")
async def file_status(file_id: str, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(get_current_user)):
    f = await _check_file_permission(db, uuid.UUID(file_id), user)
    return {
        "file_id": str(f.id), "status": f.status,
        "chunks_total": f.chunks_total, "chunks_processed": f.chunks_processed,
    }


@app.get("/files")
async def list_files(
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
    status_filter: str | None = Query(None, alias="status"),
):
    query = select(File).where(
        and_(
            File.tenant_id == uuid.UUID(user.tenant_id),
            File.owner_id == uuid.UUID(user.user_id),
            File.status != "deleted",  # Hide soft-deleted files
        )
    )
    if status_filter:
        query = query.where(File.status == status_filter)

    query = query.order_by(File.created_at.desc())
    result = await db.execute(query)
    files = result.scalars().all()

    return [
        {
            "id": str(f.id),
            "filename": f.filename,
            "mime_type": f.mime_type,
            "size": f.size,
            "status": f.status,
            "chunks_total": f.chunks_total,
            "chunks_processed": f.chunks_processed,
            "created_at": f.created_at.isoformat() if f.created_at else None,
        }
        for f in files
    ]


@app.get("/files/{file_id}/view")
async def view_file_content(file_id: str, token: str = Query(None),
                    request: Request = None,
                    db: AsyncSession = Depends(get_db)):
    """Stream file content directly through the service.
    Accepts auth via query param (?token=) for iframe/img src, or via Authorization header."""
    set_trace_id(str(uuid.uuid4()))

    # Get auth token from query param or header
    auth_token = token
    if not auth_token and request:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            auth_token = auth_header[7:]
        # Also check x-auth-token from gateway
        if not auth_token:
            auth_token = request.headers.get("x-auth-token", "")

    if not auth_token:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Validate the token
    from shared.jwt_utils import verify_token
    from jose import JWTError
    try:
        payload = verify_token(auth_token)
        user = CurrentUser(payload)
    except (JWTError, Exception):
        raise HTTPException(status_code=401, detail="Invalid token")

    f = await _check_file_permission(db, uuid.UUID(file_id), user)

    # Status guard — only serve viewable files
    if f.status == "quarantined":
        raise HTTPException(status_code=403, detail="File quarantined due to virus detection")
    if f.status in ("scanning", "uploading"):
        raise HTTPException(status_code=409, detail="File is still being processed")
    if f.status == "deleted":
        raise HTTPException(status_code=410, detail="File has been deleted")

    try:
        response = minio_client.get_object(settings.MINIO_BUCKET, f.storage_key)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve file: {e}")

    await _log_event(db, "file_view", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "file", file_id, "success")

    def iter_content():
        try:
            for chunk in response.stream(8192):
                yield chunk
        finally:
            response.close()
            response.release_conn()

    return StreamingResponse(
        iter_content(),
        media_type=f.mime_type,
        headers={
            "Content-Disposition": f'inline; filename="{f.filename}"',
            "Content-Length": str(f.size) if f.size else "",
        },
    )


@app.delete("/files/{file_id}")
async def delete_file(file_id: str, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(get_current_user)):
    """Soft delete file + audit log."""
    set_trace_id(str(uuid.uuid4()))
    f = await _check_file_permission(db, uuid.UUID(file_id), user)

    f.status = "deleted"
    await _log_event(db, "file_delete", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "file", file_id, "success")

    return {"file_id": file_id, "status": "deleted"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
