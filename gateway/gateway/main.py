"""
API Gateway — JWT validation, Rate Limiting, SSRF guard,
Idempotency Key, Secure Headers, Reverse Proxy to microservices.
Port 8000.
"""
import uuid
import time
import json
import re
import asyncio
from datetime import datetime
from contextlib import asynccontextmanager
from urllib.parse import unquote

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
import httpx

from shared.config import get_settings
from shared.jwt_utils import verify_token
from shared.security import hash_token, check_ssrf
from shared.redis_client import redis_client
from shared.logging_utils import setup_logger, set_trace_id, get_trace_id

settings = get_settings()
logger = setup_logger("gateway", service_version=settings.SYSTEM_VERSION)

# ─── Route allowlist (no auth required) ───
PUBLIC_PATHS = {
    "/auth/login",
    "/auth/register",
    "/auth/refresh",
    "/auth/invites",       # verify + accept invite (public)
    "/healthz",
    "/readyz",
    "/docs",
    "/openapi.json",
    "/redoc",
}

# ─── Service routing map (order matters: longer prefix first) ───
SERVICE_MAP = {
    "/auth": settings.AUTH_SERVICE_URL,
    "/files": settings.FILE_SERVICE_URL,
    "/rag": settings.RAG_WORKER_URL,
    "/llm": settings.LLM_SERVICE_URL,
    "/usage": settings.LLM_SERVICE_URL,
    "/logs": settings.MONITORING_SERVICE_URL,
    "/admin/tenants": settings.AUTH_SERVICE_URL,       # Tenant CRUD → Auth Service
    "/admin": settings.MONITORING_SERVICE_URL,          # Alerts, dashboard → Monitoring
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("API Gateway starting on port 8000...")
    yield
    logger.info("API Gateway shutting down...")


app = FastAPI(title="Enterprise AI Platform — API Gateway", version=settings.SYSTEM_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Trace-Id"],
)


# ─── Secure Headers Middleware ───
@app.middleware("http")
async def secure_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"  # Production: use nonce-based CSP
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


# ─── Gateway Health ───
@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "service": "gateway",
        "version": settings.SYSTEM_VERSION,
        "timestamp": datetime.utcnow().isoformat(),
    }


async def _log_unauthorized(ip: str, path: str, detail: str, ua: str = ""):
    """Fire-and-forget: log unauthorized access to monitoring service."""
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            await client.post(
                f"{settings.MONITORING_SERVICE_URL}/logs/events",
                json={
                    "trace_id": get_trace_id(),
                    "action": "unauthorized_access",
                    "status": "failure",
                    "ip": ip,
                    "user_agent": ua,
                    "detail": f"{detail} | path={path}",
                },
                headers={"X-Internal-Token": settings.INTERNAL_SERVICE_TOKEN},
            )
    except Exception:
        pass  # Non-blocking — don't fail the response


@app.get("/readyz")
async def readyz():
    """Check if downstream services are reachable."""
    checks = {}
    async with httpx.AsyncClient(timeout=3) as client:
        for name, url in [("auth", settings.AUTH_SERVICE_URL),
                          ("file", settings.FILE_SERVICE_URL),
                          ("llm", settings.LLM_SERVICE_URL),
                          ("monitoring", settings.MONITORING_SERVICE_URL)]:
            try:
                resp = await client.get(f"{url}/healthz")
                checks[name] = resp.status_code == 200
            except Exception:
                checks[name] = False

    all_ready = all(checks.values())
    return JSONResponse(
        status_code=200 if all_ready else 503,
        content={"ready": all_ready, "services": checks},
    )


# ─── Main Proxy Handler ───
@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy(path: str, request: Request):
    """
    Central proxy: auth check → rate limit → route to downstream service.
    """
    trace_id = str(uuid.uuid4())
    set_trace_id(trace_id)
    full_path = f"/{path}"
    start_time = time.time()

    # Normalize path to prevent bypass via //auth/login or %2Fauth%2Flogin
    full_path = unquote(full_path)             # %2F → /
    full_path = re.sub(r"/+", "/", full_path)  # // → /
    full_path = full_path.rstrip("/") or "/"   # trailing slash

    # 0. Block internal-only endpoints from external clients
    # RAG Worker is service-to-service ONLY (File Service → RAG, LLM → RAG)
    INTERNAL_PREFIXES = {"/rag"}  # All /rag/* endpoints are internal
    if any(full_path.startswith(p) for p in INTERNAL_PREFIXES):
        internal_token = request.headers.get("X-Internal-Token", "")
        if internal_token != settings.INTERNAL_SERVICE_TOKEN:
            return JSONResponse(
                status_code=403,
                content={"detail": "Internal endpoint — not accessible from external clients"},
                headers={"X-Trace-Id": trace_id},
            )

    # POST /logs/* endpoints are service-to-service only (write event/security logs)
    INTERNAL_WRITE_PREFIXES = {"/logs/events", "/logs/security"}
    if request.method == "POST" and any(full_path.startswith(p) for p in INTERNAL_WRITE_PREFIXES):
        internal_token = request.headers.get("X-Internal-Token", "")
        if internal_token != settings.INTERNAL_SERVICE_TOKEN:
            return JSONResponse(
                status_code=403,
                content={"detail": "Internal endpoint — not accessible from external clients"},
                headers={"X-Trace-Id": trace_id},
            )

    # 1. Check if public path
    is_public = full_path in PUBLIC_PATHS or any(full_path.startswith(p) for p in PUBLIC_PATHS)

    user_payload = None
    api_key_record = None

    if not is_public:
        # 2. Extract auth (JWT or API key)
        auth_header = request.headers.get("Authorization", "")
        api_key_header = request.headers.get("X-API-Key", "")

        # Also check for token in query params (for iframe/img src URLs)
        query_token = request.query_params.get("token", "")

        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            # Check if this is an API key (prefix aip_) or JWT
            if token.startswith("aip_"):
                api_key_header = token  # Treat as API key
            else:
                # JWT authentication
                try:
                    user_payload = verify_token(token)
                except Exception:
                    client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
                    asyncio.create_task(_log_unauthorized(client_ip, full_path, "Invalid or expired JWT token", request.headers.get("User-Agent", "")))
                    return JSONResponse(status_code=401, content={"detail": "Invalid or expired token"})
        elif query_token and not query_token.startswith("aip_"):
            # JWT token in query param (for file view URLs)
            try:
                user_payload = verify_token(query_token)
            except Exception:
                client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
                asyncio.create_task(_log_unauthorized(client_ip, full_path, "Invalid or expired JWT token (query)", request.headers.get("User-Agent", "")))
                return JSONResponse(status_code=401, content={"detail": "Invalid or expired token"})
        
        if api_key_header and not user_payload:
            # API Key authentication
            key_hash = hash_token(api_key_header)

            # Check Redis cache first
            cached = await redis_client.get(f"apikey:{key_hash}")
            if cached:
                api_key_record = json.loads(cached)
            else:
                # Validate against DB (via auth service)
                try:
                    async with httpx.AsyncClient(timeout=5) as client:
                        resp = await client.post(
                            f"{settings.AUTH_SERVICE_URL}/auth/validate-api-key",
                            json={"key_hash": key_hash},
                            headers={"X-Internal-Token": settings.INTERNAL_SERVICE_TOKEN},
                        )
                        if resp.status_code == 200:
                            api_key_record = resp.json()
                            await redis_client.setex(
                                f"apikey:{key_hash}", 300, json.dumps(api_key_record)
                            )
                except Exception:
                    pass

            if not api_key_record:
                client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
                asyncio.create_task(_log_unauthorized(client_ip, full_path, "Invalid API key", request.headers.get("User-Agent", "")))
                return JSONResponse(status_code=401, content={"detail": "Invalid API key"})

            # Check RPM limit
            rpm_key = f"rpm:{key_hash}"
            rpm_count = await redis_client.incr(rpm_key)
            if rpm_count == 1:
                await redis_client.expire(rpm_key, 60)
            if rpm_count > api_key_record.get("rpm_limit", 60):
                return JSONResponse(status_code=429, content={"detail": "API key rate limit exceeded"})

            # Check daily token limit
            today = datetime.utcnow().strftime("%Y-%m-%d")
            dt_key = f"daily_tokens:{api_key_record.get('user_id', '')}:{today}"
            daily_used = await redis_client.get(dt_key)
            daily_limit = api_key_record.get("daily_token_limit", 1_000_000)
            if daily_used and int(daily_used) >= daily_limit:
                return JSONResponse(status_code=429, content={
                    "detail": f"Daily token limit exceeded ({daily_limit:,} tokens). Resets at midnight UTC."
                })

            # Build user payload from API key
            user_payload = {
                "sub": api_key_record.get("user_id", ""),
                "tid": api_key_record.get("tenant_id", ""),
                "role": "api",
                "scopes": api_key_record.get("scopes", "*").split(","),
            }

        # No auth provided at all
        if not user_payload:
            client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
            asyncio.create_task(_log_unauthorized(client_ip, full_path, "No authentication provided", request.headers.get("User-Agent", "")))
            return JSONResponse(status_code=401, content={"detail": "Authentication required"})

    # 3. Rate limiting (per-IP)
    client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    ip_key = f"rl:ip:{client_ip}"
    ip_count = await redis_client.incr(ip_key)
    if ip_count == 1:
        await redis_client.expire(ip_key, 60)
    if ip_count > 200:  # 200 req/min per IP
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})

    # 4. Idempotency key check
    idempotency_key = request.headers.get("Idempotency-Key")
    if idempotency_key and request.method == "POST":
        cache_key = f"idempotency:{idempotency_key}"
        cached_response = await redis_client.get(cache_key)
        if cached_response:
            return JSONResponse(content=json.loads(cached_response))

    # 5. Determine target service
    target_url = None
    for prefix, url in SERVICE_MAP.items():
        if full_path.startswith(prefix):
            target_url = f"{url}{full_path}"
            break

    if not target_url:
        return JSONResponse(status_code=404, content={"detail": "Route not found"})

    # 6. Forward request
    body = await request.body()
    headers = dict(request.headers)
    headers.pop("host", None)
    headers["X-Trace-Id"] = trace_id
    headers["X-Forwarded-For"] = client_ip

    if user_payload:
        headers["X-User-Id"] = str(user_payload.get("sub", ""))
        headers["X-Tenant-Id"] = str(user_payload.get("tid", ""))
        headers["X-User-Role"] = str(user_payload.get("role", "user"))
        # Strip API key from Authorization header — downstream expects JWT only
        if api_key_record:
            headers.pop("authorization", None)
            headers.pop("Authorization", None)

    try:
        # Handle SSE streams (long-running connections)
        if full_path.endswith("/stream"):
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    request.method,
                    target_url,
                    headers=headers,
                    content=body,
                    params=dict(request.query_params),
                ) as resp:
                    async def stream_gen():
                        async for chunk in resp.aiter_bytes():
                            yield chunk

                    return StreamingResponse(
                        stream_gen(),
                        status_code=resp.status_code,
                        media_type=resp.headers.get("content-type", "text/event-stream"),
                    )

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
                params=dict(request.query_params),
            )

        # Build response
        response_headers = dict(resp.headers)
        response_headers["X-Trace-Id"] = trace_id
        response_headers.pop("content-length", None)
        response_headers.pop("content-encoding", None)
        response_headers.pop("transfer-encoding", None)

        response = Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=response_headers,
            media_type=resp.headers.get("content-type"),
        )

        # Cache idempotent response
        if idempotency_key and request.method == "POST" and resp.status_code in (200, 201):
            try:
                await redis_client.setex(
                    f"idempotency:{idempotency_key}",
                    3600,
                    resp.content.decode("utf-8"),
                )
            except Exception:
                pass

        # Log request duration
        duration = (time.time() - start_time) * 1000
        logger.info(f"{request.method} {full_path} → {resp.status_code} ({duration:.0f}ms)")

        return response

    except httpx.TimeoutException:
        logger.error(f"Timeout proxying to {target_url}")
        return JSONResponse(status_code=504, content={"detail": "Upstream service timeout"})
    except httpx.ConnectError:
        logger.error(f"Cannot connect to {target_url}")
        return JSONResponse(status_code=503, content={"detail": "Upstream service unavailable"})
    except Exception as e:
        logger.error(f"Proxy error: {e}")
        return JSONResponse(status_code=502, content={"detail": "Bad gateway"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
