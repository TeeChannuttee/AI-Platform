"""
Auth Service — Login, Refresh, Logout, Change Password, API Key Rotation.
Port 8001.
"""
import uuid
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, update, and_, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from shared.config import get_settings
from shared.db import get_db, init_db
from shared.models import User, UserRole, Session, APIKey, EventLog, SecurityLog, Tenant, Invitation
from shared.jwt_utils import create_access_token, create_refresh_token, verify_refresh_token
from shared.security import hash_password, verify_password, needs_rehash, hash_token, generate_api_key, generate_invite_token
from shared.dependencies import get_current_user, require_role, CurrentUser
from shared.redis_client import redis_client
from shared.logging_utils import setup_logger, get_trace_id, set_trace_id

settings = get_settings()
logger = setup_logger("auth_service", service_version=settings.SYSTEM_VERSION)


# ─── Lifespan ───
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Auth Service starting...")
    await init_db()
    # Seed default tenant + admin user if not exists
    from shared.db import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.email == "admin@platform.local"))
        if not result.scalar_one_or_none():
            # Create default tenant
            default_tenant = Tenant(
                name="Platform Admin",
                slug="platform",
                max_users=100,
            )
            db.add(default_tenant)
            await db.flush()

            admin = User(
                email="admin@platform.local",
                password_hash=hash_password("Admin@123456"),
                full_name="Platform Admin",
                status="active",
                tenant_id=default_tenant.id,
            )
            db.add(admin)
            await db.flush()
            default_tenant.created_by = admin.id
            db.add(UserRole(user_id=admin.id, role="admin"))
            await db.commit()
            logger.info("Seeded default tenant + admin user: admin@platform.local / Admin@123456")
    yield
    logger.info("Auth Service shutting down...")


app = FastAPI(title="Auth Service", version=settings.SYSTEM_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Schemas ───
class LoginRequest(BaseModel):
    email: str
    password: str

class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: dict

class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str

class RegisterRequest(BaseModel):
    email: str
    password: str
    full_name: str = ""

class CreateAPIKeyRequest(BaseModel):
    name: str = "Default Key"
    scopes: str = "*"
    rpm_limit: int = 60
    daily_token_limit: int = 1_000_000


# ─── Helpers ───
async def _log_event(db: AsyncSession, action: str, user_id=None, tenant_id=None,
                     resource_type=None, resource_id=None, status_str="success",
                     ip=None, ua=None, detail=None):
    log = EventLog(
        trace_id=get_trace_id(),
        tenant_id=tenant_id,
        user_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        status=status_str,
        ip=ip,
        user_agent=ua,
        detail=detail,
    )
    db.add(log)
    await db.commit()


async def _log_security(db: AsyncSession, event_type: str, severity: str,
                        user_id=None, tenant_id=None, ip=None, ua=None, detail=None):
    import hashlib
    # Content-based hash chaining (tamper-evident)
    last = await db.execute(
        select(SecurityLog).order_by(SecurityLog.timestamp.desc()).limit(1)
    )
    last_record = last.scalar_one_or_none()
    if last_record:
        # Hash the previous record's content + its own prev_hash
        chain_data = f"{last_record.event_type}|{last_record.severity}|{last_record.detail or ''}|{last_record.prev_hash or ''}"
        prev_hash = hashlib.sha256(chain_data.encode()).hexdigest()
    else:
        prev_hash = "genesis"

    log = SecurityLog(
        trace_id=get_trace_id(),
        tenant_id=tenant_id,
        user_id=user_id,
        event_type=event_type,
        severity=severity,
        detail=detail,
        ip=ip,
        user_agent=ua,
        prev_hash=prev_hash,
    )
    db.add(log)
    await db.commit()


async def _check_lockout(user: User) -> bool:
    """Returns True if user is currently locked out."""
    if user.status == "locked" and user.locked_until:
        if datetime.utcnow() < user.locked_until:
            return True
        # Lockout expired — reset
        user.status = "active"
        user.failed_login_attempts = 0
        user.locked_until = None
    return False


async def _check_rate_limit(ip: str, user_email: str) -> bool:
    """Returns True if rate limited. Uses Redis sliding window."""
    ip_key = f"login_rl:ip:{ip}"
    user_key = f"login_rl:user:{user_email}"

    pipe = redis_client.pipeline()
    pipe.incr(ip_key)
    pipe.expire(ip_key, 300)  # 5 min window
    pipe.incr(user_key)
    pipe.expire(user_key, 300)
    results = await pipe.execute()

    ip_count = results[0]
    user_count = results[2]

    # 10 per IP per 5 min, 5 per user per 5 min
    return ip_count > 10 or user_count > 5


# ─── Endpoints ───

@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "auth", "version": settings.SYSTEM_VERSION}


@app.post("/auth/register", response_model=LoginResponse)
async def register(req: RegisterRequest, request: Request, response: Response,
                   db: AsyncSession = Depends(get_db)):
    """Public registration — guarded by ALLOW_PUBLIC_SIGNUP flag.
    In production, use POST /auth/invites/{token}/accept instead."""
    if not settings.ALLOW_PUBLIC_SIGNUP:
        raise HTTPException(
            status_code=403,
            detail="Public registration is disabled. Please use an invite link.",
        )

    set_trace_id(str(uuid.uuid4()))
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    ua = request.headers.get("User-Agent", "")

    # Check if user exists
    existing = await db.execute(select(User).where(User.email == req.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    # Create user (dev mode — no tenant)
    user = User(
        email=req.email,
        password_hash=hash_password(req.password),
        full_name=req.full_name,
        status="active",
        tenant_id=None,
    )
    db.add(user)
    await db.flush()

    # Default role
    db.add(UserRole(user_id=user.id, role="user"))

    # Create session
    role = "user"
    access_token = create_access_token(str(user.id), "", role)
    refresh_tok, family_id = create_refresh_token(str(user.id))

    session = Session(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_tok),
        family_id=uuid.UUID(family_id),
        ip=ip,
        user_agent=ua,
    )
    db.add(session)
    await _log_event(db, "register_dev", user.id, None, "user", str(user.id), ip=ip, ua=ua)

    response.set_cookie(
        key="refresh_token",
        value=refresh_tok,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/auth",
    )

    return LoginResponse(
        access_token=access_token,
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user={
            "id": str(user.id),
            "email": user.email,
            "full_name": user.full_name,
            "role": role,
            "tenant_id": "",
        },
    )


# ═══════════════════════════════════════════════════════════════
# ADMIN — TENANT MANAGEMENT
# ═══════════════════════════════════════════════════════════════

class CreateTenantRequest(BaseModel):
    name: str
    slug: str
    max_users: int = 50


@app.post("/admin/tenants")
async def create_tenant(req: CreateTenantRequest, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_role("admin"))):
    """Admin-only: Create a new tenant / organization."""
    set_trace_id(str(uuid.uuid4()))

    # Check slug uniqueness
    existing = await db.execute(select(Tenant).where(Tenant.slug == req.slug))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Tenant slug already exists")

    tenant = Tenant(
        name=req.name,
        slug=req.slug,
        max_users=req.max_users,
        created_by=uuid.UUID(user.user_id),
    )
    db.add(tenant)
    await db.flush()

    await _log_event(db, "tenant_created", uuid.UUID(user.user_id), tenant.id,
                     "tenant", str(tenant.id), "success",
                     detail=f"Tenant '{req.name}' (slug={req.slug})")

    return {
        "id": str(tenant.id),
        "name": tenant.name,
        "slug": tenant.slug,
        "max_users": tenant.max_users,
        "status": tenant.status,
    }


@app.get("/admin/tenants")
async def list_tenants(db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(require_role("admin"))):
    """Admin-only: List all tenants."""
    result = await db.execute(select(Tenant).order_by(Tenant.created_at.desc()))
    tenants = result.scalars().all()
    return [
        {
            "id": str(t.id),
            "name": t.name,
            "slug": t.slug,
            "status": t.status,
            "max_users": t.max_users,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in tenants
    ]


# ═══════════════════════════════════════════════════════════════
# INVITE MANAGEMENT
# ═══════════════════════════════════════════════════════════════

class CreateInviteRequest(BaseModel):
    tenant_id: str | None = None  # optional: defaults to admin's own tenant
    email: str | None = None      # optional: lock invite to this email
    role: str = "user"            # role to assign on accept

class AcceptInviteRequest(BaseModel):
    email: str
    password: str
    full_name: str = ""


@app.post("/auth/invites")
async def create_invite(req: CreateInviteRequest, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_role("admin"))):
    """Admin-only: Create an invite token for a tenant.
    Token is revealed ONCE — only hash is stored."""
    set_trace_id(str(uuid.uuid4()))

    # Validate tenant — use admin's own tenant if not specified
    tid = req.tenant_id or user.tenant_id
    tenant_result = await db.execute(
        select(Tenant).where(Tenant.id == uuid.UUID(tid))
    )
    tenant = tenant_result.scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if tenant.status != "active":
        raise HTTPException(status_code=400, detail="Tenant is not active")

    # Check license cap
    user_count = await db.execute(
        select(func.count()).select_from(User).where(User.tenant_id == tenant.id)
    )
    current_users = user_count.scalar() or 0
    pending_count = await db.execute(
        select(func.count()).select_from(Invitation).where(
            and_(Invitation.tenant_id == tenant.id, Invitation.status == "PENDING")
        )
    )
    pending = pending_count.scalar() or 0
    if current_users + pending >= tenant.max_users:
        raise HTTPException(status_code=400, detail=f"Tenant user limit reached ({tenant.max_users})")

    # Generate token (one-time reveal)
    plaintext_token, token_hash = generate_invite_token()

    invite = Invitation(
        tenant_id=tenant.id,
        email=req.email.lower().strip() if req.email else None,
        role=req.role,
        token_hash=token_hash,
        expires_at=datetime.utcnow() + timedelta(hours=settings.INVITE_TOKEN_EXPIRE_HOURS),
        created_by=uuid.UUID(user.user_id),
    )
    db.add(invite)
    await db.flush()

    await _log_event(db, "invite_created", uuid.UUID(user.user_id), tenant.id,
                     "invitation", str(invite.id), "success",
                     detail=f"Invite for {req.email or 'any email'} as {req.role}")

    return {
        "id": str(invite.id),
        "tenant_id": str(tenant.id),
        "tenant_name": tenant.name,
        "email": invite.email,
        "role": invite.role,
        "token": plaintext_token,  # ⚠️ Shown ONCE only
        "expires_at": invite.expires_at.isoformat(),
        "message": "⚠️ Save this invite token now. It will NOT be shown again.",
    }


@app.get("/auth/invites/{token}")
async def verify_invite(token: str, request: Request,
                        db: AsyncSession = Depends(get_db)):
    """Public: Verify an invite token (rate-limited)."""
    # Rate limit
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    rl_key = f"invite_rl:{ip}"
    count = await redis_client.incr(rl_key)
    await redis_client.expire(rl_key, 60)
    if count > settings.INVITE_RATE_LIMIT_PER_MINUTE:
        raise HTTPException(status_code=429, detail="Too many requests")

    token_hash = hash_token(token)
    result = await db.execute(
        select(Invitation).where(Invitation.token_hash == token_hash)
    )
    invite = result.scalar_one_or_none()

    if not invite:
        raise HTTPException(status_code=404, detail="Invalid invite token")

    # Check expiry
    if invite.expires_at < datetime.utcnow():
        if invite.status == "PENDING":
            invite.status = "EXPIRED"
        raise HTTPException(status_code=410, detail="Invite has expired")

    if invite.status != "PENDING":
        raise HTTPException(status_code=409, detail=f"Invite is {invite.status}")

    # Get tenant name
    tenant_result = await db.execute(select(Tenant).where(Tenant.id == invite.tenant_id))
    tenant = tenant_result.scalar_one_or_none()

    return {
        "valid": True,
        "email": invite.email,  # None if any-email invite
        "tenant_name": tenant.name if tenant else "Unknown",
        "role": invite.role,
        "expires_at": invite.expires_at.isoformat(),
    }


@app.post("/auth/invites/{token}/accept", response_model=LoginResponse)
async def accept_invite(token: str, req: AcceptInviteRequest,
                        request: Request, response: Response,
                        db: AsyncSession = Depends(get_db)):
    """Accept an invite = Enterprise Registration.
    Creates user with invite's tenant_id and role."""
    set_trace_id(str(uuid.uuid4()))
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    ua = request.headers.get("User-Agent", "")

    # Rate limit
    rl_key = f"invite_rl:{ip}"
    count = await redis_client.incr(rl_key)
    await redis_client.expire(rl_key, 60)
    if count > settings.INVITE_RATE_LIMIT_PER_MINUTE:
        raise HTTPException(status_code=429, detail="Too many requests")

    # 1. Lookup invite by token hash
    token_hash = hash_token(token)
    result = await db.execute(
        select(Invitation).where(Invitation.token_hash == token_hash)
    )
    invite = result.scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404, detail="Invalid invite token")

    # 2. Status check
    if invite.status != "PENDING":
        raise HTTPException(status_code=409, detail=f"Invite is already {invite.status}")

    # 3. Expiry check
    if invite.expires_at < datetime.utcnow():
        invite.status = "EXPIRED"
        raise HTTPException(status_code=410, detail="Invite has expired")

    # 4. Email match (if invite is locked to specific email)
    email = req.email.lower().strip()
    if invite.email and invite.email != email:
        await _log_security(db, "invite_email_mismatch", "HIGH", ip=ip, ua=ua,
                            detail=f"Expected {invite.email}, got {email}")
        raise HTTPException(status_code=400, detail="Email does not match the invite")

    # 5. Check email not already registered
    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    # 6. Create user with invite's tenant_id ✅
    user = User(
        email=email,
        password_hash=hash_password(req.password),
        full_name=req.full_name,
        status="active",
        tenant_id=invite.tenant_id,  # ✅ From invite — not auto-generated
    )
    db.add(user)
    await db.flush()

    # 7. Assign role from invite
    db.add(UserRole(user_id=user.id, role=invite.role))

    # 8. Mark invite as USED
    invite.status = "USED"
    invite.used_at = datetime.utcnow()
    invite.used_by_user_id = user.id

    # 9. Create session + tokens
    role = invite.role
    access_token = create_access_token(str(user.id), str(invite.tenant_id), role)
    refresh_tok, family_id = create_refresh_token(str(user.id))

    session = Session(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_tok),
        family_id=uuid.UUID(family_id),
        ip=ip,
        user_agent=ua,
    )
    db.add(session)

    # 10. Audit logs
    await _log_event(db, "invite_accepted", user.id, invite.tenant_id,
                     "invitation", str(invite.id), "success", ip=ip, ua=ua,
                     detail=f"User joined tenant via invite {str(invite.id)}")
    await _log_security(db, "invite_accept", "MED", user.id, invite.tenant_id,
                        ip=ip, ua=ua,
                        detail=f"New user {email} joined as {role}")

    response.set_cookie(
        key="refresh_token",
        value=refresh_tok,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/auth",
    )

    return LoginResponse(
        access_token=access_token,
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user={
            "id": str(user.id),
            "email": user.email,
            "full_name": user.full_name,
            "role": role,
            "tenant_id": str(invite.tenant_id),
        },
    )


@app.post("/auth/invites/{invite_id}/revoke")
async def revoke_invite(invite_id: str, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_role("admin"))):
    """Admin-only: Revoke a pending invite."""
    set_trace_id(str(uuid.uuid4()))

    result = await db.execute(
        select(Invitation).where(Invitation.id == uuid.UUID(invite_id))
    )
    invite = result.scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    if invite.status != "PENDING":
        raise HTTPException(status_code=409, detail=f"Cannot revoke, invite is {invite.status}")

    invite.status = "REVOKED"

    await _log_security(db, "invite_revoked", "MED", uuid.UUID(user.user_id),
                        invite.tenant_id,
                        detail=f"Revoked invite {invite_id}")

    return {"message": "Invite revoked", "id": invite_id}


@app.post("/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest, request: Request, response: Response,
                db: AsyncSession = Depends(get_db)):
    set_trace_id(str(uuid.uuid4()))
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    ua = request.headers.get("User-Agent", "")

    # Rate limit check
    if await _check_rate_limit(ip, req.email):
        await _log_security(db, "rate_limit_exceeded", "MED", ip=ip, ua=ua,
                            detail=f"Login rate limit for {req.email}")
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")

    # Find user
    result = await db.execute(select(User).where(User.email == req.email))
    user = result.scalar_one_or_none()
    if not user:
        await _log_security(db, "login_failure", "LOW", ip=ip, ua=ua,
                            detail=f"Unknown email: {req.email}")
        await _log_event(db, "login_failed", status_str="failure", ip=ip, ua=ua,
                         detail=f"Unknown email: {req.email}")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Lockout check
    if await _check_lockout(user):
        remaining = (user.locked_until - datetime.utcnow()).seconds if user.locked_until else 0
        await _log_security(db, "lockout_active", "HIGH", user.id, user.tenant_id, ip, ua,
                            f"Account locked. {remaining}s remaining.")
        raise HTTPException(status_code=423, detail=f"Account locked. Try again in {remaining} seconds.")

    # Verify password
    if not verify_password(req.password, user.password_hash):
        user.failed_login_attempts += 1
        if user.failed_login_attempts >= settings.LOGIN_MAX_ATTEMPTS:
            user.status = "locked"
            user.locked_until = datetime.utcnow() + timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
            await _log_security(db, "lockout_triggered", "CRITICAL", user.id, user.tenant_id, ip, ua,
                                f"Locked after {user.failed_login_attempts} failed attempts")
        else:
            await _log_security(db, "login_failure", "LOW", user.id, user.tenant_id, ip, ua,
                                f"Wrong password. Attempts: {user.failed_login_attempts}")

        await _log_event(db, "login_failed", user.id, user.tenant_id, "user", str(user.id),
                         "failure", ip, ua, "Invalid password")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Success — reset lockout counter
    user.failed_login_attempts = 0
    user.locked_until = None

    # Transparent rehash: if Argon2id params changed, upgrade hash on login
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(req.password)
        logger.info("Rehashed password with updated Argon2id parameters", extra={"user_id": str(user.id)})

    # Get role
    roles_result = await db.execute(select(UserRole).where(UserRole.user_id == user.id))
    roles = [r.role for r in roles_result.scalars().all()]
    primary_role = roles[0] if roles else "user"

    # Issue tokens
    access_token = create_access_token(str(user.id), str(user.tenant_id), primary_role, roles)
    refresh_tok, family_id = create_refresh_token(str(user.id))

    # Save session
    session = Session(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_tok),
        family_id=uuid.UUID(family_id),
        ip=ip,
        user_agent=ua,
    )
    db.add(session)

    await _log_event(db, "login_success", user.id, user.tenant_id, "user", str(user.id),
                     "success", ip, ua)

    # Set refresh token cookie
    response.set_cookie(
        key="refresh_token",
        value=refresh_tok,
        httponly=True,
        secure=False,  # ⚠️ Production MUST set True (HTTPS only)
        samesite="lax",
        max_age=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/auth",
    )

    return LoginResponse(
        access_token=access_token,
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user={
            "id": str(user.id),
            "email": user.email,
            "full_name": user.full_name,
            "role": primary_role,
            "roles": roles,
            "tenant_id": str(user.tenant_id),
        },
    )


@app.post("/auth/refresh")
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    set_trace_id(str(uuid.uuid4()))
    refresh_tok = request.cookies.get("refresh_token")
    if not refresh_tok:
        raise HTTPException(status_code=401, detail="No refresh token provided")

    try:
        payload = verify_refresh_token(refresh_tok)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    user_id = payload.get("sub")
    family_id = payload.get("fid")
    token_hash = hash_token(refresh_tok)

    # Find matching session
    result = await db.execute(
        select(Session).where(
            and_(
                Session.user_id == uuid.UUID(user_id),
                Session.refresh_token_hash == token_hash,
                Session.status == "active",
            )
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        # Token reuse detected! Revoke entire family
        await db.execute(
            update(Session).where(
                Session.family_id == uuid.UUID(family_id)
            ).values(status="revoked", revoked_at=datetime.utcnow())
        )
        await _log_security(db, "refresh_token_reuse", "CRITICAL", uuid.UUID(user_id),
                            detail=f"Token reuse detected for family {family_id}. All sessions revoked.")
        raise HTTPException(status_code=401, detail="Token reuse detected. All sessions revoked.")

    # Rotate: revoke old, create new
    session.status = "revoked"
    session.revoked_at = datetime.utcnow()

    # Get user info for new tokens
    user_result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = user_result.scalar_one_or_none()
    if not user or user.status != "active":
        raise HTTPException(status_code=401, detail="User account not active")

    roles_result = await db.execute(select(UserRole).where(UserRole.user_id == user.id))
    roles = [r.role for r in roles_result.scalars().all()]
    primary_role = roles[0] if roles else "user"

    new_access = create_access_token(str(user.id), str(user.tenant_id), primary_role, roles)
    new_refresh, _ = create_refresh_token(str(user.id), family_id)

    new_session = Session(
        user_id=user.id,
        refresh_token_hash=hash_token(new_refresh),
        family_id=uuid.UUID(family_id),
        ip=request.headers.get("X-Forwarded-For", request.client.host if request.client else ""),
        user_agent=request.headers.get("User-Agent", ""),
    )
    db.add(new_session)

    response.set_cookie(
        key="refresh_token",
        value=new_refresh,
        httponly=True,
        secure=False,  # ⚠️ Production MUST set True (HTTPS only)
        samesite="lax",
        max_age=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/auth",
    )

    return {"access_token": new_access, "token_type": "bearer",
            "expires_in": settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60}


@app.post("/auth/logout")
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db),
                 user: CurrentUser = Depends(get_current_user)):
    set_trace_id(str(uuid.uuid4()))
    refresh_tok = request.cookies.get("refresh_token")
    if refresh_tok:
        token_hash = hash_token(refresh_tok)
        # Revoke this session
        await db.execute(
            update(Session).where(
                Session.refresh_token_hash == token_hash
            ).values(status="revoked", revoked_at=datetime.utcnow())
        )

    response.delete_cookie("refresh_token", path="/auth")
    await _log_event(db, "logout", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "user", user.user_id, "success")
    return {"message": "Logged out successfully"}


# ─── Password Policy ───

_COMMON_PASSWORDS = {
    "password123", "admin123", "qwerty123", "letmein", "welcome1",
    "changeme", "password1", "123456789", "abc123456", "iloveyou",
}


def _validate_password(password: str, email: str = "") -> str | None:
    """Validate password strength. Returns error message or None."""
    if len(password) < 12:
        return "Password must be at least 12 characters"
    if not any(c.isupper() for c in password):
        return "Password must contain at least one uppercase letter"
    if not any(c.islower() for c in password):
        return "Password must contain at least one lowercase letter"
    if not any(c.isdigit() for c in password):
        return "Password must contain at least one digit"
    if not any(c in '!@#$%^&*()_+-=[]{}|;:,.<>?/~`' for c in password):
        return "Password must contain at least one special character"
    if password.lower() in _COMMON_PASSWORDS:
        return "Password is too common"
    if email:
        local = email.split("@")[0].lower()
        if len(local) > 3 and local in password.lower():
            return "Password must not contain your email address"
    return None


@app.post("/auth/change-password")
async def change_password(req: ChangePasswordRequest, request: Request, response: Response,
                          db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(get_current_user)):
    set_trace_id(str(uuid.uuid4()))
    result = await db.execute(select(User).where(User.id == uuid.UUID(user.user_id)))
    db_user = result.scalar_one_or_none()
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Require current password (anti-hijack)
    if not verify_password(req.old_password, db_user.password_hash):
        ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else None)
        await _log_security(db, "password_change_failed", "MED", db_user.id, db_user.tenant_id,
                            ip=ip, ua=request.headers.get("User-Agent"),
                            detail="Wrong current password")
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    # Password policy check
    pw_error = _validate_password(req.new_password, db_user.email)
    if pw_error:
        raise HTTPException(status_code=400, detail=pw_error)

    # Same password check
    if verify_password(req.new_password, db_user.password_hash):
        raise HTTPException(status_code=400, detail="New password must be different from current password")

    # Update password
    db_user.password_hash = hash_password(req.new_password)

    # Revoke ALL sessions → force re-login on every device
    await db.execute(
        update(Session).where(
            and_(Session.user_id == db_user.id, Session.status == "active")
        ).values(status="revoked", revoked_at=datetime.utcnow())
    )

    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else None)
    ua = request.headers.get("User-Agent")
    await _log_event(db, "change_password", db_user.id, db_user.tenant_id,
                     "user", str(db_user.id), "success", ip=ip, ua=ua)
    await _log_security(db, "password_changed", "MED", db_user.id, db_user.tenant_id,
                        ip=ip, ua=ua, detail="All sessions revoked after password change")

    # Clear refresh cookie on this device
    response.delete_cookie("refresh_token", path="/auth")

    return {
        "message": "Password changed successfully. All sessions have been revoked — please log in again.",
        "sessions_revoked": True,
    }


@app.get("/auth/me")
async def me(user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == uuid.UUID(user.user_id)))
    db_user = result.scalar_one_or_none()
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Roles
    roles_result = await db.execute(select(UserRole).where(UserRole.user_id == db_user.id))
    roles = [r.role for r in roles_result.scalars().all()]

    # Tenant name
    tenant_name = None
    if db_user.tenant_id:
        tenant_result = await db.execute(select(Tenant).where(Tenant.id == db_user.tenant_id))
        tenant = tenant_result.scalar_one_or_none()
        tenant_name = tenant.name if tenant else None

    # Last login (from EventLog)
    last_login_result = await db.execute(
        select(EventLog)
        .where(and_(
            EventLog.user_id == db_user.id,
            EventLog.action == "login_success",
            EventLog.status == "success",
        ))
        .order_by(desc(EventLog.timestamp))
        .limit(1)
    )
    last_login = last_login_result.scalar_one_or_none()

    return {
        "id": str(db_user.id),
        "email": db_user.email,
        "full_name": db_user.full_name,
        "role": roles[0] if roles else "user",
        "roles": roles,
        "tenant_id": str(db_user.tenant_id) if db_user.tenant_id else None,
        "tenant_name": tenant_name,
        "status": db_user.status,
        "mfa_enabled": db_user.mfa_enabled,
        "created_at": (db_user.created_at.isoformat() + "+00:00") if db_user.created_at else None,
        "last_login_at": (last_login.timestamp.isoformat() + "+00:00") if last_login else None,
        "last_login_ip": last_login.ip if last_login else None,
    }


# ═══════════════════════════════════════════════════════════════
# SESSION MANAGEMENT
# ═══════════════════════════════════════════════════════════════

@app.get("/auth/sessions")
async def list_sessions(request: Request, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)):
    """List user's sessions (active + recently revoked)."""
    result = await db.execute(
        select(Session)
        .where(Session.user_id == uuid.UUID(user.user_id))
        .order_by(desc(Session.created_at))
        .limit(50)
    )
    sessions = result.scalars().all()

    # Detect current session via refresh token
    current_refresh = request.cookies.get("refresh_token")
    current_hash = hash_token(current_refresh) if current_refresh else None

    return [
        {
            "id": str(s.id),
            "ip": s.ip,
            "user_agent": s.user_agent,
            "status": s.status,
            "is_current": s.refresh_token_hash == current_hash if current_hash else False,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "last_seen": s.last_seen.isoformat() if s.last_seen else None,
            "revoked_at": s.revoked_at.isoformat() if s.revoked_at else None,
        }
        for s in sessions
    ]


@app.post("/auth/logout-all")
async def logout_all(request: Request, response: Response, db: AsyncSession = Depends(get_db),
                     user: CurrentUser = Depends(get_current_user)):
    """Revoke ALL sessions for this user (logout every device)."""
    set_trace_id(str(uuid.uuid4()))

    result = await db.execute(
        update(Session).where(
            and_(Session.user_id == uuid.UUID(user.user_id), Session.status == "active")
        ).values(status="revoked", revoked_at=datetime.utcnow())
    )
    revoked_count = result.rowcount

    response.delete_cookie("refresh_token", path="/auth")

    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else None)
    ua = request.headers.get("User-Agent")
    await _log_event(db, "logout_all", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "session", "", "success", ip=ip, ua=ua,
                     detail=f"Revoked {revoked_count} sessions")
    await _log_security(db, "logout_all", "MED", uuid.UUID(user.user_id),
                        uuid.UUID(user.tenant_id), ip=ip, ua=ua,
                        detail=f"All {revoked_count} sessions revoked")

    return {"message": f"All sessions revoked ({revoked_count})", "revoked_count": revoked_count}


@app.delete("/auth/sessions/{session_id}")
async def revoke_session(session_id: str, request: Request, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)):
    """Revoke a specific session."""
    set_trace_id(str(uuid.uuid4()))

    result = await db.execute(
        select(Session).where(
            and_(Session.id == uuid.UUID(session_id),
                 Session.user_id == uuid.UUID(user.user_id),
                 Session.status == "active")
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Active session not found")

    # Don't allow revoking current session (use /auth/logout instead)
    current_refresh = request.cookies.get("refresh_token")
    if current_refresh and session.refresh_token_hash == hash_token(current_refresh):
        raise HTTPException(status_code=400, detail="Cannot revoke current session. Use /auth/logout instead.")

    session.status = "revoked"
    session.revoked_at = datetime.utcnow()

    # Evict from Redis if cached
    await redis_client.delete(f"session:{session.refresh_token_hash}")

    await _log_event(db, "session_revoked", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "session", session_id, "success")

    return {"message": "Session revoked", "id": session_id}


# ═══════════════════════════════════════════════════════════════
# LOGIN ACTIVITY (user self-service)
# ═══════════════════════════════════════════════════════════════

@app.get("/auth/login-activity")
async def login_activity(limit: int = 20, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)):
    """Get user's own login history (no admin required)."""
    result = await db.execute(
        select(EventLog)
        .where(and_(
            EventLog.user_id == uuid.UUID(user.user_id),
            EventLog.action.like("login%"),
        ))
        .order_by(desc(EventLog.timestamp))
        .limit(min(limit, 50))
    )
    events = result.scalars().all()

    return [
        {
            "timestamp": e.timestamp.isoformat() if e.timestamp else None,
            "action": "LOGIN_SUCCESS" if e.status == "success" else "LOGIN_FAILED",
            "status": e.status,
            "ip": e.ip,
            "user_agent": e.user_agent,
            "detail": e.detail,
        }
        for e in events
    ]


# ─── API KEY MANAGEMENT ───

# ─── API Key Management ───

@app.post("/auth/validate-api-key")
async def validate_api_key(request: Request, db: AsyncSession = Depends(get_db)):
    """Internal: Gateway calls this to validate an API key hash.
    Protected by X-Internal-Token (service-to-service only)."""
    internal_token = request.headers.get("X-Internal-Token", "")
    if internal_token != settings.INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=403, detail="Internal endpoint only")

    body = await request.json()
    key_hash = body.get("key_hash", "")
    if not key_hash:
        raise HTTPException(status_code=400, detail="key_hash required")

    result = await db.execute(
        select(APIKey).where(
            and_(APIKey.key_hash == key_hash,
                 APIKey.status.in_(["active", "next"]))
        )
    )
    api_key = result.scalar_one_or_none()
    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found or inactive")

    return {
        "user_id": str(api_key.user_id),
        "tenant_id": str(api_key.tenant_id),
        "scopes": api_key.scopes,
        "rpm_limit": api_key.rpm_limit,
        "daily_token_limit": api_key.daily_token_limit,
        "status": api_key.status,
    }


@app.post("/auth/api-keys")
async def create_api_key(req: CreateAPIKeyRequest, request: Request, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)):
    set_trace_id(str(uuid.uuid4()))
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    ua = request.headers.get("User-Agent", "")
    plaintext_key, prefix = generate_api_key()

    api_key = APIKey(
        user_id=uuid.UUID(user.user_id),
        tenant_id=uuid.UUID(user.tenant_id),
        name=req.name,
        key_hash=hash_token(plaintext_key),
        key_prefix=prefix,
        status="active",
        scopes=req.scopes,
        rpm_limit=req.rpm_limit,
        daily_token_limit=req.daily_token_limit,
    )
    db.add(api_key)
    await db.flush()

    await _log_event(db, "api_key_created", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "api_key", str(api_key.id), "success", ip=ip, ua=ua,
                     detail=f"name={req.name} rpm={req.rpm_limit} daily_tokens={req.daily_token_limit}")

    return {
        "id": str(api_key.id),
        "name": api_key.name,
        "key": plaintext_key,  # Show ONCE only
        "prefix": prefix,
        "scopes": api_key.scopes,
        "rpm_limit": api_key.rpm_limit,
        "daily_token_limit": api_key.daily_token_limit,
        "message": "⚠️ Save this key now. It will NOT be shown again.",
    }


@app.get("/auth/api-keys")
async def list_api_keys(db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)):
    result = await db.execute(
        select(APIKey).where(
            and_(APIKey.user_id == uuid.UUID(user.user_id),
                 APIKey.status.in_(["active", "next"]))
        )
    )
    keys = result.scalars().all()

    # Fetch daily token usage from Redis for this user
    today = datetime.utcnow().strftime("%Y-%m-%d")
    dt_key = f"daily_tokens:{user.user_id}:{today}"
    daily_used_raw = await redis_client.get(dt_key)
    daily_tokens_used = int(daily_used_raw) if daily_used_raw else 0

    return [
        {
            "id": str(k.id),
            "name": k.name,
            "prefix": k.key_prefix,
            "status": k.status,
            "scopes": k.scopes,
            "rpm_limit": k.rpm_limit,
            "daily_token_limit": k.daily_token_limit,
            "daily_tokens_used": daily_tokens_used,
            "created_at": k.created_at.isoformat() if k.created_at else None,
            "rotated_at": k.rotated_at.isoformat() if k.rotated_at else None,
        }
        for k in keys
    ]


@app.post("/auth/api-keys/{key_id}/rotate")
async def rotate_api_key(key_id: str, request: Request, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)):
    """Create NEXT key, keeping old ACTIVE during grace period."""
    set_trace_id(str(uuid.uuid4()))
    result = await db.execute(
        select(APIKey).where(
            and_(APIKey.id == uuid.UUID(key_id),
                 APIKey.user_id == uuid.UUID(user.user_id),
                 APIKey.status == "active")
        )
    )
    old_key = result.scalar_one_or_none()
    if not old_key:
        raise HTTPException(status_code=404, detail="Active API key not found")

    # Generate new (NEXT) key
    plaintext_key, prefix = generate_api_key()
    new_key = APIKey(
        user_id=uuid.UUID(user.user_id),
        tenant_id=uuid.UUID(user.tenant_id),
        name=f"{old_key.name} (rotated)",
        key_hash=hash_token(plaintext_key),
        key_prefix=prefix,
        status="next",
        scopes=old_key.scopes,
        rpm_limit=old_key.rpm_limit,
        daily_token_limit=old_key.daily_token_limit,
        parent_key_id=old_key.id,  # links to old key for finalize
    )
    db.add(new_key)
    await db.flush()

    old_key.rotated_at = datetime.utcnow()
    await _log_event(db, "api_key_rotated", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "api_key", str(old_key.id), "success",
                     detail=f"New key {str(new_key.id)} created as NEXT")
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else None)
    await _log_security(db, "key_rotation", "MED", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                        ip=ip, ua=request.headers.get("User-Agent"))

    return {
        "old_key_id": str(old_key.id),
        "new_key_id": str(new_key.id),
        "new_key": plaintext_key,
        "status": "Both keys are active during grace period",
        "message": "⚠️ Save this key. Call /finalize to complete rotation.",
    }


@app.post("/auth/api-keys/{key_id}/finalize")
async def finalize_rotation(key_id: str, db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(get_current_user)):
    """Finalize: NEXT → ACTIVE, old → RETIRED."""
    set_trace_id(str(uuid.uuid4()))
    # The key_id here is the OLD key to retire
    result = await db.execute(
        select(APIKey).where(
            and_(APIKey.id == uuid.UUID(key_id),
                 APIKey.user_id == uuid.UUID(user.user_id),
                 APIKey.status == "active")
        )
    )
    old_key = result.scalar_one_or_none()
    if not old_key:
        raise HTTPException(status_code=404, detail="Active API key not found")

    # Find the NEXT key linked to this specific old key
    next_result = await db.execute(
        select(APIKey).where(
            and_(APIKey.user_id == uuid.UUID(user.user_id),
                 APIKey.parent_key_id == old_key.id,
                 APIKey.status == "next")
        )
    )
    next_key = next_result.scalar_one_or_none()
    if not next_key:
        raise HTTPException(status_code=400, detail="No NEXT key found for this key. Call /rotate first.")

    old_key.status = "retired"
    next_key.status = "active"

    # Evict old key from Redis cache
    await redis_client.delete(f"apikey:{old_key.key_hash}")

    await _log_event(db, "api_key_finalized", uuid.UUID(user.user_id), uuid.UUID(user.tenant_id),
                     "api_key", str(old_key.id), "success",
                     detail=f"Old key retired, new key {str(next_key.id)} active")

    return {"message": "Rotation complete", "retired_key_id": str(old_key.id),
            "active_key_id": str(next_key.id)}


@app.delete("/auth/api-keys/{key_id}")
async def revoke_api_key(key_id: str, request: Request, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)):
    """Emergency revoke — immediate."""
    set_trace_id(str(uuid.uuid4()))
    result = await db.execute(
        select(APIKey).where(
            and_(APIKey.id == uuid.UUID(key_id),
                 APIKey.user_id == uuid.UUID(user.user_id),
                 APIKey.status.in_(["active", "next"]))
        )
    )
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail="API key not found")

    key.status = "revoked"
    await redis_client.delete(f"apikey:{key.key_hash}")

    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else None)
    await _log_security(db, "api_key_revoked", "HIGH", uuid.UUID(user.user_id),
                        uuid.UUID(user.tenant_id), ip=ip, ua=request.headers.get("User-Agent"),
                        detail=f"Emergency revoke of key {key_id}")
    return {"message": "API key revoked immediately"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
