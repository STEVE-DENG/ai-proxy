from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


SECRET_HEADER_PARTS = (
    "authorization",
    "cookie",
    "token",
    "api-key",
    "x-api-key",
    "secret",
    "session",
    "password",
    "passwd",
    "credential",
)

SENSITIVE_FIELD_PARTS = (
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "session",
    "credential",
    "phone",
    "mobile",
    "email",
    "mail",
    "id_card",
    "idcard",
    "card_no",
    "account",
    "address",
    "address_id",
    "addressid",
)

_PHONE = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)")
_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_BEARER = re.compile(r"\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)", re.IGNORECASE)
_LONG_SECRET = re.compile(r"\b[A-Za-z0-9_-]{28,}\b")


class Redactor:
    """Deterministic redaction shared by tools, UI details and report exports."""

    def __init__(self, salt: str) -> None:
        self._salt = salt.encode("utf-8")

    def stable(self, value: str) -> str:
        if re.fullmatch(r"\[redacted:[a-f0-9]{12}\]", value):
            return value
        digest = hashlib.sha256(self._salt + value.encode("utf-8")).hexdigest()[:12]
        return f"[redacted:{digest}]"

    def text(self, value: str, field_name: str = "") -> str:
        if not value:
            return value
        if _is_sensitive_key(field_name):
            return self.stable(value)
        try:
            parsed = json.loads(value)
            if isinstance(parsed, (dict, list)):
                return json.dumps(self.value(parsed), ensure_ascii=False)
        except (ValueError, TypeError):
            pass
        value = re.sub(
            r'(?i)([\w.-]+)(["\x27]?\s*[=:]\s*)("[^"\n]*"|\x27[^\x27\n]*\x27|[^\s&,;}]+)',
            lambda m: m[1] + m[2] + (self.stable(m[3]) if _is_sensitive_key(m[1]) else m[3]),
            value,
        )
        redacted = _BEARER.sub(lambda match: f"{match.group(1)} {self.stable(match.group(2))}", value)
        redacted = _PHONE.sub(lambda match: self.stable(match.group(0)), redacted)
        redacted = _EMAIL.sub(lambda match: self.stable(match.group(0)), redacted)
        redacted = _LONG_SECRET.sub(lambda match: self.stable(match.group(0)), redacted)
        return redacted

    def headers(self, headers: list[list[str]] | list[tuple[str, str]]) -> list[list[str]]:
        result: list[list[str]] = []
        for pair in headers:
            if len(pair) < 2:
                continue
            name, value = str(pair[0]), str(pair[1])
            result.append([name, self.stable(value) if _is_sensitive_key(name) else self.text(value, name)])
        return result

    def url(self, url: str) -> str:
        try:
            parts = urlsplit(url)
            query = []
            for key, value in parse_qsl(parts.query, keep_blank_values=True):
                query.append((key, self.stable(value) if _is_sensitive_key(key) else self.text(value, key)))
            host = parts.netloc.rsplit("@", 1)[-1]
            return urlunsplit((parts.scheme, host, self.text(parts.path), urlencode(query), ""))
        except Exception:
            return self.text(url)

    def value(self, value: Any, field_name: str = "", depth: int = 0) -> Any:
        if depth > 12:
            return "[depth-limit]"
        if _is_sensitive_key(field_name):
            if value is None or value == "":
                return value
            return self.stable(str(value))
        if isinstance(value, dict):
            return {str(key): self.value(item, str(key), depth + 1) for key, item in value.items()}
        if isinstance(value, list):
            return [self.value(item, field_name, depth + 1) for item in value]
        if isinstance(value, str):
            return self.text(value, field_name)
        return value

    def body(self, text: str | None, content_type: str = "") -> Any:
        if text is None:
            return None
        content_type = content_type.lower()
        if "json" in content_type or text.lstrip().startswith(("{", "[")):
            try:
                return self.value(json.loads(text))
            except (json.JSONDecodeError, TypeError):
                pass
        if "x-www-form-urlencoded" in content_type:
            try:
                pairs = parse_qsl(text, keep_blank_values=True)
                return {
                    key: self.stable(value) if _is_sensitive_key(key) else self.text(value, key)
                    for key, value in pairs
                }
            except ValueError:
                pass
        return self.text(text)


def _is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in SENSITIVE_FIELD_PARTS) or any(
        part in normalized for part in SECRET_HEADER_PARTS
    )


def masked_value(redactor: Redactor, value: Any, field_name: str = "") -> Any:
    return redactor.value(value, field_name)
