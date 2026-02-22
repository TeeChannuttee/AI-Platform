"""
Redis async client singleton.
"""
import redis.asyncio as aioredis
from shared.config import get_settings

settings = get_settings()

redis_client = aioredis.from_url(
    settings.REDIS_URL,
    encoding="utf-8",
    decode_responses=True,
    max_connections=50,
)


async def get_redis() -> aioredis.Redis:
    """FastAPI dependency: returns Redis client."""
    return redis_client
