from __future__ import annotations

import base64
import hashlib
import http.client
import json
import re
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
            if preview.get("composeJobId"):
                raise ValueError("此预览属于Compose任务，请从该任务整体确认发送")
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
        return self.preview(detail, edits or {}, override_url=override_url, owner_session=owner_session, owner_run=owner_run)

    def preview(self, detail: dict[str, Any], edits: dict[str, Any], *, override_url: str = "",
                owner_session: str | None = None, owner_run: str | None = None,
                route_info: dict[str, Any] | None = None, job_id: str | None = None) -> dict[str, Any]:
        if not isinstance(edits, dict) or set(edits)-{"url", "method", "headers", "body", "bodyBase64"}:
            raise ValueError("请求编辑仅支持url/method/headers/body/bodyBase64")
        target = str(edits.get("url") or override_url or detail.get("actualUrl") or detail["url"])
        parts = urlsplit(target)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None or parts.password is not None or parts.fragment or any(ord(c) < 33 for c in target):
            raise ValueError("目标必须是无凭据、片段或空白控制字符的HTTP(S) URL")
        _ = parts.port
        method = str(edits.get("method") or detail["method"]).upper()
        if not re.fullmatch(r"[A-Z]{1,32}", method) or method in {"CONNECT", "TRACE"}:
            raise ValueError("请使用常规HTTP方法；Compose不支持CONNECT/TRACE")
        headers = edits.get("headers", detail["requestHeaders"])
        if not isinstance(headers, list) or len(headers) > 200:
            raise ValueError("Header须为数组且不超过200项")
        normalized = []
        for pair in headers:
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise ValueError("Header必须为[name,value]数组，允许重复")
            name, value = map(str, pair)
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-zA-Z-]+", name) or any(c in value for c in "\r\n\x00"):
                raise ValueError("非法Header")
            try:
                value.encode("latin-1")
            except UnicodeEncodeError:
                raise ValueError("Header值需要HTTP可传输编码，请对非Latin-1文本显式编码") from None
            if len(name)+len(value) > 65536:
                raise ValueError("单个Header超过64KiB")
            if name.lower() not in ("host", "content-length", "transfer-encoding", "connection", "proxy-authorization", "proxy-connection", "x-ai-proxy-compose-action", "x-ai-proxy-idempotency-key"):
                normalized.append([name, value])
        request_id = detail.get("id") or ""
        if request_id and detail.get("requestTruncated") and not ({"body", "bodyBase64"} & edits.keys()):
            raise ValueError("原正文被截断，无法完整重放；请显式提供完整替换正文")
        body = self.store.body_bytes(request_id, "request") if request_id else None
        if "body" in edits and "bodyBase64" in edits:
            raise ValueError("正文文本与Base64不可同时指定")
        if "body" in edits:
            body = str(edits["body"]).encode()
        if "bodyBase64" in edits:
            body = base64.b64decode(edits["bodyBase64"], validate=True)
        if body is not None and len(body) > 5*1024*1024:
            raise ValueError("请求正文超过5MiB")
        route = route_info or {"mode": "direct"}
        wire = {"url": target, "method": method, "headers": normalized, "body": base64.b64encode(body).decode() if body is not None else None, "route": route}
        digest = hashlib.sha256(json.dumps(wire, sort_keys=True).encode()).hexdigest()
        preview = {"kind": "captured" if request_id else "new", "requestId": request_id or None, "requestVersion": detail.get("version", 0),
            "method": method, "url": self.redactor.url(target), "headers": self.redactor.headers(normalized),
            "bodySize": len(body or b""), "bodyPreview": self._preview_body(body.decode("utf-8", "replace") if body else None, next((v for k,v in normalized if k.lower()=="content-type"), "")),
            "wireHash": digest, "configHash": self.store.config_hash(), "ownerSessionId": owner_session, "ownerRunId": owner_run,
            "composeJobId": job_id, "route": {k:v for k,v in route.items() if k != "instance"},
            "changes": {"url": target != detail["url"], "method": method != detail["method"], "headers": normalized != detail["requestHeaders"], "body": bool(set(edits)&{"body", "bodyBase64"})},
            "boundary": "经过本地代理，使用当前已批准规则/弱网；HTTPS须已开启该Host解密。" if route["mode"] == "proxy" else "直连，不应用代理规则或弱网。",
            "_targetUrl": target, "_wire": wire}
        return self.store.save_replay_action(request_id, detail["batchId"], {"status": "preview", "request": preview, "idempotencyKey": new_id("send")})

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
