from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from mitmproxy import http


DEFAULT_PORTS = {"http": 80, "https": 443}
TEXTUAL_TYPES = ("text/", "json", "xml", "javascript", "x-www-form-urlencoded", "graphql")


def normalize_url_parts(url: str) -> tuple[str, str, int, str, str]:
    parts = urlsplit(url)
    scheme = parts.scheme.lower() or "https"
    host = (parts.hostname or "").lower()
    port = parts.port or DEFAULT_PORTS.get(scheme, 0)
    return scheme, host, port, parts.path or "/", parts.query


def source_matches(source: str, request: http.Request | str) -> bool:
    wildcard = source.endswith("*")
    base = source[:-1] if wildcard else source
    source_scheme, source_host, source_port, source_path, source_query = normalize_url_parts(base)
    request_url = request if isinstance(request, str) else request.pretty_url
    request_scheme, request_host, request_port, request_path, request_query = normalize_url_parts(request_url)
    if wildcard:
        prefix = urlunsplit((source_scheme, source_host + (f":{source_port}" if source_port not in (80, 443) else ""), source_path, "", ""))
        candidate = urlunsplit((request_scheme, request_host + (f":{request_port}" if request_port not in (80, 443) else ""), request_path, "", ""))
        return candidate.startswith(prefix)
    if (source_scheme, source_host, source_port, source_path) != (
        request_scheme,
        request_host,
        request_port,
        request_path,
    ):
        return False
    return not source_query or source_query == request_query


def first_rule(rules: list[dict[str, Any]], source: str, rule_type: str) -> dict[str, Any] | None:
    for rule in rules:
        if rule.get("enabled") and rule.get("type") == rule_type and source_matches(rule["source"], source):
            return rule
    return None


def remote_target_url(rule: dict[str, Any], request: http.Request) -> str:
    source = rule["source"]
    target = rule["target"]
    if not target:
        raise ValueError("Map Remote 缺少目标 URL")
    source_parts = urlsplit(source.rstrip("*"))
    request_parts = urlsplit(request.pretty_url)
    target_parts = urlsplit(target)
    if source.endswith("*"):
        source_path = source_parts.path.rstrip("/")
        request_path = request_parts.path or "/"
        suffix = request_path[len(source_path) :] if request_path.startswith(source_path) else ""
        if target_parts.path in ("", "/"):
            final_path = request_path
        else:
            final_path = target_parts.path.rstrip("/") + "/" + suffix.lstrip("/")
    else:
        final_path = target_parts.path or request_parts.path
    query = target_parts.query if target_parts.query else request_parts.query
    return urlunsplit(
        (
            target_parts.scheme,
            target_parts.netloc,
            final_path,
            query,
            "",
        )
    )


def apply_rewrite(
    rules: list[dict[str, Any]],
    url: str,
    phase: str,
    message: http.Message,
) -> list[str]:
    applied: list[str] = []
    for rule in rules:
        if (
            not rule.get("enabled")
            or rule.get("type") != "rewrite"
            or rule.get("phase") != phase
            or not source_matches(rule["source"], url)
        ):
            continue
        part = rule.get("part")
        action = rule.get("action")
        if part == "header":
            name = rule.get("headerName") or ""
            if not name:
                continue
            if action == "delete":
                message.headers.pop(name, None)
            else:
                message.headers[name] = rule.get("headerValue") or ""
            applied.append(rule["id"])
        elif part == "body" and action == "replace":
            content_type = message.headers.get("content-type", "").lower()
            length = len(message.get_content() or b"")
            if length > 5 * 1024 * 1024:
                continue
            if not any(token in content_type for token in TEXTUAL_TYPES):
                continue
            try:
                text = message.get_text(strict=True)
            except UnicodeDecodeError:
                continue
            search = rule.get("search") or ""
            if not search or search not in text:
                continue
            message.set_text(text.replace(search, rule.get("replace") or ""))
            for header in ("etag", "content-md5", "last-modified"):
                message.headers.pop(header, None)
            applied.append(rule["id"])
    return applied


def apply_map_local(flow: http.HTTPFlow, rules: list[dict[str, Any]]) -> str | None:
    rule = first_rule(rules, flow.request.pretty_url, "local")
    if rule is None:
        return None
    path = rule.get("filePath")
    if not path:
        raise ValueError("Map Local 未选择文件")
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"本地文件不存在: {file_path}")
    content = file_path.read_bytes()
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    flow.response = http.Response.make(
        200,
        content,
        {
            "Content-Type": content_type,
            "X-AI-Proxy-Map": "local",
            "Cache-Control": "no-store",
        },
    )
    return rule["id"]


def apply_map_remote(flow: http.HTTPFlow, rules: list[dict[str, Any]]) -> str | None:
    rule = first_rule(rules, flow.request.pretty_url, "remote")
    if rule is None:
        return None
    target_url = remote_target_url(rule, flow.request)
    flow.request.url = target_url
    flow.request.headers["Host"] = urlsplit(target_url).netloc
    return rule["id"]
