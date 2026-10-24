from __future__ import annotations

import base64
import hashlib
import http.client
import json
import ssl
from typing import Any
from urllib.parse import urlsplit

from .store import new_id, now_ms


class ReplayService:
    def __init__(self, domain) -> None:
        self.domain = domain
        self.store = domain.store
        self.redactor = domain.redactor

    def _preview_body(self, text: str | None, content_type: str) -> Any:
        value = self.redactor.body(text, content_type)
        serialized = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        if len(serialized) > 16000:
            return {"preview": serialized[:16000], "previewTruncated": True, "redactedChars": len(serialized)}
        return value

    def replay(self, request_id: str, *, execute: bool = False, override_url: str = "", action_id: str | None = None, edits: dict[str, Any] | None = None, owner_session: str | None = None, owner_run: str | None = None) -> dict[str, Any]:
        detail = self.store.request_detail(request_id, preview_chars=0)
        if execute:
            if not action_id:
                raise ValueError("请先预览，再确认发送")
            action = self.store.get_replay_action(action_id, internal=True)
            preview = action["request"]
            if action["requestId"] != request_id:
                raise ValueError("预览与请求不匹配")
            if owner_session and (preview.get("ownerSessionId") != owner_session or preview.get("ownerRunId") != owner_run):
                raise ValueError("预览不属于本会话和 Run")
            if edits or override_url and override_url != preview.get("_targetUrl"):
                raise ValueError("发送内容已变化，请重新预览")
            if action["status"] != "preview":
                return self.store.get_replay_action(action_id)
            if detail["version"] != preview["requestVersion"] or preview["configHash"] != self.store.config_hash():
                return self.store.save_replay_action(request_id, detail["batchId"], {**action, "status": "conflict", "response": {"error": "请求或环境配置已变化，请重新预览"}})
            if not self.store.claim_replay_action(action_id):
                return self.store.get_replay_action(action_id)
            return self._send(detail, action)
        if action_id:
            action = self.store.get_replay_action(action_id)
            if action["requestId"] != request_id:
                raise ValueError("预览与请求不匹配")
            return action
        edits = dict(edits or {})
        target = str(edits.get("url") or override_url or detail.get("actualUrl") or detail["url"])
        parts = urlsplit(target)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username:
            raise ValueError("重放目标必须是无内嵌凭据的 HTTP(S) URL")
        method = str(edits.get("method") or detail["method"]).upper()
        if not method.isalpha():
            raise ValueError("非法 HTTP 方法")
        headers = edits.get("headers", detail["requestHeaders"])
        normalized = []
        for pair in headers:
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise ValueError("Header 必须为 [name, value] 数组，允许重复")
            name, value = map(str, pair)
            if any(c in name + value for c in "\r\n") or ":" in name or not name:
                raise ValueError("非法 Header")
            if name.lower() not in ("host", "content-length", "transfer-encoding", "connection"):
                normalized.append([name, value])
        body = self.store.body_bytes(request_id, "request")
        if "body" in edits:
            body = str(edits["body"]).encode()
        if "bodyBase64" in edits:
            body = base64.b64decode(edits["bodyBase64"], validate=True)
        if body is not None and len(body) > 5 * 1024 * 1024:
            raise ValueError("重放正文超过 5 MiB")
        key = new_id("replay")
        wire = {"url": target, "method": method, "headers": normalized, "body": base64.b64encode(body).decode() if body is not None else None}
        digest = hashlib.sha256(json.dumps(wire, sort_keys=True).encode()).hexdigest()
        preview = {
            "requestId": request_id, "requestVersion": detail["version"], "method": method,
            "url": self.redactor.url(target), "headers": self.redactor.headers(normalized),
            "bodySize": len(body or b""), "bodyPreview": self._preview_body(body.decode("utf-8", "replace") if body else None, next((v for k, v in normalized if k.lower() == "content-type"), "")),
            "wireHash": digest, "configHash": self.store.config_hash(), "ownerSessionId": owner_session, "ownerRunId": owner_run,
            "changes": {"url": target != detail["url"], "method": method != detail["method"], "headers": normalized != detail["requestHeaders"], "body": bool(set(edits) & {"body", "bodyBase64"})},
            "boundary": "直接发送，不应用代理规则或弱网；不跟随重定向，不自动重试。可能产生真实业务写入。",
            "_targetUrl": target, "_wire": wire,
        }
        return self.store.save_replay_action(request_id, detail["batchId"], {"status": "preview", "request": preview, "idempotencyKey": key})

    def _send(self, detail: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        wire = action["request"]["_wire"]
        parts = urlsplit(wire["url"])
        connection = http.client.HTTPSConnection(parts.hostname, parts.port, timeout=30, context=ssl.create_default_context()) if parts.scheme == "https" else http.client.HTTPConnection(parts.hostname, parts.port, timeout=30)
        started = now_ms()
        response_body = None
        response_headers = []
        status_code = None
        error_text = None
        result: dict[str, Any] = {}
        status = "unknown"
        body = base64.b64decode(wire["body"]) if wire.get("body") is not None else None
        try:
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
            connection.putrequest(wire["method"], path, skip_accept_encoding=True)
            for name, value in wire["headers"]:
                connection.putheader(name, value)
            connection.putheader("X-AI-Proxy-Idempotency-Key", action["idempotencyKey"])
            if body is not None:
                connection.putheader("Content-Length", str(len(body)))
            connection.endheaders(body)
            response = connection.getresponse()
            status_code = response.status
            response_headers = [list(pair) for pair in response.getheaders()]
            response_body = response.read(5 * 1024 * 1024 + 1)
            content_type = next((v for k, v in response_headers if k.lower() == "content-type"), "")
            result = {"status": status_code, "headers": self.redactor.headers(response_headers), "body": self._preview_body(response_body[:5*1024*1024].decode("utf-8", "replace"), content_type), "truncated": len(response_body) > 5 * 1024 * 1024}
            status = "completed"
        except Exception as error:
            error_text = str(error)
            result = {"error": self.redactor.text(error_text), "resultUnknown": True, "message": "请求可能已到达服务端，请人工核对；不会自动重试"}
        finally:
            connection.close()
        captured = None
        try:
            captured = self.store.save_request({
                "id": new_id("req"), "batch_id": detail["batchId"], "sequence": now_ms(), "method": wire["method"], "scheme": parts.scheme, "host": parts.hostname, "port": parts.port or (443 if parts.scheme == "https" else 80),
                "path": (parts.path or "/") + ("?" + parts.query if parts.query else ""), "url": wire["url"], "status": status_code, "content_type": next((v for k, v in response_headers if k.lower() == "content-type"), ""),
                "started_at": started, "finished_at": now_ms(), "duration_ms": now_ms()-started, "size": len(response_body or b""), "source_ip": "manual-replay", "request_state": "completed" if status == "completed" else "failed",
                "request_headers": wire["headers"], "response_headers": response_headers, "request_body": body, "response_body": response_body, "error": error_text,
                "request_body_state": "available" if body else "empty", "response_body_state": "available" if response_body is not None else "missing",
                "rule_evidence": {"replayOf": detail["id"], "actionId": action["id"], "rulesApplied": False, "throttleApplied": False},
                "environment": detail.get("environment"), "app_version": detail.get("appVersion"), "build_number": detail.get("buildNumber"),
            })
        except Exception as error:
            result["captureError"] = self.redactor.text(str(error))
            result["notice"] = "发送已执行，抓包保存失败；请核对动作历史，不自动重试"

        if captured:
            self.domain.emit("capture:request", captured)
        return self.store.save_replay_action(detail["id"], detail["batchId"], {**action, "status": status, "response": {**result, "capturedRequestId": captured["id"] if captured else None, "durationMs": now_ms()-started}, "finishedAt": now_ms()})
