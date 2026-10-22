from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any

from pydantic_ai import Agent

from .agent import AgentCoordinator, _build_model
from .proxy import ProxyManager
from .store import Store, new_id
from .throttle import Throttle


_stdout_lock = threading.Lock()


def emit(event: str, data: dict[str, Any]) -> None:
    payload = json.dumps(
        {"type": "event", "event": event, "data": data},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    with _stdout_lock:
        sys.stdout.write(payload + "\n")
        sys.stdout.flush()


class EngineApp:
    def __init__(self) -> None:
        data_dir = Path(
            os.environ.get(
                "AI_PROXY_APP_DATA",
                Path.home() / "Library/Application Support/com.nekoya.ai-proxy",
            )
        )
        self.store = Store(data_dir)
        self.throttle = Throttle()
        self.proxy = ProxyManager(
            self.store,
            self.throttle,
            emit,
            data_dir / "certificates",
        )
        self.agent = AgentCoordinator(self.store, self.proxy, self.throttle, emit)
        self.emit = emit
        self.closing = asyncio.Event()
        self._load_settings()

    def _load_settings(self) -> None:
        throttle_raw = self.store.get_setting("throttle")
        if throttle_raw:
            try:
                data = json.loads(throttle_raw)
                self.throttle.update(
                    bool(data.get("enabled")),
                    int(data.get("upKbPerSecond", 0)),
                    int(data.get("downKbPerSecond", 0)),
                    int(data.get("latencyMs", 0)),
                )
            except (ValueError, TypeError, json.JSONDecodeError):
                pass
        decrypt_raw = self.store.get_setting("decrypt_hosts", '["*"]')
        try:
            for host in json.loads(decrypt_raw):
                self.proxy.add_decrypt_host(str(host))
        except json.JSONDecodeError:
            pass
        try:
            port = int(self.store.get_setting("listen_port", "8080") or 8080)
            self.proxy.port = port
        except ValueError:
            self.proxy.port = 8080

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "app.bootstrap":
            batches = self.store.list_batches()
            current = self.store.get_current_batch()
            sessions = self.store.list_sessions()
            if not sessions:
                sessions = [self.store.create_session("开始调试")]
            current_session = self.store.get_session(sessions[0]["id"])
            return {
                "capture": self.proxy.status(),
                "throttle": self.throttle.status(),
                "batches": batches,
                "currentBatch": current,
                "requests": self.store.list_requests(current["id"]),
                "rules": self.store.list_rules(),
                "providers": self.store.list_providers(),
                "sessions": sessions,
                "currentSession": current_session,
                "agent": self.agent.status(),
                "certificate": self.certificate_info(),
                "storage": self.store.storage_info(),
                "listenPort": self.proxy.port,
            }

        if method == "capture.status":
            return self.proxy.status()
        if method == "capture.start":
            port = int(params.get("port", self.proxy.port))
            self.store.set_setting("listen_port", str(port))
            return await self.proxy.start(port, bool(params.get("lan", False)))
        if method == "capture.stop":
            return await self.proxy.stop()
        if method == "capture.pause":
            return self.proxy.set_paused(bool(params.get("paused", True)))
        if method == "capture.set-lan":
            return await self.proxy.set_lan(bool(params.get("lan", False)))

        if method == "requests.list":
            batch_id = params.get("batchId") or self.store.get_current_batch()["id"]
            return self.store.list_requests(
                batch_id,
                str(params.get("query", "")),
                str(params.get("method", "")),
                str(params.get("status", "")),
                str(params.get("sourceIp", "")),
                int(params.get("limit", 500)),
            )
        if method == "requests.detail":
            detail = self.store.request_detail(params["requestId"])
            return self._with_body_preview(detail)
        if method == "batches.list":
            return self.store.list_batches()
        if method == "batches.create":
            return self.store.create_batch(params.get("label"))
        if method == "batches.select":
            batch = self.store.select_batch(params["batchId"])
            return {"batch": batch, "requests": self.store.list_requests(batch["id"])}
        if method == "batches.clear":
            self.store.clear_batch(params["batchId"])
            return {"ok": True}
        if method == "batches.delete":
            self.store.delete_batch(params["batchId"])
            return {"ok": True, "currentBatch": self.store.get_current_batch()}

        if method == "rules.list":
            return self.store.list_rules()
        if method == "rules.save":
            rule = self.store.save_rule(params)
            self.proxy.refresh_rules()
            emit("rules:changed", self.store.list_rules())
            return rule
        if method == "rules.delete":
            self.store.delete_rule(params["ruleId"])
            self.proxy.refresh_rules()
            emit("rules:changed", self.store.list_rules())
            return {"ok": True}
        if method == "rules.reorder":
            self.store.reorder_rules(params.get("ids", []))
            self.proxy.refresh_rules()
            emit("rules:changed", self.store.list_rules())
            return {"ok": True}

        if method == "throttle.get":
            return self.throttle.status()
        if method == "throttle.set":
            result = self.throttle.update(
                bool(params.get("enabled", False)),
                int(params.get("upKbPerSecond", 0)),
                int(params.get("downKbPerSecond", 0)),
                int(params.get("latencyMs", 0)),
            )
            self.store.set_setting("throttle", json.dumps(result))
            emit("proxy:throttle", result)
            emit("capture:status", self.proxy.status())
            return result

        if method == "decrypt.list":
            return self.proxy.status()["decryptHosts"]
        if method == "decrypt.set":
            host = str(params["host"]).strip().lower()
            if not host:
                raise ValueError("域名不能为空")
            if params.get("enabled", True):
                self.proxy.add_decrypt_host(host)
            else:
                self.proxy.remove_decrypt_host(host)
            self.store.set_setting(
                "decrypt_hosts",
                json.dumps(sorted(self.proxy.status()["decryptHosts"]), ensure_ascii=False),
            )
            status = self.proxy.status()
            emit("capture:status", status)
            return status

        if method == "sessions.list":
            return self.store.list_sessions()
        if method == "sessions.get":
            return self.store.get_session(params["sessionId"])
        if method == "sessions.create":
            return self.store.create_session(params.get("title", "新会话"))
        if method == "sessions.delete":
            self.store.delete_session(params["sessionId"])
            self.agent.histories.pop(params["sessionId"], None)
            return {"ok": True}
        if method == "sessions.add-file":
            result = self.store.add_session_file(params["sessionId"], params["path"])
            emit("session:updated", {"sessionId": params["sessionId"]})
            return result

        if method == "providers.list":
            return self.store.list_providers()
        if method == "providers.save":
            provider = self.store.save_provider(params)
            emit("providers:changed", self.store.list_providers())
            return provider
        if method == "providers.delete":
            self.store.delete_provider(params["providerId"])
            emit("providers:changed", self.store.list_providers())
            return {"ok": True}
        if method == "providers.test":
            provider = next(
                (item for item in self.store.list_providers() if item["id"] == params["providerId"]),
                None,
            )
            if provider is None:
                raise ValueError("供应商不存在")
            model = _build_model(provider, str(params.get("apiKey", "")))
            agent = Agent(model, instructions="Reply with exactly OK, no other text.")
            result = await asyncio.wait_for(agent.run("Connection test. Reply with OK."), timeout=45)
            return {"ok": True, "output": str(result.output)[:100]}

        if method == "agent.send":
            return await self.agent.start_run(
                session_id=params["sessionId"],
                text=params["text"],
                refs=params.get("refs", []),
                provider_id=params["providerId"],
                api_key=params.get("apiKey", ""),
                auto_apply=bool(params.get("autoApply", False)),
            )
        if method == "agent.stop":
            return self.agent.stop()
        if method == "agent.status":
            return self.agent.status()
        if method == "agent.approval":
            self.agent.resolve_approval(params["approvalId"], bool(params["approved"]))
            return {"ok": True}
        if method == "agent.host-result":
            self.agent.resolve_host_result(params["requestId"], params)
            return {"ok": True}

        if method == "certificate.info":
            return self.certificate_info()
        if method == "storage.info":
            return self.store.storage_info()
        if method == "storage.clear-all":
            for batch in self.store.list_batches():
                self.store.clear_batch(batch["id"])
            return self.store.storage_info()
        if method == "app.set-port":
            if self.proxy.running:
                raise ValueError("请先停止代理，再修改监听端口")
            port = int(params["port"])
            if not 1 <= port <= 65535:
                raise ValueError("端口必须在 1-65535 之间")
            self.proxy.port = port
            self.store.set_setting("listen_port", str(port))
            return self.proxy.status()
        if method == "app.apply-theme":
            return {"ok": True}
        raise ValueError(f"未知方法: {method}")

    def certificate_info(self) -> dict[str, Any]:
        cert = self.proxy.cert_dir / "mitmproxy-ca-cert.pem"
        return {
            "path": str(cert),
            "exists": cert.exists(),
            "url": "http://mitm.it/",
            "directory": str(self.proxy.cert_dir),
        }

    @staticmethod
    def _with_body_preview(detail: dict[str, Any]) -> dict[str, Any]:
        for key in ("requestBody", "responseBody"):
            body = detail.get(key)
            if not body or not body.get("path"):
                continue
            path = Path(body["path"])
            if not path.exists():
                continue
            data = path.read_bytes()
            content_type = str(detail.get("contentType") or "").lower()
            if content_type.startswith("image/") and len(data) <= 1_500_000:
                body["base64"] = base64.b64encode(data).decode("ascii")
                body["mime"] = content_type.split(";", 1)[0]
        return detail


async def read_requests(app: EngineApp) -> None:
    loop = asyncio.get_running_loop()
    while not app.closing.is_set():
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            app.closing.set()
            break
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if payload.get("method") == "__shutdown__":
            app.closing.set()
            break
        request_id = payload.get("id")
        method = payload.get("method", "")
        params = payload.get("params") or {}

        async def handle(req_id: Any = request_id, name: str = method, args: dict[str, Any] = params):
            try:
                result = await app.dispatch(name, args)
                response = {"type": "response", "id": req_id, "ok": True, "result": result}
            except Exception as error:
                logging.exception("RPC %s failed", name)
                response = {
                    "type": "response",
                    "id": req_id,
                    "ok": False,
                    "error": str(error),
                }
            with _stdout_lock:
                sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
                sys.stdout.flush()

        asyncio.create_task(handle(), name=f"rpc-{method}")
    await app.proxy.stop()


async def async_main() -> None:
    app = EngineApp()
    with _stdout_lock:
        sys.stdout.write('{"type":"ready"}\n')
        sys.stdout.flush()
    await read_requests(app)


def main() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        pass
