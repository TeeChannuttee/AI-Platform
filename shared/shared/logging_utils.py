"""
Structured logging with trace_id propagation.
"""
import uuid
import logging
import json
from datetime import datetime, timezone
from contextvars import ContextVar

# Context variable for trace_id propagation across async calls
trace_id_var: ContextVar[str] = ContextVar("trace_id", default="")


def get_trace_id() -> str:
    """Get or generate a trace_id for the current request."""
    tid = trace_id_var.get()
    if not tid:
        tid = str(uuid.uuid4())
        trace_id_var.set(tid)
    return tid


def set_trace_id(tid: str):
    trace_id_var.set(tid)


class JSONFormatter(logging.Formatter):
    """Structured JSON log format for centralized log aggregation.
    Every log line includes service name, version, and trace_id for
    cross-service traceability (Cross-cutting Concern)."""

    def __init__(self, service_name: str = "unknown", service_version: str = "1.0.0"):
        super().__init__()
        self.service_name = service_name
        self.service_version = service_version

    def format(self, record):
        log_obj = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "service": self.service_name,
            "version": self.service_version,
            "logger": record.name,
            "message": record.getMessage(),
            "trace_id": trace_id_var.get(""),
        }
        if record.exc_info:
            log_obj["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_obj)


def setup_logger(name: str, level: str = "INFO", service_version: str = "1.0.0") -> logging.Logger:
    """Create a structured JSON logger.
    All services MUST send logs to the centralized Monitoring Service.
    Every log entry carries trace_id + service name + version."""
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(JSONFormatter(service_name=name, service_version=service_version))
        logger.addHandler(handler)
    return logger
