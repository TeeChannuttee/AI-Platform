"""
Security utilities: password hashing, SSRF guard, API key generation.
"""
import hashlib
import ipaddress
import secrets
from urllib.parse import urlparse
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

ph = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=4,
    hash_len=32,
    salt_len=16,
)


def hash_password(password: str) -> str:
    """Hash password using Argon2id."""
    return ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    """Verify password against Argon2id hash."""
    try:
        return ph.verify(hashed, password)
    except VerifyMismatchError:
        return False


def needs_rehash(hashed: str) -> bool:
    """Check if hash uses outdated Argon2id parameters and should be re-hashed."""
    return ph.check_needs_rehash(hashed)


def hash_token(token: str) -> str:
    """SHA-256 hash for refresh tokens and API keys."""
    return hashlib.sha256(token.encode()).hexdigest()


def generate_api_key() -> tuple[str, str]:
    """Generate a new API key. Returns (plaintext_key, key_prefix)."""
    key = f"aip_{secrets.token_urlsafe(48)}"
    prefix = key[:12]
    return key, prefix


def generate_invite_token() -> tuple[str, str]:
    """Generate an invite token. Returns (plaintext_token, token_hash).
    Plaintext is revealed ONCE to the admin; only hash is stored."""
    token = f"inv_{secrets.token_urlsafe(32)}"
    return token, hash_token(token)


# ─── SSRF Guard ───

BLOCKED_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),  # IPv6 private
    ipaddress.ip_network("fe80::/10"),  # IPv6 link-local
]


def check_ssrf(url: str) -> bool:
    """
    Returns True if the URL is safe (not targeting internal networks).
    Returns False if the URL targets a blocked network.
    Resolves DNS for hostnames and checks all resolved IPs.
    """
    import socket

    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return False

        # Block well-known internal/metadata hostnames first
        blocked_hosts = {"localhost", "metadata.google.internal", "169.254.169.254"}
        if hostname.lower() in blocked_hosts:
            return False

        # Try parsing as IP directly
        try:
            ip = ipaddress.ip_address(hostname)
            for network in BLOCKED_NETWORKS:
                if ip in network:
                    return False
            return True
        except ValueError:
            pass  # Not an IP — resolve DNS

        # Resolve DNS → check ALL returned IPs
        try:
            addr_infos = socket.getaddrinfo(hostname, None)
            for addr_info in addr_infos:
                ip_str = addr_info[4][0]
                ip = ipaddress.ip_address(ip_str)
                for network in BLOCKED_NETWORKS:
                    if ip in network:
                        return False  # Resolves to internal IP → blocked
        except socket.gaierror:
            return False  # DNS resolution failed → block (safe default)

        return True
    except Exception:
        return False
