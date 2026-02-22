"""
Monitoring Service — Event, Security, LLM Usage Logs + Alert Rules Engine + SSE Stream.
Port 8005.
"""
import uuid
import json
import asyncio
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from collections import deque

from fastapi import FastAPI, Depends, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, and_, func, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from shared.config import get_settings
from shared.db import get_db, init_db, AsyncSessionLocal
from shared.models import EventLog, SecurityLog, LLMUsageLog, AlertRule, Alert
from shared.dependencies import get_current_user, require_role, CurrentUser
from shared.logging_utils import setup_logger, get_trace_id, set_trace_id

settings = get_settings()
logger = setup_logger("monitoring_service", service_version=settings.SYSTEM_VERSION)

# In-memory alert queue for SSE broadcasting
alert_queue: deque = deque(maxlen=100)
alert_subscribers: list[asyncio.Queue] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Monitoring Service starting...")
    await init_db()
    # Seed default alert rules
    await _seed_alert_rules()
    # Start background alert checker
    task = asyncio.create_task(_alert_checker_loop())
    yield
    task.cancel()
    logger.info("Monitoring Service shutting down...")


app = FastAPI(title="Monitoring Service", version=settings.SYSTEM_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


# ─── Schemas ───
class EventLogCreate(BaseModel):
    trace_id: str | None = None
    tenant_id: str | None = None
    user_id: str | None = None
    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    status: str = "success"
    ip: str | None = None
    user_agent: str | None = None
    detail: str | None = None

class SecurityLogCreate(BaseModel):
    trace_id: str | None = None
    tenant_id: str | None = None
    user_id: str | None = None
    event_type: str
    severity: str = "MED"
    detail: str | None = None
    ip: str | None = None
    user_agent: str | None = None


# ─── Seed Alert Rules ───
async def _seed_alert_rules():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(func.count(AlertRule.id)))
        count = result.scalar()
        if count == 0:
            rules = [
                AlertRule(name="Login Failure Spike", condition_type="login_fail",
                          threshold=5, window_minutes=5, severity="HIGH"),
                AlertRule(name="Unauthorized Access Spike", condition_type="unauthorized",
                          threshold=10, window_minutes=5, severity="CRITICAL"),
                AlertRule(name="Virus Detected", condition_type="virus",
                          threshold=1, window_minutes=60, severity="CRITICAL"),
                AlertRule(name="Invalid Citation Rate", condition_type="citation_invalid",
                          threshold=5, window_minutes=10, severity="HIGH"),
            ]
            for r in rules:
                db.add(r)
            await db.commit()
            logger.info("Seeded default alert rules")


# ─── Alert Checker Background Task ───
async def _alert_checker_loop():
    """Periodically check alert conditions."""
    while True:
        try:
            await _check_alert_conditions()
        except Exception as e:
            logger.error(f"Alert checker error: {e}")
        await asyncio.sleep(30)  # Check every 30 seconds


async def _check_alert_conditions():
    async with AsyncSessionLocal() as db:
        rules_result = await db.execute(select(AlertRule).where(AlertRule.enabled == True))
        rules = rules_result.scalars().all()

        for rule in rules:
            count = 0
            cutoff = datetime.utcnow() - timedelta(minutes=rule.window_minutes)

            if rule.condition_type == "login_fail":
                result = await db.execute(
                    select(func.count(SecurityLog.id)).where(
                        and_(SecurityLog.event_type == "login_failure",
                             SecurityLog.timestamp >= cutoff)
                    )
                )
                count = result.scalar() or 0

            elif rule.condition_type == "unauthorized":
                result = await db.execute(
                    select(func.count(EventLog.id)).where(
                        and_(EventLog.action.like("%unauthorized%"),
                             EventLog.timestamp >= cutoff)
                    )
                )
                count = result.scalar() or 0

            elif rule.condition_type == "virus":
                result = await db.execute(
                    select(func.count(SecurityLog.id)).where(
                        and_(SecurityLog.event_type == "virus_detected",
                             SecurityLog.timestamp >= cutoff)
                    )
                )
                count = result.scalar() or 0

            elif rule.condition_type == "citation_invalid":
                result = await db.execute(
                    select(func.sum(LLMUsageLog.citation_invalid_count)).where(
                        LLMUsageLog.created_at >= cutoff
                    )
                )
                count = result.scalar() or 0

            if count >= rule.threshold:
                # Check if alert already exists recently
                existing = await db.execute(
                    select(Alert).where(
                        and_(
                            Alert.rule_id == rule.id,
                            Alert.status == "open",
                            Alert.created_at >= cutoff,
                        )
                    )
                )
                if not existing.scalar_one_or_none():
                    alert = Alert(
                        rule_id=rule.id,
                        rule_name=rule.name,
                        severity=rule.severity,
                        message=f"{rule.name}: {count} occurrences in last {rule.window_minutes} min (threshold: {rule.threshold})",
                    )
                    db.add(alert)
                    await db.commit()
                    await db.refresh(alert)

                    # Broadcast to SSE subscribers
                    alert_data = {
                        "id": str(alert.id),
                        "rule_name": alert.rule_name,
                        "severity": alert.severity,
                        "message": alert.message,
                        "created_at": alert.created_at.isoformat() if alert.created_at else None,
                    }
                    alert_queue.append(alert_data)
                    for q in alert_subscribers:
                        try:
                            q.put_nowait(alert_data)
                        except asyncio.QueueFull:
                            pass
                    logger.warning(f"🚨 Alert triggered: {alert.message}")


# ─── Endpoints ───

@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "monitoring", "version": settings.SYSTEM_VERSION}


# ═══ Event Logs ═══

@app.post("/logs/events")
async def create_event(req: EventLogCreate, db: AsyncSession = Depends(get_db)):
    """Internal: record an event log."""
    db.add(EventLog(
        trace_id=req.trace_id or get_trace_id(),
        tenant_id=uuid.UUID(req.tenant_id) if req.tenant_id else None,
        user_id=uuid.UUID(req.user_id) if req.user_id else None,
        action=req.action,
        resource_type=req.resource_type,
        resource_id=req.resource_id,
        status=req.status,
        ip=req.ip,
        user_agent=req.user_agent,
        detail=req.detail,
    ))
    await db.commit()
    return {"status": "ok"}


@app.get("/logs/events")
async def list_events(
    action: str | None = None,
    user_id: str | None = None,
    resource_type: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = Query(50, le=500),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    query = select(EventLog)

    # User-level isolation: non-admin sees only their own events (least privilege)
    if user.role != "admin":
        query = query.where(EventLog.user_id == uuid.UUID(user.user_id))

    if action:
        query = query.where(EventLog.action == action)
    if user_id:
        query = query.where(EventLog.user_id == uuid.UUID(user_id))
    if resource_type:
        query = query.where(EventLog.resource_type == resource_type)
    if from_date:
        query = query.where(EventLog.timestamp >= from_date)
    if to_date:
        query = query.where(EventLog.timestamp <= to_date)

    query = query.order_by(EventLog.timestamp.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    logs = result.scalars().all()

    return [
        {
            "id": str(l.id),
            "timestamp": l.timestamp.isoformat() if l.timestamp else None,
            "trace_id": l.trace_id,
            "user_id": str(l.user_id) if l.user_id else None,
            "action": l.action,
            "resource_type": l.resource_type,
            "resource_id": l.resource_id,
            "status": l.status,
            "ip": l.ip,
            "user_agent": l.user_agent,
            "detail": l.detail,
        }
        for l in logs
    ]


# ═══ Security Logs ═══

@app.post("/logs/security")
async def create_security_log(req: SecurityLogCreate, db: AsyncSession = Depends(get_db)):
    """Internal: record a security event with tamper-evident hash chain."""
    import hashlib

    # Hash chaining: chain based on CONTENT hash of previous record, not just ID
    # If any previous record is tampered with, the chain breaks detectably
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

    db.add(SecurityLog(
        trace_id=req.trace_id or get_trace_id(),
        tenant_id=uuid.UUID(req.tenant_id) if req.tenant_id else None,
        user_id=uuid.UUID(req.user_id) if req.user_id else None,
        event_type=req.event_type,
        severity=req.severity,
        detail=req.detail,
        ip=req.ip,
        user_agent=req.user_agent,
        prev_hash=prev_hash,
    ))
    await db.commit()
    return {"status": "ok"}


@app.get("/logs/security")
async def list_security_logs(
    severity: str | None = None,
    event_type: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = Query(50, le=500),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_role("admin")),
):
    query = select(SecurityLog)
    if severity:
        query = query.where(SecurityLog.severity == severity)
    if event_type:
        query = query.where(SecurityLog.event_type == event_type)
    if from_date:
        query = query.where(SecurityLog.timestamp >= from_date)
    if to_date:
        query = query.where(SecurityLog.timestamp <= to_date)

    query = query.order_by(SecurityLog.timestamp.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    logs = result.scalars().all()

    return [
        {
            "id": str(l.id),
            "timestamp": l.timestamp.isoformat() if l.timestamp else None,
            "trace_id": l.trace_id,
            "user_id": str(l.user_id) if l.user_id else None,
            "event_type": l.event_type,
            "severity": l.severity,
            "detail": l.detail,
            "ip": l.ip,
            "prev_hash": l.prev_hash,
        }
        for l in logs
    ]


# ═══ LLM Usage Logs ═══

@app.get("/logs/llm-usage")
async def list_llm_usage(
    user_id: str | None = None,
    model: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = Query(50, le=500),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    query = select(LLMUsageLog)

    if user.role != "admin":
        query = query.where(LLMUsageLog.user_id == uuid.UUID(user.user_id))
    elif user_id:
        query = query.where(LLMUsageLog.user_id == uuid.UUID(user_id))

    if model:
        query = query.where(LLMUsageLog.model == model)
    if from_date:
        query = query.where(LLMUsageLog.created_at >= from_date)
    if to_date:
        query = query.where(LLMUsageLog.created_at <= to_date)

    query = query.order_by(LLMUsageLog.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    logs = result.scalars().all()

    return [
        {
            "id": str(l.id),
            "user_id": str(l.user_id) if l.user_id else None,
            "conversation_id": str(l.conversation_id) if l.conversation_id else None,
            "trace_id": l.trace_id,
            "model": l.model,
            "prompt_tokens": l.prompt_tokens,
            "completion_tokens": l.completion_tokens,
            "total_tokens": l.total_tokens,
            "cost_usd": l.cost_usd,
            "rag_latency_ms": l.rag_latency_ms,
            "infer_latency_ms": l.infer_latency_ms,
            "pipeline_version": l.pipeline_version,
            "citation_count": l.citation_count,
            "citation_invalid_count": l.citation_invalid_count,
            "created_at": l.created_at.isoformat() if l.created_at else None,
        }
        for l in logs
    ]


# ═══ Alerts ═══

@app.get("/admin/alerts")
async def list_alerts(
    status_filter: str | None = Query(None, alias="status"),
    severity: str | None = None,
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    query = select(Alert)
    if status_filter:
        query = query.where(Alert.status == status_filter)
    if severity:
        query = query.where(Alert.severity == severity)
    query = query.order_by(Alert.created_at.desc()).limit(limit)

    result = await db.execute(query)
    alerts = result.scalars().all()
    return [
        {
            "id": str(a.id),
            "rule_name": a.rule_name,
            "severity": a.severity,
            "message": a.message,
            "trace_id": a.trace_id,
            "status": a.status,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        }
        for a in alerts
    ]


@app.post("/admin/alerts/{alert_id}/ack")
async def ack_alert(alert_id: str, db: AsyncSession = Depends(get_db),
                    user: CurrentUser = Depends(get_current_user)):
    result = await db.execute(select(Alert).where(Alert.id == uuid.UUID(alert_id)))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")

    alert.status = "acknowledged"
    alert.acknowledged_by = uuid.UUID(user.user_id)
    return {"message": "Alert acknowledged"}


@app.post("/admin/alerts/{alert_id}/resolve")
async def resolve_alert(alert_id: str, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)):
    result = await db.execute(select(Alert).where(Alert.id == uuid.UUID(alert_id)))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")

    alert.status = "resolved"
    alert.resolved_at = datetime.utcnow()
    return {"message": "Alert resolved"}


@app.get("/admin/alerts/stream")
async def alert_stream(request: Request):
    """SSE endpoint for real-time alerts."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    alert_subscribers.append(queue)

    async def event_generator():
        try:
            # Send any recent alerts first
            for alert_data in list(alert_queue)[-5:]:
                yield f"data: {json.dumps(alert_data)}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    alert_data = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(alert_data)}\n\n"
                except asyncio.TimeoutError:
                    yield f": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            alert_subscribers.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ═══ Alert Rules Management ═══

@app.get("/admin/alert-rules")
async def list_alert_rules(db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(get_current_user)):
    result = await db.execute(select(AlertRule).order_by(AlertRule.name))
    rules = result.scalars().all()
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "condition_type": r.condition_type,
            "threshold": r.threshold,
            "window_minutes": r.window_minutes,
            "severity": r.severity,
            "enabled": r.enabled,
        }
        for r in rules
    ]


@app.put("/admin/alert-rules/{rule_id}")
async def update_alert_rule(rule_id: str, threshold: int | None = None,
                            window_minutes: int | None = None,
                            enabled: bool | None = None,
                            db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(require_role("admin"))):
    result = await db.execute(select(AlertRule).where(AlertRule.id == uuid.UUID(rule_id)))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    if threshold is not None:
        rule.threshold = threshold
    if window_minutes is not None:
        rule.window_minutes = window_minutes
    if enabled is not None:
        rule.enabled = enabled

    return {"message": "Rule updated"}


# ═══ Dashboard Stats ═══

@app.get("/admin/dashboard")
async def dashboard_stats(db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(get_current_user)):
    """Overview stats for admin dashboard."""
    now = datetime.utcnow()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # Today's events
    events_today = await db.execute(
        select(func.count(EventLog.id)).where(EventLog.timestamp >= today)
    )
    # Today's security events
    security_today = await db.execute(
        select(func.count(SecurityLog.id)).where(SecurityLog.timestamp >= today)
    )
    # Today's LLM usage
    usage_today = await db.execute(
        select(
            func.count(LLMUsageLog.id),
            func.sum(LLMUsageLog.total_tokens),
            func.sum(LLMUsageLog.cost_usd),
        ).where(LLMUsageLog.created_at >= today)
    )
    usage_row = usage_today.one()

    # Open alerts
    open_alerts = await db.execute(
        select(func.count(Alert.id)).where(Alert.status == "open")
    )

    return {
        "events_today": events_today.scalar() or 0,
        "security_events_today": security_today.scalar() or 0,
        "llm_requests_today": usage_row[0] or 0,
        "tokens_today": usage_row[1] or 0,
        "cost_today_usd": float(usage_row[2]) if usage_row[2] else 0,
        "open_alerts": open_alerts.scalar() or 0,
        "timestamp": now.isoformat(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8005)
