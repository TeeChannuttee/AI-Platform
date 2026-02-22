"""
ALL SQLAlchemy ORM models — single source of truth.
Every service imports from here.
"""
import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Boolean, Integer, Float, Text, DateTime,
    ForeignKey, Enum as SAEnum, Index, BigInteger,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from shared.db import Base


def _uuid():
    return uuid.uuid4()


def _now():
    return datetime.utcnow()


# ─────────────────────────── TENANTS ───────────────────────────

class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name = Column(String(255), nullable=False)
    slug = Column(String(100), unique=True, nullable=False, index=True)
    status = Column(String(20), default="active")  # active, suspended, deleted
    max_users = Column(Integer, default=50)
    created_by = Column(UUID(as_uuid=True), nullable=True)  # admin user id
    created_at = Column(DateTime, default=_now)


# ─────────────────────────── AUTH ───────────────────────────

class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(512), nullable=False)
    full_name = Column(String(255), default="")
    status = Column(String(20), default="active")  # active, locked, disabled
    mfa_enabled = Column(Boolean, default=False)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    failed_login_attempts = Column(Integer, default=0)
    locked_until = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    roles = relationship("UserRole", back_populates="user", lazy="selectin")
    sessions = relationship("Session", back_populates="user", lazy="selectin")


class UserRole(Base):
    __tablename__ = "user_roles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(50), nullable=False)  # admin, user, viewer

    user = relationship("User", back_populates="roles")


class Session(Base):
    __tablename__ = "sessions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    refresh_token_hash = Column(String(512), nullable=False)
    family_id = Column(UUID(as_uuid=True), default=_uuid)
    status = Column(String(20), default="active")  # active, revoked, expired
    ip = Column(String(45))
    user_agent = Column(String(512))
    device_id = Column(String(255))
    last_seen = Column(DateTime, default=_now)
    created_at = Column(DateTime, default=_now)
    revoked_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="sessions")


# ─────────────────────────── API KEYS ───────────────────────────

class APIKey(Base):
    __tablename__ = "api_keys"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    tenant_id = Column(UUID(as_uuid=True), nullable=True)
    name = Column(String(255), default="Default Key")
    key_hash = Column(String(512), nullable=False, unique=True)
    key_prefix = Column(String(12), nullable=False)  # first 8 chars for identification
    status = Column(String(20), default="active")  # active, next, retired, revoked
    scopes = Column(Text, default="*")  # comma-separated: "chat,files,admin"
    rpm_limit = Column(Integer, default=60)
    daily_token_limit = Column(Integer, default=1_000_000)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)
    rotated_at = Column(DateTime, nullable=True)
    parent_key_id = Column(UUID(as_uuid=True), nullable=True)  # links rotated key to its parent


# ─────────────────────────── INVITATIONS ───────────────────────────

class Invitation(Base):
    __tablename__ = "invitations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    email = Column(String(255), nullable=True)         # optional: lock to specific email
    role = Column(String(50), default="user")           # role to assign on accept
    token_hash = Column(String(512), unique=True, nullable=False)  # SHA-256 hash
    status = Column(String(20), default="PENDING")     # PENDING, USED, REVOKED, EXPIRED
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    used_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=_now)

    __table_args__ = (
        Index("ix_invitations_token_hash", "token_hash"),
        Index("ix_invitations_tenant_status", "tenant_id", "status"),
    )


# ─────────────────────────── FILES ───────────────────────────

class File(Base):
    __tablename__ = "files"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    filename = Column(String(512), nullable=False)
    mime_type = Column(String(128))
    size = Column(BigInteger, default=0)
    storage_key = Column(String(1024))  # S3/MinIO key
    sha256 = Column(String(64))
    status = Column(String(20), default="uploaded")
    # uploading, scanning, quarantined, processing, ready, failed, deleted
    chunks_total = Column(Integer, default=0)      # total chunks to embed
    chunks_processed = Column(Integer, default=0)  # chunks upserted so far
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    acl = relationship("FileACL", back_populates="file", lazy="selectin")

    __table_args__ = (
        Index("ix_files_owner_tenant", "owner_id", "tenant_id"),
    )


class FileACL(Base):
    __tablename__ = "file_acl"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    file_id = Column(UUID(as_uuid=True), ForeignKey("files.id", ondelete="CASCADE"), nullable=False)
    principal_type = Column(String(20))  # user, role, tenant
    principal_id = Column(String(255))
    permission = Column(String(20))  # read, write, admin

    file = relationship("File", back_populates="acl")


# ─────────────────────────── LLM / CONVERSATIONS ───────────────────────────

class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), nullable=False)
    title = Column(String(512), default="New Conversation")
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    messages = relationship("Message", back_populates="conversation", lazy="selectin")


class Message(Base):
    __tablename__ = "messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(20), nullable=False)  # user, assistant, system
    content = Column(Text, nullable=False)
    citations = Column(Text, nullable=True)  # JSON string
    file_ids = Column(Text, nullable=True)  # JSON string
    prompt_tokens = Column(Integer, default=0)
    completion_tokens = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    model = Column(String(100))
    created_at = Column(DateTime, default=_now)

    conversation = relationship("Conversation", back_populates="messages")


# ─────────────────────────── MONITORING LOGS ───────────────────────────

class EventLog(Base):
    __tablename__ = "event_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    timestamp = Column(DateTime, default=_now, index=True)
    trace_id = Column(String(64), index=True)
    tenant_id = Column(UUID(as_uuid=True), nullable=True)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    action = Column(String(100), nullable=False, index=True)
    resource_type = Column(String(50))
    resource_id = Column(String(255))
    status = Column(String(20))  # success, failure, error
    ip = Column(String(45))
    user_agent = Column(String(512))
    detail = Column(Text)


class SecurityLog(Base):
    __tablename__ = "security_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    timestamp = Column(DateTime, default=_now, index=True)
    trace_id = Column(String(64), index=True)
    tenant_id = Column(UUID(as_uuid=True), nullable=True)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    event_type = Column(String(100), nullable=False)
    severity = Column(String(10), nullable=False)  # LOW, MED, HIGH, CRITICAL
    detail = Column(Text)
    ip = Column(String(45))
    user_agent = Column(String(512))
    prev_hash = Column(String(64))  # hash chaining for integrity


class LLMUsageLog(Base):
    __tablename__ = "llm_usage_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    user_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    conversation_id = Column(UUID(as_uuid=True), nullable=True)
    trace_id = Column(String(64), index=True)
    model = Column(String(100))
    prompt_tokens = Column(Integer, default=0)
    completion_tokens = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    cost_usd = Column(Float, default=0.0)
    rag_latency_ms = Column(Integer, default=0)
    infer_latency_ms = Column(Integer, default=0)
    pipeline_version = Column(String(50), default="v1")
    citation_count = Column(Integer, default=0)
    citation_invalid_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=_now, index=True)


# ─────────────────────────── MEMORY LAYER (Tier 3) ───────────────────────────

class SemanticMemory(Base):
    __tablename__ = "semantic_memory"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), nullable=False)
    key = Column(String(255), nullable=False)  # e.g. "preferred_language", "role"
    value = Column(Text, nullable=False)
    category = Column(String(50), default="preference")  # preference, trait, context
    opt_in = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    __table_args__ = (
        Index("ix_semantic_memory_user_key", "user_id", "key", unique=True),
    )


# ─────────────────────────── ALERT RULES ───────────────────────────

class AlertRule(Base):
    __tablename__ = "alert_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name = Column(String(255), nullable=False)
    condition_type = Column(String(50), nullable=False)  # login_fail, unauthorized, virus, citation_invalid
    threshold = Column(Integer, default=5)
    window_minutes = Column(Integer, default=5)
    severity = Column(String(10), default="HIGH")
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_now)


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    rule_id = Column(UUID(as_uuid=True), ForeignKey("alert_rules.id"), nullable=True)
    rule_name = Column(String(255))
    severity = Column(String(10), default="HIGH")
    message = Column(Text)
    trace_id = Column(String(64))
    status = Column(String(20), default="open")  # open, acknowledged, resolved
    acknowledged_by = Column(UUID(as_uuid=True), nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)
