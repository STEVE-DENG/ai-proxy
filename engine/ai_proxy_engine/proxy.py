from __future__ import annotations

import asyncio
import contextlib
import codecs
import hashlib
import html
import json
import logging
import mimetypes
import plistlib
import socket
import ssl
import subprocess
import time
import uuid
from queue import Full, Queue
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from mitmproxy import http, options
from mitmproxy.addons import proxyserver
from mitmproxy.tools import dump

from .domain import parse_trace_context
from .rules import apply_map_local, apply_map_remote, apply_rewrite, first_rule
from .store import Store, new_id, now_ms
from .throttle import Throttle
from .connections import Connections

logger = logging.getLogger(__name__)


class ProxyAddon:
    def __init__(
        self,
        store: Store,
        throttle: Throttle,
        emit: Callable[[str, dict[str, Any]], None],
    ) -> None:
        self.store = store
        self.throttle = throttle
        self.emit = emit
        self.recording = True
        self.rules: list[dict[str, Any]] = store.list_rules()
        self.decrypt_hosts: set[str] = set()
        self.client_ports: dict[int, str] = {}
        self.request_count = 0
        self.sequence = 0
        self.capture_loss = 0
        self.failed_writes = 0
        self.queue_drops = 0
        self.last_record_loss_reason: str | None = None
        self.last_persisted_at: int | None = None
        self.last_persist_error: dict[str, Any] | None = None
        self.timeout_settings = {"requestTimeoutSeconds": 120, "streamIdleTimeoutSeconds": 120, "http2Enabled": True}
        self.last_tls_error: str | None = None
        self.connections: Connections | None = None
        self.active_flows: dict[str, http.HTTPFlow] = {}
        self.client_writers: dict[int, asyncio.StreamWriter] = {}
        self.client_activity: dict[int, float] = {}
        self._snapshot_key: tuple | None = None
        self._config_snapshot: dict[str, Any] = {}
        self._environment_snapshot: dict[str, Any] = {}
        self.persist_outcomes: dict[str, str] = {}
        self.compose_tokens: dict[str, dict[str, Any]] = {}
        self.record_queue: Queue[dict[str, Any] | None] = Queue(maxsize=1000)
        self.record_thread = __import__("threading").Thread(
            target=self._record_worker, name="capture-record-writer", daemon=True
        )
        self.record_thread.start()

    def _persist_outcome(self, request_id: str, state: str) -> None:
        # Bounded metadata; no captured content. Older missing rows remain unknown.
        self.persist_outcomes[request_id] = state
        if len(self.persist_outcomes) > 1000:
            self.persist_outcomes.pop(next(iter(self.persist_outcomes)), None)

    def _record_worker(self) -> None:
        while True:
            item = self.record_queue.get()
            if item is None:
                self.record_queue.task_done()
                return
            try:
                summary = self.store.save_request(item)
                if item.get("request_state") != "in_progress":
                    self._persist_outcome(item["id"], "saved")
                self.last_persisted_at = now_ms()
                self.emit("capture:request", summary)
            except Exception as error:
                logger.exception("Failed to persist captured request")
                self.capture_loss += 1
                if item.get("request_state") != "in_progress":
                    self._persist_outcome(item["id"], "failed")
                self.failed_writes += 1
                self.last_record_loss_reason = "persist-failed"
                self.last_persist_error = {"at": now_ms(), "code": type(error).__name__}
                self.emit(
                    "capture:record-loss",
                    {"reason": "persist-failed", "total": self.capture_loss, "requestId": item.get("id"),
                     "final": item.get("request_state") != "in_progress", "errorType": type(error).__name__},
                )
            finally:
                self.record_queue.task_done()

    def flush_records(self) -> None:
        with contextlib.suppress(Exception):
            self.record_queue.join()

    def close(self) -> None:
        with contextlib.suppress(Full):
            self.record_queue.put_nowait(None)
        self.record_thread.join(timeout=3)

    def refresh_rules(self) -> None:
        self.rules = self.store.list_rules()

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        if flow.request.host.lower() == "ai-proxy.test" or flow.request.method == "CONNECT":
            return
        self._prepare_flow(flow)
        flow.metadata["ai_proxy_activity"] = time.monotonic()
        policy = dict(self.timeout_settings)
        flow.metadata["ai_proxy_timeout_settings"] = policy
        flow.metadata["ai_proxy_deadline"] = time.monotonic() + policy["requestTimeoutSeconds"]
        self.active_flows[flow.id] = flow
        self._record(flow, final=False)

    def interrupt(self, flow: http.HTTPFlow, message: str) -> None:
        flow.metadata["ai_proxy_error"] = message
        flow.metadata["ai_proxy_recorded_final"] = False
        peer = flow.client_conn.peername
        writer = self.client_writers.get(peer[1]) if peer else None
        if writer:
            writer.close()
        if flow.killable:
            flow.kill()
        self._record(flow, final=True)
        self.active_flows.pop(flow.id, None)

    async def watch_timeouts(self) -> None:
        while True:
            await asyncio.sleep(1)
            if self.connections:
                self.connections.check_lifecycle()
            stamp = time.monotonic()
            for flow in list(self.active_flows.values()):
                streaming = bool(flow.metadata.get("ai_proxy_streamed") or flow.websocket)
                activity = flow.metadata.get("ai_proxy_activity", stamp)
                if flow.websocket and flow.client_conn.peername:
                    activity = self.client_activity.get(flow.client_conn.peername[1], activity)
                policy = flow.metadata.get("ai_proxy_timeout_settings", self.timeout_settings)
                seconds = policy["streamIdleTimeoutSeconds"] if streaming else policy["requestTimeoutSeconds"]
                deadline = activity + seconds if streaming else flow.metadata.get("ai_proxy_deadline", stamp + seconds)
                if stamp >= deadline:
                    shared = "；关闭承载连接，HTTP/2并行请求可能同时中断" if flow.request.http_version == "HTTP/2.0" else ""
                    self.interrupt(flow, (f"请求超时：流连接连续 {seconds} 秒无数据" if streaming else f"请求超时：{seconds} 秒内未完成响应") + shared)

    def interrupt_all(self) -> None:
        for flow in list(self.active_flows.values()):
            self.interrupt(flow, "采集已停止，连接中断")

    def add_decrypt_host(self, host: str) -> None:
        self.decrypt_hosts.add(host.lower().lstrip("."))

    def remove_decrypt_host(self, host: str) -> None:
        self.decrypt_hosts.discard(host.lower().lstrip("."))

    def _should_decrypt(self, host: str | None) -> bool:
        if not host:
            return False
        host = host.lower()
        if "*" in self.decrypt_hosts:
            return True
        if host in self.decrypt_hosts:
            return True
        return any(
            pattern.startswith("*.")
            and host.endswith(pattern[1:])
            and host.count(".") == pattern.count(".")
            for pattern in self.decrypt_hosts
        )

    def tls_clienthello(self, data) -> None:
        host = (data.client_hello.sni or "").lower()
        if host == "ai-proxy.test" and self._should_decrypt(host):
            # The local challenge has no upstream server or public DNS record.
            data.establish_server_tls_first = False
        if not self._should_decrypt(host):
            data.ignore_connection = True

    def _prepare_flow(self, flow: http.HTTPFlow) -> None:
        if "ai_proxy_id" in flow.metadata:
            return
        request = flow.request
        self.sequence += 1
        self.request_count += 1
        batch = self.store.get_current_batch()
        flow.metadata["ai_proxy_id"] = new_id("req")
        flow.metadata["ai_proxy_generation"] = self.store.capture_generation
        flow.metadata["ai_proxy_started"] = now_ms()
        flow.metadata["ai_proxy_batch"] = batch["id"]
        compose_token = request.headers.pop("X-AI-Proxy-Compose-Action", None)
        compose = self.compose_tokens.pop(compose_token, None) if compose_token else None
        if compose:
            flow.metadata["ai_proxy_compose"] = {key: value for key, value in compose.items() if key != "capturedRequestId"}
            flow.metadata["ai_proxy_batch"] = compose["batchId"]
            compose["capturedRequestId"] = flow.metadata["ai_proxy_id"]
        flow.metadata["ai_proxy_start_sequence"] = self.sequence
        peer = flow.client_conn.peername
        flow.metadata["ai_proxy_peer"] = f"{peer[0]}:{peer[1]}" if peer else ""
        flow.metadata["ai_proxy_connection"] = str(
            getattr(flow.client_conn, "id", None) or f"{peer[0]}:{peer[1]}" if peer else new_id("conn")
        )
        version = self.store.config_version()
        environment_id = self.store.get_setting("active_environment")
        throttle = self.throttle.status()
        snapshot_key = (version, environment_id, json.dumps(throttle, sort_keys=True))
        if snapshot_key != self._snapshot_key:
            self._config_snapshot = {"configVersion": version, "configHash": self.store.config_hash(), "rules": self.rules, "throttle": throttle, "businessRules": self.store.list_configs("business_rule"), "environmentId": environment_id}
            environment_item = next((item for item in self.store.list_configs("environment") if item["id"] == environment_id), None)
            self._environment_snapshot = ({**environment_item["config"], "name": environment_item["name"]} if environment_item else {})
            self._snapshot_key = snapshot_key
        flow.metadata["ai_proxy_config_snapshot"] = self._config_snapshot
        flow.metadata["ai_proxy_environment"] = self._environment_snapshot
        flow.metadata["ai_proxy_capture_sse"] = self.store.get_setting("capture_stream_events", "false") == "true"
        flow.metadata["ai_proxy_capture_websocket"] = self.store.get_setting("capture_websocket_frames", "false") == "true"
        flow.metadata["ai_proxy_request_body_before"] = _body_fingerprint(request)
        flow.metadata["ai_proxy_request_headers_original"] = list(request.headers.items(multi=True))
        if request.method == "CONNECT":
            port = request.port or 443
            authority = request.host if port == 443 else f"{request.host}:{port}"
            flow.metadata["ai_proxy_original_url"] = f"https://{authority}/"
        else:
            flow.metadata["ai_proxy_original_url"] = request.pretty_url
        trace = parse_trace_context(list(request.headers.items(multi=True)))
        flow.metadata["ai_proxy_trace"] = trace

    def http_connect(self, flow: http.HTTPFlow) -> None:
        if self._should_decrypt(flow.request.host):
            return
        self._prepare_flow(flow)
        self._record(flow, final=True)

    async def request(self, flow: http.HTTPFlow) -> None:
        if flow.request.host.lower() == "ai-proxy.test":
            flow.metadata["ai_proxy_diagnostic"] = True
            local = flow.client_conn.peername
            address = self.client_ports.get(local[1], "127.0.0.1") if local else "127.0.0.1"
            layer = "https" if flow.request.scheme == "https" else "http"
            ok = bool(self.connections and self.connections.evidence(layer, flow.request.pretty_url, address))
            body = "验证成功。请返回 Mac 查看对应层级结果。" if ok else "验证已过期或设备不匹配。请在 Mac 重新生成配对二维码。"
            flow.response = http.Response.make(200 if ok else 410, ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><p>" + body).encode(), {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"})
            return
        self._prepare_flow(flow)
        flow.metadata["ai_proxy_request_body_before"] = _body_fingerprint(flow.request)
        host = (flow.request.host or "").lower()
        rules = flow.metadata["ai_proxy_config_snapshot"]["rules"]
        throttle = flow.metadata["ai_proxy_config_snapshot"]["throttle"]
        if throttle.get("enabled") and throttle.get("latencyMs"):
            await asyncio.sleep(throttle["latencyMs"] / 1000)
        if flow.request.method == "CONNECT":
            return
        flow.metadata["ai_proxy_request_finished"] = now_ms()
        try:
            applied = apply_rewrite(
                rules,
                flow.metadata["ai_proxy_original_url"],
                "request",
                flow.request,
            )
            local_rule = first_rule(rules, flow.request.pretty_url, "local")
            if local_rule and local_rule.get("delayMs"):
                await asyncio.sleep(min(int(local_rule["delayMs"]), 60000) / 1000)
            if local_rule and local_rule.get("disconnect"):
                flow.metadata["ai_proxy_matched_rule"] = local_rule["id"]
                flow.metadata["ai_proxy_error"] = "人工故障场景：连接中断"
                flow.kill()
                self._record(flow, final=True)
                return
            matched_local = apply_map_local(flow, rules)
            if matched_local:
                flow.metadata["ai_proxy_matched_rule"] = matched_local
            else:
                matched_remote = apply_map_remote(flow, rules)
                if matched_remote:
                    flow.metadata["ai_proxy_matched_rule"] = matched_remote
                    flow.metadata["ai_proxy_actual_url"] = flow.request.pretty_url
            if applied:
                flow.metadata["ai_proxy_rewrites"] = applied
        except Exception as error:
            flow.metadata["ai_proxy_rule_error"] = str(error)
            logger.warning("Rule error for %s: %s", flow.request.pretty_url, error)
        self._record(flow, final=False)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        if not flow.response:
            return
        flow.metadata["ai_proxy_response_headers"] = now_ms()
        flow.metadata["ai_proxy_activity"] = time.monotonic()
        # This hook runs before the response rewrite hook. Keep an immutable
        # copy so rule evidence can show the actual upstream Header.
        flow.metadata["ai_proxy_response_headers_original"] = list(
            flow.response.headers.items(multi=True)
        )
        content_type = flow.response.headers.get("content-type", "").lower()
        length = flow.response.headers.get("content-length")
        too_large = False
        if length:
            try:
                too_large = int(length) > 5 * 1024 * 1024
            except ValueError:
                too_large = False
        if too_large:
            flow.metadata["ai_proxy_body_too_large"] = True
        if "text/event-stream" in content_type or too_large:
            flow.response.stream = True
            flow.metadata["ai_proxy_streamed"] = True
            def observe_chunk(chunk: bytes) -> bytes:
                if chunk:
                    flow.metadata["ai_proxy_activity"] = time.monotonic()
                return chunk
            flow.response.stream = observe_chunk
            if "text/event-stream" in content_type and flow.metadata.get("ai_proxy_capture_sse"):
                state = {"events": [], "bytesObserved": 0, "bytesSaved": 0, "limited": False, "complete": False, "startedAt": now_ms()}
                flow.metadata["ai_proxy_sse"] = state
                decoder = codecs.getincrementaldecoder("utf-8")("replace")
                pending = ""
                previous_at = None
                def stream_chunk(chunk: bytes) -> bytes:
                    nonlocal pending, previous_at
                    if chunk:
                        flow.metadata["ai_proxy_activity"] = time.monotonic()
                    state["bytesObserved"] += len(chunk)
                    if state["bytesSaved"] + len(chunk) <= 256 * 1024 and len(state["events"]) < 500:
                        state["bytesSaved"] += len(chunk)
                        pending += decoder.decode(chunk, final=not chunk)
                        pending = pending.replace("\r\n", "\n")
                        while "\n\n" in pending and len(state["events"]) < 500:
                            block, pending = pending.split("\n\n", 1)
                            data = "\n".join(line[5:].lstrip(" ") for line in block.split("\n") if line.startswith("data:"))
                            if not any(line.startswith("data:") for line in block.split("\n")):
                                continue
                            stamp = now_ms()
                            state["events"].append({"time": stamp, "sinceHeadersMs": stamp-state["startedAt"], "intervalMs": stamp-previous_at if previous_at else None, "event": next((line[6:].strip() for line in block.split("\n") if line.startswith("event:")), "message"), "data": data, "id": next((line[3:].strip() for line in block.split("\n") if line.startswith("id:")), None), "endMarker": data.strip() == "[DONE]"})
                            previous_at = stamp
                    else:
                        state["limited"] = True
                    if len(state["events"]) >= 500 and pending.strip():
                        state["limited"] = True
                    if not chunk:
                        state["complete"] = not state["limited"] and not pending.strip()
                        state["endedAt"] = now_ms()
                        state["pendingFragment"] = bool(pending.strip())
                    return chunk
                flow.response.stream = stream_chunk

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.metadata.get("ai_proxy_diagnostic"):
            return
        if not flow.response:
            return
        flow.metadata["ai_proxy_response_body_before"] = _body_fingerprint(flow.response)
        try:
            applied = apply_rewrite(
                flow.metadata.get("ai_proxy_config_snapshot", {}).get("rules", self.rules),
                flow.metadata.get("ai_proxy_original_url", flow.request.pretty_url),
                "response",
                flow.response,
            )
            if applied:
                flow.metadata.setdefault("ai_proxy_rewrites", []).extend(applied)
        except Exception as error:
            flow.metadata["ai_proxy_rule_error"] = str(error)
            logger.warning("Response rewrite error: %s", error)
        self._record(flow, final=True)

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        flow.metadata["ai_proxy_activity"] = time.monotonic()
        if not flow.websocket or not flow.metadata.get("ai_proxy_capture_websocket"):
            return
        state = flow.metadata.setdefault("ai_proxy_websocket", {"frames": [], "bytesObserved": 0, "bytesSaved": 0, "limited": False, "startedAt": now_ms()})
        was_limited = state["limited"]
        message = flow.websocket.messages[-1]
        data = message.content
        state["bytesObserved"] += len(data)
        if len(state["frames"]) < 500 and state["bytesSaved"] + len(data) <= 256 * 1024:
            state["bytesSaved"] += len(data)
            state["frames"].append({"direction": "request" if message.from_client else "response", "time": int(message.timestamp * 1000), "opcode": int(message.type), "size": len(data), "text": data.decode("utf-8", "replace") if int(message.type) == 1 else None, "sha256": hashlib.sha256(data).hexdigest(), "binary": int(message.type) != 1})
        else:
            state["limited"] = True
        stamp = time.monotonic()
        if stamp - flow.metadata.get("ai_proxy_ws_checkpoint", 0) < 1 and was_limited == state["limited"]:
            return
        flow.metadata["ai_proxy_ws_checkpoint"] = stamp
        flow.metadata["ai_proxy_recorded_final"] = False
        self._record(flow, final=True)

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self.active_flows.pop(flow.id, None)
        state = flow.metadata.get("ai_proxy_websocket")
        if state is not None and flow.websocket:
            state.update(endedAt=now_ms(), closeCode=flow.websocket.close_code, closeReason=flow.websocket.close_reason, complete=not state["limited"])
            flow.metadata["ai_proxy_recorded_final"] = False
            self._record(flow, final=True)

    def error(self, flow: http.HTTPFlow) -> None:
        if flow.error:
            flow.metadata.setdefault("ai_proxy_error", flow.error.msg)
            if "tls" in flow.metadata["ai_proxy_error"].lower() or "certificate" in flow.metadata["ai_proxy_error"].lower():
                self.last_tls_error = flow.metadata["ai_proxy_error"]
                flow.metadata["ai_proxy_tls_error"] = self.last_tls_error
                self.emit(
                    "capture:tls-error",
                    {
                        "host": flow.request.host,
                        "message": self.last_tls_error,
                        "url": flow.request.pretty_url,
                    },
                )
        self._prepare_flow(flow)
        self._record(flow, final=True)

    def _record(self, flow: http.HTTPFlow, *, final: bool) -> None:
        if flow.metadata.get("ai_proxy_diagnostic"):
            return
        if final and (not flow.websocket or flow.error):
            self.active_flows.pop(flow.id, None)
        progress_recorded = bool(flow.metadata.get("ai_proxy_recorded_progress"))
        if final and flow.metadata.get("ai_proxy_recorded_final"):
            return
        if not self.recording and not (final and progress_recorded):
            return
        if not final and progress_recorded:
            return
        if final:
            flow.metadata["ai_proxy_recorded_final"] = True
        else:
            flow.metadata["ai_proxy_recorded_progress"] = True
        batch_id = flow.metadata.get("ai_proxy_batch") or self.store.get_current_batch()["id"]
        started = flow.metadata.get("ai_proxy_started", now_ms())
        request = flow.request
        response = flow.response
        original_url = flow.metadata.get("ai_proxy_original_url", request.pretty_url)
        original_parts = urlsplit(original_url)
        original_host = (original_parts.hostname or request.host or "").lower()
        original_scheme = original_parts.scheme or request.scheme
        original_port = original_parts.port or (
            443 if original_scheme == "https" else 80
        )
        original_path = (original_parts.path or "/") + (
            f"?{original_parts.query}" if original_parts.query else ""
        )
        client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else "127.0.0.1"
        if client_ip in ("127.0.0.1", "::1") and flow.client_conn.peername:
            client_ip = self.client_ports.get(flow.client_conn.peername[1], client_ip)
        streamed = bool(flow.metadata.get("ai_proxy_streamed"))
        body_values: dict[str, Any] = {}
        request_body, request_decode_failed = _content_or_none(request)
        body_values["request_body"] = request_body
        response_decode_failed = False
        if final and not streamed and response is not None:
            response_body, response_decode_failed = _content_or_none(response)
            body_values["response_body"] = response_body
        request_id = flow.metadata["ai_proxy_id"]
        status = response.status_code if response else None
        content_type = (
            response.headers.get("content-type")
            if response
            else request.headers.get("content-type")
        )
        trace = flow.metadata.get("ai_proxy_trace") or {}
        original_request_headers = flow.metadata.get("ai_proxy_request_headers_original") or []
        current_request_headers = list(request.headers.items(multi=True))
        original_response_headers = flow.metadata.get("ai_proxy_response_headers_original")
        current_response_headers = list(response.headers.items(multi=True)) if response else []
        if original_response_headers is None:
            original_response_headers = current_response_headers
            flow.metadata["ai_proxy_response_headers_original"] = current_response_headers
        rule_evidence = {
            "compose": flow.metadata.get("ai_proxy_compose"),
            "configSnapshot": flow.metadata.get("ai_proxy_config_snapshot"),
            "configAtCompletion": self.store.config_version(),
            "throttleBoundary": "配置记录于请求开始；传输带宽预算跟随运行时设置，期间的改动不代表整个请求均使用同一限速",
            "requestBodyChange": {"before": flow.metadata.get("ai_proxy_request_body_before"), "after": _body_fingerprint(request)},
            "responseBodyChange": {"before": flow.metadata.get("ai_proxy_response_body_before"), "after": _body_fingerprint(response) if response else None},
            "streamEvents": _stream_snapshot(flow.metadata.get("ai_proxy_sse"), "events"),
            "websocket": _stream_snapshot(flow.metadata.get("ai_proxy_websocket"), "frames"),
            "matchedRule": flow.metadata.get("ai_proxy_matched_rule"),
            "rewrites": flow.metadata.get("ai_proxy_rewrites") or [],
            "requestHeaderChanges": _header_changes(original_request_headers, current_request_headers),
            "responseHeaderChanges": _header_changes(original_response_headers, current_response_headers),
            "rawServiceBodyNotice": "规则修改前后的正文不会默认重复保存；Header 变化和规则 ID 已记录。",
        }
        request_body_state = (
            "decode-failed"
            if request_decode_failed
            else "available" if request_body is not None else "empty"
        )
        response_body_state = (
            "decode-failed"
            if response_decode_failed
            else "available" if body_values.get("response_body") is not None else "empty"
        )
        if request.method == "CONNECT":
            request_state = "completed"
            request_body_state = "connect-tunnel"
            response_body_state = "connect-tunnel"
        elif final and streamed and not flow.metadata.get("ai_proxy_error"):
            request_state = "completed"
            response_body_state = (
                "capture-truncated"
                if flow.metadata.get("ai_proxy_body_too_large")
                else "stream-not-saved"
            )
        elif not final:
            request_state = "in_progress"
            if request_body is not None:
                request_body_state = "pending"
            response_body_state = "pending"
        elif flow.metadata.get("ai_proxy_error"):
            request_state = "error"
            if response_decode_failed:
                response_body_state = "decode-failed"
            elif body_values.get("response_body") is None:
                response_body_state = "missing"
        else:
            request_state = "completed"
        if final:
            self.sequence += 1
            completion_sequence = self.sequence
        else:
            completion_sequence = None
        environment = flow.metadata.get("ai_proxy_environment", {})
        payload = {
            "_capture_generation": flow.metadata.get("ai_proxy_generation", -1),
            "id": request_id,
            "batch_id": batch_id,
            "sequence": completion_sequence or flow.metadata.get("ai_proxy_start_sequence", 0),
            "start_sequence": flow.metadata.get("ai_proxy_start_sequence"),
            "completed_sequence": completion_sequence,
            "method": request.method,
            "scheme": original_scheme,
            "host": original_host,
            "port": original_port,
            "path": original_path,
            "url": original_url,
            "status": status,
            "content_type": content_type,
            "started_at": started,
            "request_started_at": started,
            "request_finished_at": flow.metadata.get("ai_proxy_request_finished"),
            "response_headers_at": flow.metadata.get("ai_proxy_response_headers"),
            "finished_at": now_ms() if final else None,
            "duration_ms": max(0, now_ms() - started) if final else None,
            "size": len(response.raw_content or b"") if response and response.raw_content else 0,
            "source_ip": client_ip,
            "client_peer": flow.metadata.get("ai_proxy_peer"),
            "connection_id": flow.metadata.get("ai_proxy_connection"),
            "http_version": getattr(request, "http_version", None),
            "encrypted": int(request.method == "CONNECT"),
            "tls_error": flow.metadata.get("ai_proxy_tls_error"),
            "matched_rule": flow.metadata.get("ai_proxy_matched_rule"),
            "actual_url": flow.metadata.get("ai_proxy_actual_url"),
            "rule_error": flow.metadata.get("ai_proxy_rule_error"),
            "rule_evidence": rule_evidence,
            "request_headers": current_request_headers,
            "request_headers_original": original_request_headers,
            "response_headers": current_response_headers,
            "response_headers_original": original_response_headers,
            "request_state": request_state,
            "request_body_state": (
                "capture-truncated"
                if body_values.get("request_body") is not None and len(body_values["request_body"]) > 5 * 1024 * 1024
                else request_body_state
            ),
            "response_body_state": (
                "capture-truncated"
                if body_values.get("response_body") is not None
                and len(body_values["response_body"]) > 5 * 1024 * 1024
                else response_body_state
            ),
            "trace_id": trace.get("traceId"),
            "parent_span_id": trace.get("parentSpanId"),
            "trace_state": trace.get("traceState"),
            "trace_valid": int(bool(trace.get("valid"))),
            "capture_loss": int(self.capture_loss > 0),
            "environment": environment.get("name") or environment.get("environment"),
            "app_version": environment.get("appVersion"),
            "build_number": environment.get("buildNumber"),
            "error": flow.metadata.get("ai_proxy_error"),
            **body_values,
        }
        try:
            self.record_queue.put_nowait(payload)
        except Full:
            if payload.get("request_state") != "in_progress":
                self._persist_outcome(request_id, "failed")
            self.queue_drops += 1
            self.last_record_loss_reason = "queue-full"
            self.capture_loss += 1
            self.emit(
                "capture:record-loss",
                {"reason": "queue-full", "total": self.capture_loss, "requestId": request_id},
            )


def _stream_snapshot(state: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
    if state is None:
        return None
    # The writer thread must not observe frames added after this checkpoint.
    return {**state, key: [dict(item) for item in state.get(key, [])]}


def _content_or_none(message: Any) -> tuple[bytes | None, bool]:
    """Decode a mitmproxy message without losing the whole capture on errors."""
    try:
        content = message.get_content()
        return (content or None), False
    except Exception as error:
        logger.warning("Unable to decode captured body: %s", error)
        return None, True


class ProxyManager:
    def __init__(
        self,
        store: Store,
        throttle: Throttle,
        emit: Callable[[str, dict[str, Any]], None],
        cert_dir: Path,
    ) -> None:
        self.store = store
        self.throttle = throttle
        self.emit = emit
        self.cert_dir = cert_dir
        self.cert_dir.mkdir(parents=True, exist_ok=True)
        self.addon = ProxyAddon(store, throttle, emit)
        self.master: dump.DumpMaster | None = None
        self.master_task: asyncio.Task | None = None
        self.timeout_task: asyncio.Task | None = None
        self.server: asyncio.AbstractServer | None = None
        self.cert_server: asyncio.AbstractServer | None = None
        self.cert_port = 0
        self.port = 8080
        self.lan = False
        self.internal_port = 0
        self.listener_id = new_id("listener")
        self.running = False
        self.paused = False
        self.started_at: int | None = None
        self._server_lock = asyncio.Lock()
        self.connections = Connections(store)
        self.addon.connections = self.connections
        self.selected_ip = store.get_setting("lan_selected_ip")
        self._network_signature: tuple | None = None
        try:
            self.addon.timeout_settings = self.validate_timeouts(json.loads(store.get_setting("capture_timeouts") or "{}"))
        except (ValueError, TypeError, json.JSONDecodeError):
            logger.warning("Invalid saved capture timeout policy; using defaults")

    @staticmethod
    def validate_timeouts(data: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(data, dict):
            raise ValueError("超时配置必须是对象")
        policy = {"requestTimeoutSeconds": 120, "streamIdleTimeoutSeconds": 120, "http2Enabled": True}
        for key in ("requestTimeoutSeconds", "streamIdleTimeoutSeconds"):
            value = data.get(key, policy[key])
            if isinstance(value, bool) or not isinstance(value, int) or not 5 <= value <= 3600:
                raise ValueError("请求总时限与流空闲时限必须是5–3600秒的整数")
            policy[key] = value
        if not isinstance(data.get("http2Enabled", True), bool):
            raise ValueError("HTTP/2开关必须是布尔值")
        policy["http2Enabled"] = data.get("http2Enabled", True)
        return policy

    def set_timeouts(self, data: dict[str, Any]) -> dict[str, Any]:
        policy = self.validate_timeouts(data)
        if self.running and policy["http2Enabled"] != self.addon.timeout_settings["http2Enabled"]:
            raise ValueError("请先停止代理，再修改HTTP/2开关")
        self.store.set_setting("capture_timeouts", json.dumps(policy))
        self.addon.timeout_settings = policy
        if self.master:
            # A transport idle guard must not pre-empt any existing flow's policy.
            active = [p.metadata.get("ai_proxy_timeout_settings", policy) for p in self.addon.active_flows.values()]
            self.master.options.tcp_timeout = max(value[k] for value in [policy, *active] for k in ("requestTimeoutSeconds", "streamIdleTimeoutSeconds"))
        return self.status()

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    async def start(self, port: int = 8080, lan: bool = False) -> dict[str, Any]:
        if self.running:
            return self.status()
        self.paused = False
        self.listener_id = new_id("listener")
        self.addon.recording = True
        self.port = int(port)
        self.lan = bool(lan)
        self.internal_port = self._free_port()
        opts = options.Options(
            listen_host="127.0.0.1",
            listen_port=self.internal_port,
            confdir=str(self.cert_dir),
            mode=["regular"],
            http2=self.addon.timeout_settings["http2Enabled"],
        )
        try:
            self.master = dump.DumpMaster(
                opts,
                loop=asyncio.get_running_loop(),
                with_termlog=False,
                with_dumper=False,
            )
            # These options are registered by default addons during DumpMaster construction.
            opts.connection_strategy = "lazy"
            opts.stream_large_bodies = "5m"
            opts.tcp_timeout = max(self.addon.timeout_settings["requestTimeoutSeconds"], self.addon.timeout_settings["streamIdleTimeoutSeconds"])
            self.master.addons.add(self.addon)
            self.master_task = asyncio.create_task(self.master.run(), name="mitmproxy")
            await asyncio.sleep(0.25)
            if self.master_task.done():
                error = self.master_task.exception()
                raise RuntimeError(f"抓包内核启动失败: {error}")
            await self._start_server()
            await self._start_cert_server()
        except Exception:
            await self.stop()
            raise
        self.running = True
        self.timeout_task = asyncio.create_task(self.addon.watch_timeouts(), name="capture-timeouts")
        self.started_at = now_ms()
        self.emit("capture:status", self.status())
        return self.status()

    async def _start_server(self) -> None:
        async with self._server_lock:
            if self.server:
                self.server.close()
                await self.server.wait_closed()
            host = "0.0.0.0" if self.lan else "127.0.0.1"
            self.server = await asyncio.start_server(
                self._handle_connection,
                host,
                self.port,
                reuse_address=True,
            )

    async def _start_cert_server(self) -> None:
        if self.cert_server:
            self.cert_server.close()
            await self.cert_server.wait_closed()
        self.cert_server = await asyncio.start_server(
            self._handle_cert_http,
            "0.0.0.0" if self.lan else "127.0.0.1",
            0,
        )
        sockets = self.cert_server.sockets or []
        self.cert_port = sockets[0].getsockname()[1] if sockets else 0

    async def _handle_cert_http(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5)
            target = (
                request_line.decode("latin1", errors="replace").split(" ")[1]
                if request_line
                else "/"
            )
            path = urlsplit(target).path
            peer = writer.get_extra_info("peername")
            address = peer[0] if peer else "127.0.0.1"
            paired = path == "/" and self.connections.evidence("direct", target, address)
            token = self.connections.token_from(target) if paired else ""
            cert_path = self.cert_dir / "mitmproxy-ca-cert.pem"
            cert_pem = cert_path.read_bytes() if cert_path.exists() else b""
            cert_der = (
                ssl.PEM_cert_to_DER_cert(cert_pem.decode("ascii")) if cert_pem else b""
            )
            if path == "/ai-proxy.mobileconfig" and cert_der:
                body = self._build_apple_profile(cert_der)
                headers = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/x-apple-aspen-config\r\n"
                    'Content-Disposition: attachment; filename="AI Proxy CA.mobileconfig"\r\n'
                    f"Content-Length: {len(body)}\r\n"
                    "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
                ).encode()
            elif path in ("/ca.crt", "/ca.cer") and cert_der:
                body = cert_der
                headers = (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/x-x509-ca-cert\r\n"
                    'Content-Disposition: attachment; filename="AI Proxy CA.crt"\r\n'
                    f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
            elif path == "/ca.pem" and cert_pem:
                body = cert_pem
                headers = (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/x-pem-file\r\n"
                    'Content-Disposition: attachment; filename="AI Proxy CA.pem"\r\n'
                    f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
            else:
                peer_name = writer.get_extra_info("sockname")
                proxy_host = peer_name[0] if peer_name else get_local_ip()
                guide = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Proxy 手机 HTTPS</title>
<style>body{{font:16px/1.65 -apple-system,BlinkMacSystemFont,sans-serif;max-width:38rem;margin:7vh auto;padding:0 22px;color:#17231e;background:#eee9dd}}h1{{font-size:30px;margin-bottom:6px}}h2{{font-size:17px;margin:26px 0 8px}}p,li{{color:#4e544f}}a{{display:inline-block;background:#315e4a;color:#fff;padding:11px 16px;border-radius:8px;text-decoration:none;margin:5px 5px 5px 0}}a.secondary{{background:#fff;color:#315e4a;border:1px solid #b9c7bd}}code{{background:#fff;padding:3px 6px;border-radius:4px}}.proxy{{padding:14px;background:#e2ddd0;border-radius:9px}}.note{{border-top:1px solid #ccc;margin-top:26px;padding-top:16px;color:#6f695e;font-size:14px}}</style>
<h1>AI Proxy 手机 HTTPS</h1><p>只在你信任的 Wi-Fi 下使用。抓包内容可能包含账号和隐私数据。</p>
<div class="proxy"><b>Wi-Fi 手动代理</b><br>服务器：<code>{html.escape(proxy_host)}</code>　端口：<code>{self.port}</code></div>
<h2>先验证 HTTP</h2><p>先设置手机 Wi-Fi 手动代理，再在 Mac 允许该地址访问。</p>
<p><a href="http://ai-proxy.test/?pair={html.escape(token)}">验证 HTTP 代理路径</a><a href="https://ai-proxy.test/?pair={html.escape(token)}">安装信任后验证 HTTPS</a></p>
<p>配对有时效。验证成功只说明当前浏览器该次请求经过代理，不代表目标 App 已连接。</p>
<h2>1. 安装根证书</h2>
<p><a href="/ai-proxy.mobileconfig">iPhone / iPad 安装描述文件</a><a class="secondary" href="/ca.crt">Android 下载 CA 证书</a></p>
<p><b>iOS / iPadOS</b>：安装后进入「设置 → 通用 → 关于本机 → 证书信任设置」，打开 AI Proxy 根证书的完全信任。</p>
<p><b>Android</b>：在系统设置中安装 CA 证书。Android 7+ 的正式 App 可能不信任用户 CA，启用证书固定的 App 无法抓取明文。</p>
<h2>2. 设置 Wi-Fi 代理</h2>
<p>在手机当前 Wi-Fi 的「配置代理」中选择「手动」，服务器和端口填写上方地址，然后重新打开要抓取的 App。</p>
<h2>3. 验证</h2>
<p>回到 AI Proxy 的抓包页，确认 HTTPS 解密处于开启状态。手机访问网页后应出现对应的 HTTPS Host 和请求明细。</p>
<div class="note">抓包完成后请关闭手机 Wi-Fi 代理，否则关闭电脑或 AI Proxy 后手机可能无法联网。</div></html>""".encode()
                headers = (
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    f"Content-Length: {len(guide)}\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
                body = guide
            writer.write(headers + body)
            await writer.drain()
        except (TimeoutError, ConnectionError, OSError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    @staticmethod
    def _build_apple_profile(cert_der: bytes) -> bytes:
        fingerprint = hashlib.sha256(cert_der).hexdigest()
        ca_uuid = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"ai-proxy-root-ca:{fingerprint}")
        ).upper()
        profile_uuid = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"ai-proxy-mobile-profile:{fingerprint}")
        ).upper()
        profile = {
            "PayloadContent": [
                {
                    "PayloadCertificateFileName": "AI Proxy CA.cer",
                    "PayloadContent": cert_der,
                    "PayloadDescription": "用于 AI Proxy HTTPS 调试的本地根证书",
                    "PayloadDisplayName": "AI Proxy Root CA",
                    "PayloadIdentifier": "com.nekoya.ai-proxy.root-ca",
                    "PayloadType": "com.apple.security.root",
                    "PayloadUUID": ca_uuid,
                    "PayloadVersion": 1,
                }
            ],
            "PayloadDescription": "安装 CA 后还需在证书信任设置中开启完全信任",
            "PayloadDisplayName": "AI Proxy 手机 HTTPS",
            "PayloadIdentifier": "com.nekoya.ai-proxy.mobile-profile",
            "PayloadOrganization": "Nekoya",
            "PayloadRemovalDisallowed": False,
            "PayloadType": "Configuration",
            "PayloadUUID": profile_uuid,
            "PayloadVersion": 1,
        }
        return plistlib.dumps(profile, fmt=plistlib.FMT_XML, sort_keys=False)

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        upstream_writer: asyncio.StreamWriter | None = None
        upstream_port: int | None = None
        try:
            peer = writer.get_extra_info("peername")
            client_ip = peer[0] if peer else "127.0.0.1"
            if not self.connections.allowed(client_ip):
                writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                self.emit("connections:changed", self.connections.snapshot())
                return
            self.connections.writers.setdefault(client_ip, set()).add(writer)
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", self.internal_port), timeout=10
            )
            sockname = upstream_writer.get_extra_info("sockname")
            if sockname:
                upstream_port = sockname[1]
                self.addon.client_ports[upstream_port] = client_ip
                self.addon.client_writers[upstream_port] = writer
                self.addon.client_activity[upstream_port] = time.monotonic()
            def activity() -> None:
                if upstream_port is not None:
                    self.addon.client_activity[upstream_port] = time.monotonic()
            tasks = [
                asyncio.create_task(
                    self._pipe(reader, upstream_writer, self.throttle.up, activity)
                ),
                asyncio.create_task(
                    self._pipe(upstream_reader, writer, self.throttle.down, activity)
                ),
            ]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except (ConnectionError, OSError, TimeoutError) as error:
            logger.debug("Forwarding connection closed: %s", error)
        finally:
            if 'client_ip' in locals():
                self.connections.writers.get(client_ip, set()).discard(writer)
            if upstream_port is not None:
                self.addon.client_ports.pop(upstream_port, None)
                self.addon.client_writers.pop(upstream_port, None)
                self.addon.client_activity.pop(upstream_port, None)
            if upstream_writer:
                upstream_writer.close()
                with contextlib.suppress(Exception):
                    await upstream_writer.wait_closed()
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    @staticmethod
    async def _pipe(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        gate,
        activity: Callable[[], None],
    ) -> None:
        try:
            while data := await reader.read(16 * 1024):
                activity()
                await gate.consume(len(data))
                writer.write(data)
                await writer.drain()
        except (ConnectionError, OSError, TimeoutError):
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.write_eof()

    async def set_lan(self, lan: bool) -> dict[str, Any]:
        self.lan = bool(lan)
        self.connections.reset()
        if self.running:
            await self._start_server()
            await self._start_cert_server()
        self.emit("capture:status", self.status())
        return self.status()

    async def stop(self) -> dict[str, Any]:
        if self.timeout_task:
            self.timeout_task.cancel()
            await asyncio.gather(self.timeout_task, return_exceptions=True)
            self.timeout_task = None
        self.addon.interrupt_all()
        self.connections.reset()
        if self.master:
            self.master.shutdown()
        if self.master_task:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.master_task, timeout=3)
        await asyncio.to_thread(self.addon.flush_records)
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        if self.cert_server:
            self.cert_server.close()
            await self.cert_server.wait_closed()
        self.server = None
        self.cert_server = None
        self.cert_port = 0
        self.master = None
        self.master_task = None
        self.running = False
        self.started_at = None
        self.emit("capture:status", self.status())
        return self.status()

    def set_paused(self, paused: bool) -> dict[str, Any]:
        self.paused = paused
        self.addon.recording = not paused
        self.emit("capture:status", self.status())
        return self.status()

    def refresh_rules(self) -> None:
        self.addon.refresh_rules()

    def add_decrypt_host(self, host: str) -> None:
        self.addon.add_decrypt_host(host)

    def remove_decrypt_host(self, host: str) -> None:
        self.addon.remove_decrypt_host(host)

    def status(self) -> dict[str, Any]:
        local_ip = get_local_ip()
        addresses = get_network_addresses()
        signature = tuple(sorted((item["name"], item["address"]) for item in addresses))
        if self._network_signature is not None and signature != self._network_signature:
            self.connections.reset()
        self._network_signature = signature
        selected_ip = next(
            (item["address"] for item in addresses if item["name"] == "en0"),
            addresses[0]["address"] if addresses else local_ip,
        )
        if self.selected_ip and any(item["address"] == self.selected_ip for item in addresses):
            selected_ip = self.selected_ip
        return {
            "running": self.running,
            "listenerReady": bool(self.server and self.server.is_serving()),
            "engineReady": bool(self.master_task and not self.master_task.done()),
            "paused": self.paused,
            "port": self.port,
            "lan": self.lan,
            "startedAt": self.started_at,
            "requestCount": self.addon.request_count,
            "captureLoss": self.addon.capture_loss,
            "recordQueueDepth": self.addon.record_queue.qsize(),
            "recordQueueLimit": self.addon.record_queue.maxsize,
            "lastRecordLossReason": self.addon.last_record_loss_reason,
            "timeoutSettings": dict(self.addon.timeout_settings),
            "http2TimeoutIsolation": "shared-connection" if self.addon.timeout_settings["http2Enabled"] else "http1-connection",
            "localIp": selected_ip,
            "localIps": addresses,
            "decryptHosts": sorted(self.addon.decrypt_hosts),
            "certUrl": "http://mitm.it/",
            "certPort": self.cert_port or None,
            "certDirectUrl": f"http://{selected_ip}:{self.cert_port}/" if self.cert_port else None,
            "lastTlsError": self.addon.last_tls_error,
            "selectedAddressMissing": bool(self.selected_ip and not any(item["address"] == self.selected_ip for item in addresses)),
        }


def get_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def _header_changes(
    before: list[tuple[str, str]] | list[list[str]],
    after: list[tuple[str, str]] | list[list[str]],
) -> list[dict[str, Any]]:
    before_map: dict[str, list[str]] = {}
    after_map: dict[str, list[str]] = {}
    for name, value in before:
        before_map.setdefault(name.lower(), []).append(value)
    for name, value in after:
        after_map.setdefault(name.lower(), []).append(value)
    changes = []
    for name in sorted(set(before_map) | set(after_map)):
        if before_map.get(name) != after_map.get(name):
            changes.append(
                {
                    "name": name,
                    "before": before_map.get(name, []),
                    "after": after_map.get(name, []),
                }
            )
    return changes


def get_network_addresses() -> list[dict[str, str]]:
    try:
        output = subprocess.run(
            ["/sbin/ifconfig"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    addresses: list[dict[str, str]] = []
    current = ""
    for line in output.splitlines():
        if line and not line.startswith((" ", "\t")):
            current = line.split(":", 1)[0]
        stripped = line.strip()
        if stripped.startswith("inet ") and current and current != "lo0":
            address = stripped.split()[1]
            if not address.startswith("127."):
                addresses.append({"name": current, "address": address})
    return addresses


def _body_fingerprint(message) -> dict[str, Any]:
    data = message.raw_content
    if data is None:
        return {"available": False, "reason": "streamed-or-missing", "originalSaved": False}
    return {"available": True, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "preview": data[:512].decode("utf-8", "replace"), "previewTruncated": len(data) > 512, "originalSaved": False}
