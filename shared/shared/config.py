"""
Centralized configuration using Pydantic Settings.
All services import from here.
"""
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # ─── Database ───
    DATABASE_URL: str = "postgresql+asyncpg://platform:platform_secret@postgres:5432/ai_platform"
    DATABASE_URL_SYNC: str = "postgresql://platform:platform_secret@postgres:5432/ai_platform"

    # ─── Redis ───
    REDIS_URL: str = "redis://redis:6379/0"

    # ─── JWT ───
    JWT_SECRET_KEY: str = "CHANGE_ME_TO_RANDOM_64_CHARS"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    JWT_ISSUER: str = "ai-platform"
    JWT_AUDIENCE: str = "ai-platform-api"

    # ─── MinIO ───
    MINIO_ENDPOINT: str = "minio:9000"
    MINIO_EXTERNAL_ENDPOINT: str = ""  # For presigned URLs (browser-facing), e.g. "localhost:9000"
    MINIO_ACCESS_KEY: str = "minioadmin"
    MINIO_SECRET_KEY: str = "minioadmin"
    MINIO_BUCKET: str = "ai-platform-files"
    MINIO_USE_SSL: bool = False

    # ─── Qdrant ───
    QDRANT_URL: str = "http://qdrant:6333"
    QDRANT_COLLECTION: str = "documents"

    # ─── ClamAV ───
    CLAMAV_HOST: str = "clamav"
    CLAMAV_PORT: int = 3310

    # ─── OpenAI ───
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"

    # ─── Service URLs ───
    AUTH_SERVICE_URL: str = "http://auth_service:8001"
    FILE_SERVICE_URL: str = "http://file_service:8002"
    RAG_WORKER_URL: str = "http://rag_worker:8003"
    LLM_SERVICE_URL: str = "http://llm_service:8004"
    MONITORING_SERVICE_URL: str = "http://monitoring_service:8005"

    # ─── Embedding ───
    EMBEDDING_PROVIDER: str = "openai"              # "openai" or "local"
    EMBEDDING_MODEL: str = "text-embedding-3-small"  # OpenAI embedding model
    EMBEDDING_DIM: int = 1536

    # ─── Versioning (Auditability / Traceability) ───
    SYSTEM_VERSION: str = "1.0.0"
    PROMPT_VERSION: str = "v1.0"
    RAG_PIPELINE_VERSION: str = "v1.0"

    # ─── Security ───
    LOGIN_MAX_ATTEMPTS: int = 5
    LOGIN_LOCKOUT_MINUTES: int = 15
    API_KEY_GRACE_PERIOD_HOURS: int = 24
    INTERNAL_SERVICE_TOKEN: str = "CHANGE_ME_INTERNAL_SECRET"  # service-to-service auth
    WORKING_MEMORY_TTL_SECONDS: int = 7 * 86400  # 7 days (configurable)
    WORKING_MEMORY_MAX_MESSAGES: int = 20
    MEMORY_WRITE_RATE_LIMIT: int = 30  # max writes per minute per user

    # ─── Registration & Invites ───
    ALLOW_PUBLIC_SIGNUP: bool = False       # True = dev/test, False = prod (invite-only)
    INVITE_TOKEN_EXPIRE_HOURS: int = 72    # 3 days
    INVITE_RATE_LIMIT_PER_MINUTE: int = 5  # rate-limit verify/accept

    model_config = {"env_file": ".env", "extra": "ignore"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()
