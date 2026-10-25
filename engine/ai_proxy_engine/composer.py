"""Bounded Compose/Repeat jobs. Preview is immutable; starts never retry a send."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import ipaddress
import json
import secrets
import ssl
import time
from typing import Any
from urllib.parse import urlsplit

import httpx2

from .errors import AppError
from .replay import ReplayService
from .store import new_id, now_ms


class Composer:
    def __init__(self, domain, proxy):
        self.domain, self.store, self.proxy = domain, domain.store, proxy
        self.tasks: dict[str, asyncio.Task] = {}
        self.owners: dict[str, str | None] = {}
        # Indexed recovery touches active groups only; never resumes a send.
        with self.store.connect() as db:
            rows = db.execute("SELECT job_json FROM compose_jobs WHERE status IN ('running','stopping')").fetchall()
        for row in rows:
            job = json.loads(row[0])
            job.update(status="interrupted", finishedAt=now_ms(), recoveredAt=now_ms(), notice="进程中断，发送结果可能未知；请核对动作记录，不自动重试。")
            actions = [self.store.get_replay_action(key) for key in job["actionIds"]]
            job.update(**self._counts(actions))
            self._save(job)

    def _save(self, job):
        job = {key: value for key, value in job.items() if key != "actions"}
        summary = {key: value for key, value in job.items() if key != "actionIds"}
        with self.store.connect() as db:
            db.execute("INSERT INTO compose_jobs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary_json=excluded.summary_json,job_json=excluded.job_json",
                       (job["id"], job["createdAt"], job["status"], json.dumps(summary, ensure_ascii=False), json.dumps(job, ensure_ascii=False)))

    def _capture_state(self, action):
        response = action["response"]
        if response.get("route") != "proxy" or not response.get("capturedRequestId"):
            return action
        captured_id = response["capturedRequestId"]
        with self.store.connect() as db:
            row = db.execute("SELECT request_state,rule_evidence FROM requests WHERE id=?", (captured_id,)).fetchone()
        state = "pending"
        if row and row["request_state"] != "in_progress":
            association = json.loads(row["rule_evidence"] or "{}").get("compose") or {}
            state = "saved" if association.get("actionId") == action["id"] else "unknown"
        elif self.proxy.addon.persist_outcomes.get(captured_id) == "failed" or response.get("captureState") == "failed":
            state = "failed"
        elif response.get("captureState") == "saved" or now_ms()-(action.get("finishedAt") or action["createdAt"]) >= 30_000:
            state = "unknown"
        if state != response.get("captureState"):
            response.update(captureState=state, capturePending=state == "pending", captureCheckedAt=now_ms())
            return self.store.save_replay_action(action["requestId"], action["batchId"], action)
        return action

    def get(self, job_id: str) -> dict[str, Any]:
        with self.store.connect() as db:
            row = db.execute("SELECT job_json FROM compose_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise ValueError("Compose任务不存在或已清理")
        job = json.loads(row[0])
        actions = [self._capture_state(self.store.get_replay_action(key)) for key in job["actionIds"]]
        # Derived even after recovery: totals always account for every action.
        counts = self._counts(actions)
        return {**job, **counts, "actions": actions}

    @staticmethod
    def _counts(actions):
        return {"completedCount": sum(a["status"] == "completed" for a in actions),
                "unsentCount": sum(a["status"] == "preview" for a in actions),
                "unknownCount": sum(a["status"] in ("unknown", "sending") for a in actions),
                "failedCount": sum(a["status"] not in ("completed", "preview", "unknown", "sending") for a in actions),
                "httpErrorCount": sum((a["response"].get("status") or 0) >= 400 for a in actions)}

    def list_jobs(self, offset: int = 0, limit: int = 20) -> dict[str, Any]:
        limit = max(1, min(limit, 50))
        with self.store.connect() as db:
            total = db.execute("SELECT count(*) FROM compose_jobs").fetchone()[0]
            offset = min(max(0, offset), max(0, ((total-1)//limit)*limit))
            rows = db.execute("SELECT summary_json FROM compose_jobs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        return {"items": [json.loads(row[0]) for row in rows], "total": total, "offset": offset}

    def _route(self, mode: str, target: str) -> dict[str, Any]:
        if mode not in ("direct", "proxy"):
            raise ValueError("发送链路必须为direct或proxy")
        parts = urlsplit(target)
        if not parts.hostname or parts.scheme not in ("http", "https"):
            raise ValueError("目标必须是HTTP(S) URL")
        from .proxy import get_network_addresses
        addresses = {item["address"] for item in get_network_addresses()} | {"localhost", "0.0.0.0", "::"}
        host = parts.hostname.lower()
        try:
            local = ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = False
        ports = {self.proxy.port, self.proxy.internal_port, self.proxy.cert_port}
        if host == "ai-proxy.test" or ((local or host in addresses) and (parts.port or (443 if parts.scheme == "https" else 80)) in ports):
            raise ValueError("Compose不能发送到本代理监听/引导端口，避免代理递归或污染连接诊断")
        if mode == "direct":
            return {"mode": mode}
        if not self.proxy.running or self.proxy.paused:
            raise ValueError("请先启动并恢复本地代理监听")
        if parts.scheme == "https" and not self.proxy.addon._should_decrypt(host):
            raise ValueError("HTTPS代理重放需要先显式开启目标Host解密；不会自动修改解密策略")
        cert = self.proxy.cert_dir / "mitmproxy-ca-cert.pem"
        return {"mode": mode, "port": self.proxy.port, "instance": self.proxy.listener_id,
                "caFingerprint": hashlib.sha256(cert.read_bytes()).hexdigest() if parts.scheme == "https" else None,
                "throttle": self.proxy.throttle.status(), "configHash": self.store.config_hash()}

    def preview(self, payload: dict[str, Any], owner_session: str | None = None, owner_run: str | None = None) -> dict[str, Any]:
        count, concurrency = int(payload.get("count", 1)), int(payload.get("concurrency", 1))
        interval, seconds = int(payload.get("intervalMs", 0)), int(payload.get("totalSeconds", 30))
        if not 1 <= count <= 20 or not 1 <= concurrency <= min(3, count) or not 0 <= interval <= 10000 or not 5 <= seconds <= 60:
            raise ValueError("次数1–20、并发1–3且不超过次数、间隔0–10000ms、总时限5–60秒")
        if len([task for task in self.tasks.values() if not task.done()]) >= 1:
            raise ValueError("已有Compose任务运行中，请先停止或等待")
        request_id = str(payload.get("requestId") or "")
        batch = self.store.get_current_batch()
        try:
            detail = self.store.request_detail(request_id, preview_chars=0) if request_id else {
                "id": "", "batchId": batch["id"], "version": 0, "url": "", "method": "GET", "requestHeaders": []}
        except ValueError as error:
            raise AppError("compose_source_changed", "来源请求已删除或无法读取，请重新载入抓包；未发送请求。") from error
        expected = payload.get("expectedSourceVersion")
        if request_id and (expected is None or detail["version"] != int(expected)):
            raise AppError("compose_source_changed", "载入的来源版本已改变或未指定，请重新载入抓包后再预览；未发送请求。")
        edits = payload.get("edits") or {}
        if not isinstance(edits, dict):
            raise ValueError("请求内容必须为对象")
        route = self._route(str(payload.get("route", "direct")), str(edits.get("url") or detail.get("actualUrl") or detail["url"]))
        job_id = new_id("compose")
        actions = []
        try:
            first = ReplayService(self.domain).preview(detail, edits, owner_session=owner_session, owner_run=owner_run, route_info=route, job_id=job_id)
            actions.append(first)
            if first["request"]["bodySize"]*count > 20*1024*1024:
                raise ValueError("整组请求正文总量超过20MiB，请减少次数或正文")
            fixed = self.store.get_replay_action(first["id"], internal=True)["request"]
            for _ in range(count-1):
                actions.append(self.store.save_replay_action(request_id, detail["batchId"], {"request": fixed, "idempotencyKey": new_id("send")}))
        except Exception:
            with self.store.connect() as db:
                for action in actions:
                    db.execute("DELETE FROM replay_actions WHERE id=? AND status='preview'", (action["id"],))
            raise
        job = {"id": job_id, "status": "preview", "createdAt": now_ms(), "actionIds": [a["id"] for a in actions],
               "ownerSessionId": owner_session, "ownerRunId": owner_run, "batchId": detail["batchId"],
               "route": route["mode"], "count": count, "concurrency": concurrency, "intervalMs": interval, "totalSeconds": seconds,
               "completedCount": 0, "unsentCount": count, "notice": "批准整组固定预览后发送；失败/未知后不再派发；并发中已发出的请求可能仍有业务副作用，不自动重试、不跟随重定向。"}
        if request_id:
            try:
                current = self.store.request_summary(request_id)
                if current["version"] != int(expected):
                    raise ValueError("source changed")
            except ValueError as error:
                with self.store.connect() as db:
                    for action in actions:
                        db.execute("DELETE FROM replay_actions WHERE id=? AND status='preview'", (action["id"],))
                raise AppError("compose_source_changed", "预览期间来源已变化或删除，请重新载入；未发送请求。") from error
        self._save(job)
        return self.get(job_id)

    def _validate(self, action, job_id: str):
        preview = action["request"]
        if preview.get("composeJobId") != job_id or action["status"] != "preview":
            raise ValueError("预览已执行或不属于当前任务；请核对动作历史")
        if preview["configHash"] != self.store.config_hash():
            raise AppError("scope_expired", "配置已改变，请重新生成预览")
        if action["requestId"]:
            detail = self.store.request_summary(action["requestId"])
            if detail["version"] != preview["requestVersion"]:
                raise AppError("scope_expired", "原请求已变化，请重新生成预览")
        wire = preview["_wire"]
        if hashlib.sha256(json.dumps(wire, sort_keys=True).encode()).hexdigest() != preview["wireHash"]:
            raise ValueError("固定预览内容已变化")
        if self._route(wire["route"]["mode"], wire["url"]) != wire["route"]:
            raise ValueError("代理监听、证书、规则或弱网已改变，请重新生成预览")

    def start(self, job_id: str, owner_run: str | None = None) -> dict[str, Any]:
        job = self.get(job_id)
        if owner_run and job.get("ownerRunId") != owner_run:
            raise ValueError("Compose任务不属于当前Run")
        if job["status"] != "preview":
            return job
        if any(not task.done() for task in self.tasks.values()):
            raise ValueError("已有Compose任务运行中")
        for key in job["actionIds"]:
            self._validate(self.store.get_replay_action(key, internal=True), job_id)
        job.pop("actions", None)
        job.update(status="running", startedAt=now_ms())
        self._save(job)
        self.owners[job_id] = owner_run
        self.tasks[job_id] = asyncio.create_task(self._run(job), name=f"compose:{job_id}")
        def completed(task):
            self.tasks.pop(job_id, None); self.owners.pop(job_id, None)
            if not task.cancelled():
                task.exception()
            current = self.get(job_id)
            if current["status"] in ("running", "stopping"):
                current.pop("actions", None)
                current.update(status="stopped" if task.cancelled() else "interrupted", finishedAt=now_ms())
                self._save(current)
        self.tasks[job_id].add_done_callback(completed)
        return self.get(job_id)

    async def wait(self, job_id: str) -> dict[str, Any]:
        task = self.tasks.get(job_id)
        if task:
            await task
        return self.get(job_id)

    def stop(self, job_id: str) -> dict[str, Any]:
        task = self.tasks.get(job_id)
        if task and not task.done():
            job = self.get(job_id); job.pop("actions", None); job["status"] = "stopping"; self._save(job)
            task.cancel()
        return self.get(job_id)

    def cancel_owner(self, owner_run: str | None):
        for job_id, owner in list(self.owners.items()):
            if owner_run and owner == owner_run:
                self.stop(job_id)

    async def drain(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _run(self, job):
        index = 0
        failed = asyncio.Event()
        dispatch_lock = asyncio.Lock()
        deadline = time.monotonic()+job["totalSeconds"]
        next_start = time.monotonic()
        active: list[asyncio.Task] = []
        status = "completed"
        async def worker():
            nonlocal index, next_start
            while not failed.is_set():
                async with dispatch_lock:
                    if failed.is_set() or index >= len(job["actionIds"]):
                        return
                    delay = next_start-time.monotonic()
                    if delay > 0:
                        await asyncio.sleep(delay)
                    if failed.is_set():
                        return
                    key = job["actionIds"][index]; index += 1
                    next_start = time.monotonic()+job["intervalMs"]/1000
                try:
                    result = await self._send(key, job["id"], deadline)
                    if result["status"] != "completed" or (result["response"].get("status") or 0) >= 400 or result["response"].get("captureError") or result["response"].get("truncated"):
                        failed.set()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    failed.set()
                    raise
        try:
            async with asyncio.timeout(job["totalSeconds"]):
                active = [asyncio.create_task(worker()) for _ in range(job["concurrency"])]
                await asyncio.gather(*active)
            if failed.is_set():
                status = "failed"
        except TimeoutError:
            status = "timeout"
        except asyncio.CancelledError:
            status = "stopped"
        except Exception as error:
            status = "failed"
            job["error"] = self.domain.redactor.text(str(error))
        finally:
            for task in active:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
            actions = [self.store.get_replay_action(key) for key in job["actionIds"]]
            job.update(status=status, finishedAt=now_ms(), **self._counts(actions))
            self._save(job)

    async def _send(self, action_id: str, job_id: str, deadline: float):
        action = self.store.get_replay_action(action_id, internal=True)
        self._validate(action, job_id)
        preview, wire = action["request"], action["request"]["_wire"]
        context = ssl.create_default_context()
        proxy_url = None
        tag = None
        entry: dict[str, Any] = {}
        if wire["route"]["mode"] == "proxy":
            proxy_url = f"http://127.0.0.1:{wire['route']['port']}"
            if urlsplit(wire["url"]).scheme == "https":
                context.load_verify_locations(self.proxy.cert_dir / "mitmproxy-ca-cert.pem")
            tag = secrets.token_urlsafe(24)
            entry = {"actionId": action_id, "batchId": action["batchId"], "replayOf": action["requestId"] or None}
            self.proxy.addon.compose_tokens[tag] = entry
        if not self.store.claim_replay_action(action_id):
            if tag:
                self.proxy.addon.compose_tokens.pop(tag, None)
            return self.store.get_replay_action(action_id)
        headers = [(name.encode("ascii"), value.encode("latin-1")) for name, value in wire["headers"]] + [(b"X-AI-Proxy-Idempotency-Key", action["idempotencyKey"].encode())]
        if tag:
            headers.append((b"X-AI-Proxy-Compose-Action", tag.encode()))
        body = base64.b64decode(wire["body"]) if wire["body"] is not None else None
        status, result, response_body, response_headers, code = "unknown", {}, bytearray(), [], None
        started = now_ms(); cancelled = False
        try:
            async with asyncio.timeout(max(.001, min(30, deadline-time.monotonic()))):
                async with httpx2.AsyncClient(proxy=proxy_url, verify=context, trust_env=False, follow_redirects=False, timeout=15) as client:
                    async with client.stream(wire["method"], wire["url"], headers=headers, content=body) as response:
                        code = response.status_code; response_headers = list(response.headers.multi_items())
                        async for chunk in response.aiter_raw():
                            remaining = 5*1024*1024+1-len(response_body)
                            response_body.extend(chunk[:remaining])
                            if len(response_body) > 5*1024*1024:
                                break
                        result = {"status": code, "headers": self.domain.redactor.headers(response_headers),
                                  "body": ReplayService(self.domain)._preview_body(response_body[:5*1024*1024].decode("utf-8", "replace"), response.headers.get("content-type", "")),
                                  "truncated": len(response_body)>5*1024*1024}
                        status = "completed"
        except asyncio.CancelledError:
            cancelled = True; result = {"resultUnknown": True, "error": "已停止等待；请求可能已到达服务端，请核对业务状态，不自动重试。"}
        except Exception as error:
            result = {"resultUnknown": True, "error": self.domain.redactor.text(str(error)), "message": "请求可能已到达服务端；不会自动重试。"}
        finally:
            if tag:
                self.proxy.addon.compose_tokens.pop(tag, None)
            captured_id = entry.get("capturedRequestId")
            if proxy_url:
                # Proxy owns the only capture row; do not fabricate a second copy.
                result.update(capturedRequestId=captured_id, capturePending=bool(captured_id), route="proxy",
                              rulesAndThrottle="以新抓包中的实际规则证据为准")
                if not captured_id:
                    result["captureError"] = "未取得解密后的代理抓包ID，请核对代理与存储状态"
            else:
                try:
                    parts = urlsplit(wire["url"])
                    captured = self.store.save_request({"id": new_id("req"), "batch_id": action["batchId"], "sequence": now_ms(),
                        "method": wire["method"], "scheme": parts.scheme, "host": parts.hostname, "port": parts.port or (443 if parts.scheme=="https" else 80),
                        "path": (parts.path or "/")+("?"+parts.query if parts.query else ""), "url": wire["url"], "status": code,
                        "content_type": next((v for k,v in response_headers if k.lower()=="content-type"), ""), "started_at": started,
                        "finished_at": now_ms(), "duration_ms": now_ms()-started, "size": len(response_body), "source_ip": "manual-compose",
                        "request_state": "completed" if status=="completed" else "failed", "request_headers": wire["headers"], "response_headers": response_headers,
                        "request_body": body, "response_body": bytes(response_body[:5*1024*1024]), "error": result.get("error"),
                        "request_body_state": "available" if body else "empty", "response_body_state": "available" if code is not None else "missing",
                        "response_truncated": len(response_body)>5*1024*1024,
                        "rule_evidence": {"composeActionId": action_id, "replayOf": action["requestId"] or None, "route": "direct", "rulesApplied": False, "throttleApplied": False}})
                    captured_id = captured["id"]; self.domain.emit("capture:request", captured)
                    result.update(capturedRequestId=captured_id, route="direct")
                except Exception as error:
                    result["captureError"] = self.domain.redactor.text(str(error))
            result["durationMs"] = now_ms()-started
            saved = self.store.save_replay_action(action["requestId"], action["batchId"], {**action, "status": status, "response": result, "finishedAt": now_ms()})
        if cancelled:
            raise asyncio.CancelledError
        return saved
