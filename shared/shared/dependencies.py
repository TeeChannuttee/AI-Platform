"""
FastAPI dependencies: auth, DB session, role gate.
Every service uses get_current_user for defense-in-depth.
"""
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from jose import JWTError

from shared.db import get_db
from shared.jwt_utils import verify_token

bearer_scheme = HTTPBearer(auto_error=False)


class CurrentUser:
    """Lightweight user context extracted from JWT."""
    def __init__(self, payload: dict):
        self.user_id: str = payload.get("sub", "")
        self.tenant_id: str = payload.get("tid", "")
        self.role: str = payload.get("role", "user")
        self.scopes: list[str] = payload.get("scopes", [])
        self.jti: str = payload.get("jti", "")


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> CurrentUser:
    """
    Validate JWT from Authorization header.
    Used by every service for defense-in-depth.
    """
    if not credentials:
        # Also check X-User-* headers set by gateway (inter-service)
        user_id = request.headers.get("X-User-Id")
        tenant_id = request.headers.get("X-Tenant-Id")
        role = request.headers.get("X-User-Role", "user")
        if user_id and tenant_id:
            return CurrentUser({
                "sub": user_id,
                "tid": tenant_id,
                "role": role,
                "scopes": ["*"],
                "jti": "",
            })
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = verify_token(credentials.credentials)
        return CurrentUser(payload)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_role(*roles: str):
    """Dependency factory: restrict to specific roles."""
    async def _check(user: CurrentUser = Depends(get_current_user)):
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.role}' not authorized. Required: {roles}",
            )
        return user
    return _check


def require_scope(scope: str):
    """Dependency factory: restrict to specific scope."""
    async def _check(user: CurrentUser = Depends(get_current_user)):
        if "*" not in user.scopes and scope not in user.scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Scope '{scope}' not authorized",
            )
        return user
    return _check
