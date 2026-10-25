"""Stable application error codes shared by RPC and Agent events."""
from __future__ import annotations

import httpx2


class AppError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def error_code(error: Exception, *, provider: bool = False) -> str:
    if isinstance(error, AppError):
        return error.code
    status = getattr(error, "status_code", None)
    if status in (401, 403):
        return "provider_auth"
    if status == 429:
        return "provider_rate_limit"
    if isinstance(error, (TimeoutError, httpx2.TimeoutException)):
        return "timeout"
    if provider:
        return "provider_request"
    return "invalid_input" if isinstance(error, (ValueError, KeyError, TypeError)) else "internal"
