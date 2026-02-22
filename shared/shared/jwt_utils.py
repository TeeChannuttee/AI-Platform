"""
JWT token creation and verification.
Claims: sub, tid, role, scopes, iat, exp, iss, aud, jti
"""
import uuid
from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
from shared.config import get_settings

settings = get_settings()


def create_access_token(
    user_id: str,
    tenant_id: str,
    role: str = "user",
    scopes: list[str] | None = None,
    expires_delta: timedelta | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES))
    payload = {
        "sub": str(user_id),
        "tid": str(tenant_id),
        "role": role,
        "scopes": scopes or ["*"],
        "iat": now,
        "exp": expire,
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(
    user_id: str,
    family_id: str | None = None,
) -> tuple[str, str]:
    """Returns (token_string, family_id)."""
    fid = family_id or str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    expire = now + timedelta(days=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": str(user_id),
        "fid": fid,
        "type": "refresh",
        "iat": now,
        "exp": expire,
        "jti": str(uuid.uuid4()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return token, fid


def verify_token(token: str) -> dict:
    """Verify and decode a JWT token. Raises JWTError on failure."""
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
            audience=settings.JWT_AUDIENCE,
            issuer=settings.JWT_ISSUER,
        )
        return payload
    except JWTError:
        raise


def verify_refresh_token(token: str) -> dict:
    """Verify refresh token (no audience/issuer check)."""
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
            options={"verify_aud": False, "verify_iss": False},
        )
        if payload.get("type") != "refresh":
            raise JWTError("Not a refresh token")
        return payload
    except JWTError:
        raise
