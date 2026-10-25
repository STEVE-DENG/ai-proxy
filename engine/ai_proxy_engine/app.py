from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
import threading
from contextlib import closing
from pathlib import Path
from typing import Any

from pydantic_ai import Agent

from .qa import QAService
from .agent import AgentCoordinator, DEFAULT_BUDGET, _build_model, _provider_error
from .domain import DomainService
from .privacy import Redactor
from .proxy import ProxyManager
from .store import Store, new_id, now_ms
from .throttle import Throttle
from .jobs import CANCEL_EVENT
from .experience import storage_health, compare_performance
from .errors import AppError, error_code


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
        self.project_root = data_dir
        self.project_root.mkdir(parents=True, exist_ok=True)
        self.project_manifest = data_dir / "projects.json"
        self.projects = {"active": "default", "items": [{"id": "default", "name": "默认项目"}]}
        if self.project_manifest.exists():
            self.projects = json.loads(self.project_manifest.read_text())
        active = self.projects.get("active", "default")
        data_dir = self.project_root if active == "default" else self.project_root / "projects" / active
        emit("app:initializing", {"stage": "storage"})
        self.store = Store(data_dir)
        self.store.recover_interrupted_requests()
        self.throttle = Throttle()
        self.proxy = ProxyManager(
            self.store,
            self.throttle,
            emit,
            data_dir / "certificates",
        )
        self.agent = AgentCoordinator(self.store, self.proxy, self.throttle, emit)
        self.domain = self.agent.domain
        self.qa = QAService(self.domain)
        self.emit = emit
        self.closing = asyncio.Event()
        self.mutation_lock = asyncio.Lock()
        self.compose_reads = asyncio.Semaphore(2)
        self.storage_health_task: asyncio.Task | None = None
        self.store.mark_interrupted_runs()
        self.store.recover_inflight_actions()
        self._load_settings()
        emit("app:initializing", {"stage": "workspace"})

    def _locate_request(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            request = self.store.request_summary(params["requestId"])
        except ValueError:
            return {"status": "deleted"}
        batch_id = params["batchId"]
        if request["batchId"] != batch_id:
            return {"status": "excluded"}
        page = self.domain.query(batch_id, {**params.get("filters", {}), "includeIds": [request["id"]], "limit": 1})
        return {"status": "available" if page["items"] else "excluded", "request": request}

    def _original_task(self, run_id: str) -> dict[str, Any]:
        try:
            run = self.store.get_run(run_id)
        except ValueError as error:
            raise AppError("original_task_missing", "原任务已清理，请重新指定问题；未调用模型。") from error
        task_run = run
        seen = {run_id}
        while task_run.get("parentRunId"):
            parent = task_run["parentRunId"]
            if parent in seen or len(seen) >= 64:
                raise AppError("original_task_missing", "原任务续查链异常，请在输入框重新指定问题")
            seen.add(parent)
            try:
                task_run = self.store.get_run(parent)
            except ValueError as error:
                raise AppError("original_task_missing", "原任务已清理，请在输入框重新指定问题；未调用模型。") from error
            if task_run["sessionId"] != run["sessionId"]:
                raise AppError("original_task_missing", "原任务续查链跨会话，未创建新分析")
        with self.store.connect() as db:
            message = db.execute("SELECT content,meta FROM messages WHERE run_id=? AND role='user' ORDER BY created_at,id LIMIT 1", (task_run["id"],)).fetchone()
        if not message or not message["content"].strip():
            raise AppError("original_task_missing", "原任务问题不存在，请复制你要分析的问题到输入框并重新选择范围；未调用模型。")
        return {"sessionId": run["sessionId"], "text": message["content"], "refs": json.loads(message["meta"] or "{}").get("refs") or []}

    def _rebuild_preview(self, run_id: str) -> dict[str, Any]:
        original = self._original_task(run_id)
        run = self.store.get_run(run_id)
        old = run["scope"]
        selected = old.get("selectedIds") or None
        missing = []
        if selected is not None:
            # Only retain the original selection; never fall back to all matches.
            members = None
            if old.get("scenarioId"):
                try:
                    scenario = self.store.get_scenario(old["scenarioId"])
                except ValueError as error:
                    raise AppError("scope_scenario_missing", "原场景已删除，请调整场景；未调用模型。") from error
                if scenario["batchId"] != old["batchId"]:
                    raise AppError("scope_scenario_invalid", "原场景不属于原批次，请重新选择")
                members = {item["id"] for item in scenario["requests"]}
            kept_ids = set()
            for offset in range(0, len(selected), 500):
                page = self.domain.query(old["batchId"], {**old.get("filters", {}), "includeIds": selected[offset:offset+500], "limit": 500})
                kept_ids.update(item["id"] for item in page["items"] if members is None or item["id"] in members)
            missing = sorted(set(selected)-kept_ids)
            selected = sorted(kept_ids)
            if not selected:
                raise AppError("scope_selection_missing", "原选择均已删除或不再匹配原条件；原问题仍保留，请重新选择请求。未创建任务、未调用模型。")
        scope = self.domain.build_scope(old["batchId"], old.get("filters"), selected, old.get("scenarioId"))
        before = {item["id"]: item["version"] for item in old.get("requestVersions", [])}
        after = {item["id"]: item["version"] for item in scope["requestVersions"]}
        refs = original["refs"]
        kept = [ref for ref in refs if ref.get("id") in after]
        added, removed = sorted(after.keys()-before.keys()), sorted(before.keys()-after.keys())
        changed = sorted(key for key in before.keys() & after.keys() if before[key] != after[key])
        return {"sessionId": run["sessionId"], "text": original["text"], "scope": scope, "refs": kept,
                "diff": {"previousCount": len(before), "currentCount": len(after), "added": len(added), "removed": len(removed),
                         "changed": len(changed), "excludedUnfinished": scope["excludedUnfinishedCount"],
                         "keptRefs": len(kept), "removedRefs": len(refs)-len(kept),
                         "missingSelected": len(missing), "missingSelectedIds": missing[:20],
                         "samples": {"added": added[:20], "removed": removed[:20], "changed": changed[:20]}},
                "notice": "复用原问题及仍在范围内的引用，保留原时间上界；需要新流量时请调整筛选范围后重新发送。"}

    def _load_settings(self) -> None:
        try:
            self.proxy.addon.timeout_settings = self.proxy.validate_timeouts(json.loads(self.store.get_setting("capture_timeouts") or "{}"))
        except (ValueError, TypeError):
            self.proxy.addon.timeout_settings = self.proxy.validate_timeouts({})
            logging.warning("Invalid capture timeout policy; using defaults")
        self.throttle.update(False, 0, 0, 0)
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
        self.proxy.addon.decrypt_hosts.clear()
        decrypt_raw = self.store.get_setting("decrypt_hosts", '[]')
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

    def _current_environment(self) -> dict[str, Any] | None:
        active_id = self.store.get_setting("active_environment")
        if not active_id:
            return None
        item = next(
            (config for config in self.store.list_configs("environment") if config["id"] == active_id),
            None,
        )
        return item["config"] | {"id": item["id"], "name": item["config"].get("name") or item["name"]} if item else None

    def _bootstrap(self) -> dict[str, Any]:
        batches = self.store.list_batches()
        current = self.store.get_current_batch()
        sessions = self.store.list_sessions()
        if not sessions:
            sessions = [self.store.create_session("开始调试")]
        current_session = self.store.get_session(sessions[0]["id"])
        page = self.domain.query(current["id"], {"limit": 500, "sort": "asc"})
        scenarios = self.store.list_scenarios(current["id"])
        return {
            "capture": self.proxy.status(),
            "throttle": self.throttle.status(),
            "batches": batches,
            "currentBatch": current,
            "requests": page["items"],
            "requestPage": page,
            "filterOptions": self.store.filter_options(current["id"]),
            "rules": self.store.list_rules(),
            "providers": self.store.list_providers(),
            "sessions": sessions,
            "currentSession": current_session,
            "agent": self.agent.status(),
            "certificate": self.certificate_info(),
            "storage": self.store.storage_info(),
            "listenPort": self.proxy.port,
            "scenarios": scenarios,
            "configs": self.store.list_configs(),
            "activeEnvironment": self._current_environment(),
            "debugActions": self.store.list_debug_actions(30),
            "imports": self.store.list_imports(),
            "mcpServers": self.store.list_mcp_servers(),
            "configVersion": self.store.config_version(),
            "projects": self.projects,
        }

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method in ("agent.stop", "agent.approval", "agent.host-result", "agent.status", "compose.stop", "compose.status", "compose.list"):
            return await self._dispatch(method, params)
        async with self.mutation_lock:
            return await self._dispatch(method, params)

    async def _quiesce(self) -> None:
        await self.agent.drain()
        self.proxy.set_paused(True)
        if self.proxy.running:
            await self.proxy.stop()
        await asyncio.to_thread(self.proxy.addon.flush_records)
        self.store.capture_generation += 1

    def _save_projects(self) -> None:
        temporary = self.project_manifest.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.projects, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.project_manifest)

    async def _select_project(self, project_id: str) -> dict[str, Any]:
        if project_id not in {item["id"] for item in self.projects["items"]}:
            raise ValueError("项目不存在")
        if project_id == self.projects["active"]:
            return self.projects
        directory = self.project_root if project_id == "default" else self.project_root / "projects" / project_id
        prepared = Store(directory)
        prepared.recover_interrupted_requests()
        prepared.mark_interrupted_runs()
        prepared.recover_inflight_actions()
        await self._quiesce()
        self.proxy.addon.close()
        self.store = prepared
        self.throttle = Throttle()
        self.proxy = ProxyManager(self.store, self.throttle, emit, directory / "certificates")
        self.agent = AgentCoordinator(self.store, self.proxy, self.throttle, emit)
        self.domain = self.agent.domain
        self.qa = QAService(self.domain)
        self.store.mark_interrupted_runs()
        self.store.recover_inflight_actions()
        self._load_settings()
        self.projects["active"] = project_id
        self._save_projects()
        emit("project:changed", self.projects)
        return self.projects

    async def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "projects.list":
            return self.projects
        if method == "projects.create":
            name = str(params.get("name") or "").strip()
            if not name:
                raise ValueError("请输入项目名称")
            from .store import new_id
            project = {"id": new_id("project"), "name": name[:100]}
            self.projects["items"].append(project)
            self._save_projects()
            return project
        if method == "projects.select":
            return await self._select_project(params["projectId"])
        if method == "qa.catalog":
            return self.qa.catalog()
        if method == "qa.save":
            return self.qa.save(params["kind"], params["name"], params.get("config") or {}, params.get("id"), params.get("expectedUpdated"))
        if method == "qa.get":
            return self.qa.get(params["id"])
        if method == "qa.checklist":
            return self.qa.checklist(params.get("requestIds") or [], str(params.get("name") or "人工验证清单"))
        if method == "qa.baseline":
            return self.qa.baseline(params["scenarioId"], params["name"], params.get("selector"), params.get("steps"))
        if method == "qa.compare-baseline":
            return await asyncio.to_thread(self.qa.compare_baseline, params["baselineId"], params["scenarioId"], params.get("steps"))
        if method == "qa.recipe-start":
            return self.qa.recipe_start(params["recipeId"])
        if method == "qa.recipe-step":
            return await asyncio.to_thread(self.qa.recipe_step, params["runId"], bool(params.get("execute", False)), params.get("actionId"))
        if method == "qa.auth":
            return await asyncio.to_thread(self.qa.auth, params.get("batchId") or self.store.get_current_batch()["id"], params.get("filters") or {})
        if method == "qa.file-info":
            return await asyncio.to_thread(self.qa.file_info, params["requestId"], params.get("direction", "response"))
        if method == "qa.body-export":
            data = self.store.body_bytes(params["requestId"], params.get("direction", "response"))
            if data is None:
                raise ValueError("没有保存的正文")
            return {"base64": base64.b64encode(data).decode(), "size": len(data), "notice": "导出本地原始正文，可能包含敏感信息"}
        if method == "qa.package-preview":
            return await asyncio.to_thread(self.qa.evidence_package, params["reportId"])
        if method == "qa.package-import":
            return self.qa.import_package(self._json_param(params))
        if method == "qa.packages":
            return self.store.list_configs("evidence_package")
        if method == "qa.operations":
            return self.qa.operations(int(params.get("limit", 100)))
        if method == "qa.matrix-preview":
            return self.qa.matrix_preview(params["requestId"], params["sessionId"], params["case"], params.get("matrixId"))
        if method == "qa.matrix-record":
            return await asyncio.to_thread(self.qa.matrix_record, params["matrixId"], params["actionId"])
        if method == "qa.matrix-restore":
            result = self.qa.matrix_restore(params["matrixId"])
            self.proxy.refresh_rules()
            emit("config:changed", {"version": self.store.config_version()})
            return result
        if method == "qa.stream-settings":
            self.store.set_setting("capture_stream_events", json.dumps(bool(params.get("sse"))))
            self.store.set_setting("capture_websocket_frames", json.dumps(bool(params.get("websocket"))))
            return self.qa.catalog()
        if method == "app.bootstrap":
            return self._bootstrap()

        if method == "capture.status":
            return self.proxy.status()
        if method == "capture.timeouts.set":
            result = self.proxy.set_timeouts(params.get("settings"))
            emit("capture:status", result)
            return result
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
        if method == "connections.status":
            status = self.proxy.status()
            return {**self.proxy.connections.snapshot(), "listener": status,
                    "certificate": self.certificate_info(), "checkedAt": now_ms()}
        if method == "connections.pair":
            if not self.proxy.running or not self.proxy.lan:
                raise ValueError("请先开启局域网代理，再生成配对二维码")
            return self.proxy.connections.start_pairing()
        if method == "connections.invalidate":
            self.proxy.connections.invalidate()
            return {"ok": True}
        if method == "connections.address":
            from .proxy import get_network_addresses
            address = str(params.get("address", ""))
            if not any(item["address"] == address for item in get_network_addresses()):
                raise ValueError("网络地址已失效，请刷新并选择当前网卡")
            self.proxy.selected_ip = address
            self.store.set_setting("lan_selected_ip", address)
            self.proxy.connections.pairing = None
            return self.proxy.status()
        if method == "connections.grant":
            self.proxy.connections.grant(str(params["address"]), str(params["action"]))
            return self.proxy.connections.snapshot()

        if method in ("requests.list", "requests.query"):
            batch_id = params.get("batchId") or self.store.get_current_batch()["id"]
            filters = dict(params)
            filters.setdefault("limit", 100)
            result = await asyncio.to_thread(self.domain.query, batch_id, filters)
            if method == "requests.list":
                return list(reversed(result["items"]))
            return result
        if method == "requests.tree":
            return await asyncio.to_thread(
                self.domain.tree,
                params.get("batchId") or self.store.get_current_batch()["id"],
                params.get("filters") or {},
                params.get("parent") or {"type": "root"},
                int(params.get("limit", 500)),
            )
        if method == "requests.locate":
            return await asyncio.to_thread(self._locate_request, params)
        if method == "requests.detail":
            return await asyncio.to_thread(self._request_detail, params["requestId"])
        if method == "requests.content":
            return await asyncio.to_thread(
                self.domain.read_content,
                params["requestId"],
                direction=str(params.get("direction", "response")),
                header_name=str(params.get("headerName", "")),
                query_key=str(params.get("queryKey", "")),
                pointer=str(params.get("jsonPointer", "")),
                offset=int(params.get("offset", 0)),
                limit=int(params.get("limit", 12000)),
                raw_preview=bool(params.get("rawPreview", False)),
                local_raw=bool(params.get("localRaw", False)),
                kind=str(params.get("kind", "body")),
                form_key=str(params.get("formKey", "")),
            )
        if method == "requests.aggregate":
            return await asyncio.to_thread(
                self.domain.aggregate,
                params.get("batchId") or self.store.get_current_batch()["id"],
                params,
                str(params.get("groupBy", "endpoint")),
            )
        if method == "requests.compare":
            return await asyncio.to_thread(
                self.domain.compare, params["requestIdA"], params["requestIdB"]
            )
        if method == "requests.relations":
            return await asyncio.to_thread(
                self.domain.relations,
                params.get("batchId") or self.store.get_current_batch()["id"],
                params,
            )
        if method == "requests.trace-groups":
            return await asyncio.to_thread(
                self.domain.trace_groups,
                params.get("batchId") or self.store.get_current_batch()["id"],
                params,
            )
        if method == "requests.waterfall":
            return await asyncio.to_thread(self.domain.waterfall, params["traceId"])
        if method == "requests.duplicates":
            return await asyncio.to_thread(
                self.domain.duplicate_patterns,
                params.get("batchId") or self.store.get_current_batch()["id"],
                params,
            )
        if method == "requests.filter-options":
            return self.store.filter_options(
                params.get("batchId") or self.store.get_current_batch()["id"]
            )
        if method == "requests.versions":
            return self.store.request_versions(params.get("ids") or [])
        if method == "requests.add-relation":
            request_a = self.store.request_summary(params["sourceId"])
            return self.store.add_relation(
                request_a["batchId"],
                params["sourceId"],
                params["targetId"],
                str(params.get("type", "manual-scenario")),
                params.get("basis") or {},
                manual=True,
            )

        if method == "scope.create":
            scope = await asyncio.to_thread(
                self.domain.build_scope,
                params.get("batchId") or self.store.get_current_batch()["id"],
                params.get("filters") or {},
                params.get("selectedIds"),
                params.get("scenarioId"),
                str(params.get("mode", "snapshot")),
            )
            return scope

        if method == "batches.list":
            return self.store.list_batches()
        if method == "batches.create":
            return self.store.create_batch(params.get("label"), params.get("metadata"))
        if method == "batches.select":
            batch = self.store.select_batch(params["batchId"])
            page = await asyncio.to_thread(
                self.domain.query, batch["id"], {"limit": 500, "sort": "asc"}
            )
            return {
                "batch": batch,
                "requests": page["items"],
                "requestPage": page,
                "scenarios": self.store.list_scenarios(batch["id"]),
                "filterOptions": self.store.filter_options(batch["id"]),
            }
        if method == "batches.clear":
            await self._quiesce()
            self.store.clear_batch(
                params["batchId"],
                delete_reports=bool(params.get("deleteReports", False)),
            )
            return {"ok": True}
        if method == "batches.delete":
            await self._quiesce()
            result = self.store.delete_batch(params["batchId"])
            return {"ok": True, "currentBatch": self.store.get_current_batch(), "result": result}

        if method == "rules.list":
            return self.store.list_rules()
        if method == "rules.save":
            rule = self.store.save_rule(params)
            self.proxy.refresh_rules()
            emit("rules:changed", self.store.list_rules())
            emit("config:changed", {"version": self.store.config_version()})
            return rule
        if method == "rules.delete":
            self.store.delete_rule(params["ruleId"])
            self.proxy.refresh_rules()
            emit("rules:changed", self.store.list_rules())
            emit("config:changed", {"version": self.store.config_version()})
            return {"ok": True}
        if method == "rules.reorder":
            self.store.reorder_rules(params.get("ids", []))
            self.proxy.refresh_rules()
            emit("rules:changed", self.store.list_rules())
            emit("config:changed", {"version": self.store.config_version()})
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
            self.store.bump_config_version()
            emit("proxy:throttle", result)
            emit("capture:status", self.proxy.status())
            emit("config:changed", {"version": self.store.config_version()})
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
            return await asyncio.to_thread(self.store.list_sessions)
        if method == "sessions.get":
            return await asyncio.to_thread(self.store.get_session, params["sessionId"])
        if method == "sessions.create":
            return self.store.create_session(params.get("title", "新会话"))
        if method == "sessions.delete":
            self.store.delete_session(params["sessionId"])
            return {"ok": True}
        if method == "sessions.add-file":
            result = self.store.add_session_file(params["sessionId"], params["path"])
            emit("session:updated", {"sessionId": params["sessionId"]})
            return result

        if method == "providers.list":
            return self.store.list_providers()
        if method == "providers.available":
            import sqlite3
            result = []
            for project in self.projects["items"]:
                if project["id"] == self.projects["active"]:
                    continue
                directory = self.project_root if project["id"] == "default" else self.project_root / "projects" / project["id"]
                database = directory / "ai-proxy.sqlite3"
                if not database.exists():
                    continue
                with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as db:
                    db.row_factory = sqlite3.Row
                    for row in db.execute("SELECT id,name,protocol,base_url,model FROM providers"):
                        result.append({"id": row["id"], "name": row["name"], "protocol": row["protocol"], "baseUrl": row["base_url"], "model": row["model"], "projectName": project["name"]})
            return result
        if method == "providers.save":
            provider = self.store.save_provider(params)
            emit("providers:changed", self.store.list_providers())
            return provider
        if method == "providers.delete":
            self.store.delete_provider(params["providerId"])
            emit("providers:changed", self.store.list_providers())
            return {"ok": True}
        if method in {"providers.test", "providers.capabilities"}:
            provider = next(
                (item for item in self.store.list_providers() if item["id"] == params["providerId"]),
                None,
            )
            if provider is None:
                raise ValueError("供应商不存在")
            key = str(params.get("apiKey", ""))
            model = _build_model(provider, key)
            agent = Agent(model, instructions="Reply with exactly OK, no other text.")
            prompt = "Connection test. Reply with OK."
            if method == "providers.capabilities":
                @agent.tool_plain
                def connectivity_check() -> str:
                    """Return a local synthetic connectivity marker; no business data or network action."""
                    return "AI_PROXY_SYNTHETIC_OK"
                prompt = "Call connectivity_check exactly once, then reply OK."
            try:
                from pydantic_ai.usage import UsageLimits
                result = await asyncio.wait_for(agent.run(prompt, usage_limits=UsageLimits(request_limit=3, tool_calls_limit=1)), timeout=45)
            except Exception as error:
                raise ValueError(_provider_error(error, key)) from None
            finally:
                await model.client.close()
            if method == "providers.capabilities":
                from pydantic_ai.messages import ToolReturnPart
                called = any(isinstance(part, ToolReturnPart) and part.tool_name == "connectivity_check" for message in result.all_messages() for part in message.parts)
                if not called:
                    raise ValueError("模型返回了文本但未调用合成工具。连接可用不代表 Agent 工具能力可用。")
            return {"ok": True, "output": str(result.output)[:100], "toolsVerified": method == "providers.capabilities"}

        if method == "agent.send":
            operation_id = str(params.get("operationId") or "")
            operation_key = f"agent-submission:{params['sessionId']}:{operation_id}"
            if operation_id and (saved := self.store.get_setting(operation_key)):
                previous = json.loads(saved)
                self.store.get_run(previous["runId"])
                return previous
            scope = params.get("scope")
            if not scope:
                batch_id = params.get("batchId") or self.store.get_current_batch()["id"]
                scope = self.domain.build_scope(
                    batch_id,
                    params.get("filters") or {},
                    params.get("selectedIds") if "selectedIds" in params else (
                        [item["id"] for item in params.get("refs", []) if item.get("id")] or None
                    ),
                    params.get("scenarioId"),
                    "snapshot",
                )
            result = await self.agent.start_run(
                session_id=params["sessionId"],
                text=params["text"],
                refs=params.get("refs", []),
                provider_id=params["providerId"],
                api_key=params.get("apiKey", ""),
                auto_apply=bool(params.get("autoApply", False)),
                scope=scope,
                mode=str(params.get("mode", "analysis")),
                budget={**DEFAULT_BUDGET, **(params.get("budget") or {})},
                parent_run_id=params.get("parentRunId"),
            )
            if operation_id:
                self.store.set_setting(operation_key, json.dumps(result))
            return result
        if method == "agent.continue":
            parent = self.store.get_run(params["runId"])
            operation_id = str(params.get("operationId") or "")
            operation_key = f"agent-submission:{parent['sessionId']}:{operation_id}"
            if operation_id and (saved := self.store.get_setting(operation_key)):
                previous = json.loads(saved)
                self.store.get_run(previous["runId"])
                return previous
            if parent["scope"].get("expired"):
                raise ValueError("原分析范围已失效，请新建分析")
            result = await self.agent.start_run(
                session_id=parent["sessionId"],
                text=params.get("text") or "继续上次未完成的分析，保留原有证据并先说明剩余待验证项。",
                refs=[],
                provider_id=params["providerId"],
                api_key=params.get("apiKey", ""),
                auto_apply=bool(params.get("autoApply", False)),
                scope=parent["scope"],
                mode=parent["mode"],
                budget={**parent["budget"], **(params.get("budget") or {})},
                parent_run_id=parent["id"],
            )
            if operation_id:
                self.store.set_setting(operation_key, json.dumps(result))
            return result
        if method == "agent.stop":
            return self.agent.stop()
        if method == "agent.status":
            return self.agent.status()
        if method == "agent.cache-status":
            return self.agent.cache_status()
        if method == "agent.cache-clear":
            return self.agent.clear_cache()
        if method == "agent.performance-compare":
            return await asyncio.to_thread(compare_performance, self.store, params.get("runIds"))
        if method == "agent.rebuild-preview":
            return await asyncio.to_thread(self._rebuild_preview, params["runId"])
        if method == "agent.original-task":
            return await asyncio.to_thread(self._original_task, params["runId"])
        if method == "agent.context.identity":
            return await asyncio.to_thread(self.agent.input_identity, params["sessionId"], str(params.get("providerId", "")))
        if method == "agent.context":
            return await asyncio.to_thread(self.agent.context_status, params["sessionId"], str(params.get("providerId", "")))
        if method == "agent.context.preview":
            return await asyncio.to_thread(self.agent.input_preview, params)
        if method == "agent.context.model.set":
            return self.agent.set_model_window(params)
        if method == "agent.context.set":
            return self.agent.set_context_settings(params.get("settings") or {})
        if method == "agent.compress":
            return await asyncio.to_thread(self.agent.compress_context, params["sessionId"])
        if method == "agent.budget":
            return self.agent.default_budget()
        if method == "agent.budget.set":
            return self.agent.set_default_budget(params.get("budget") or {})
        if method == "agent.approval":
            self.agent.resolve_approval(params["approvalId"], bool(params["approved"]))
            return {"ok": True}
        if method == "agent.host-result":
            self.agent.resolve_host_result(params["requestId"], params)
            return {"ok": True}
        if method == "agent.history":
            return await asyncio.to_thread(self.store.run_history, params["sessionId"], int(params.get("offset", 0)), int(params.get("limit", 12)))
        if method == "agent.runs":
            return await asyncio.to_thread(self.store.list_runs, params["sessionId"])
        if method == "agent.run":
            return await asyncio.to_thread(self.store.get_run, params["runId"])
        if method == "agent.events":
            return await asyncio.to_thread(self.store.list_events,
                params["runId"],
                int(params.get("afterSeq", 0)),
                int(params.get("limit", 500)),
            )
        if method == "agent.evidence":
            return await asyncio.to_thread(self.store.list_evidence, params["runId"])
        if method == "evidence.get":
            return self.store.get_evidence(params["evidenceId"])

        if method == "reports.history":
            return await asyncio.to_thread(self.store.report_history, params["sessionId"], int(params.get("offset", 0)), int(params.get("limit", 8)))
        if method == "reports.list":
            return await asyncio.to_thread(self.store.list_reports, params.get("sessionId"))
        if method == "reports.get":
            return await asyncio.to_thread(self.store.get_report, params["reportId"])
        if method == "reports.save":
            report = self.store.save_report(params)
            emit("report:created", {"report": report})
            return report
        if method == "reports.delete":
            self.store.delete_report(params["reportId"])
            return {"ok": True}
        if method == "reports.generate":
            return await asyncio.to_thread(self._generate_report, params["runId"])
        if method == "reports.export":
            report = self.store.get_report(params["reportId"])
            report["title"] = self.domain.redactor.text(str(report["title"]))
            report["content"] = self.domain.redactor.text(str(report["content"]))
            report["scope"] = self.domain.redactor.value(report.get("scope") or {})
            format_name = str(params.get("format", "markdown"))
            if format_name == "json":
                content = json.dumps(report, ensure_ascii=False, indent=2)
                extension = "json"
            else:
                content = report["content"]
                extension = "md"
            safe_title = "".join(
                char if char.isalnum() or char in "-_ " else "-"
                for char in report["title"]
            ).strip()[:80] or "analysis-report"
            return {
                "fileName": f"{safe_title}.{extension}",
                "content": content,
                "format": format_name,
            }

        if method == "scenarios.list":
            return self.store.list_scenarios(
                params.get("batchId") or self.store.get_current_batch()["id"]
            )
        if method == "scenarios.start":
            return self.store.start_scenario(
                params.get("batchId") or self.store.get_current_batch()["id"],
                params["name"],
                params.get("device"),
            )
        if method == "scenarios.end":
            return self.store.end_scenario(params["scenarioId"], params.get("includeIds"))
        if method == "scenarios.get":
            return self.store.get_scenario(params["scenarioId"])
        if method == "scenarios.set-request":
            self.store.set_scenario_request(
                params["scenarioId"],
                params["requestId"],
                params.get("membership", "include"),
                params.get("note", ""),
            )
            return self.store.get_scenario(params["scenarioId"])
        if method == "scenarios.compare":
            return await asyncio.to_thread(
                self.domain.compare_scenarios,
                params["scenarioIdA"],
                params["scenarioIdB"],
            )

        if method == "configs.list":
            return self.store.list_configs(params.get("kind"))
        if method == "configs.save":
            result = self.store.save_config(params)
            if result["kind"] == "environment" and params.get("activate"):
                self.store.set_setting("active_environment", result["id"])
                self.store.set_setting(
                    f"environment:{result['id']}",
                    json.dumps(result["config"] | {"name": result["name"]}, ensure_ascii=False),
                )
            emit("configs:changed", self.store.list_configs())
            return result
        if method == "configs.delete":
            self.store.delete_config(params["configId"])
            if self.store.get_setting("active_environment") == params["configId"]:
                self.store.set_setting("active_environment", "")
            emit("configs:changed", self.store.list_configs())
            return {"ok": True}
        if method == "configs.activate-environment":
            config = next(
                (item for item in self.store.list_configs("environment") if item["id"] == params["configId"]),
                None,
            )
            if config is None:
                raise ValueError("环境配置不存在")
            self.store.set_setting("active_environment", config["id"])
            self.store.set_setting(
                f"environment:{config['id']}",
                json.dumps(config["config"] | {"name": config["name"]}, ensure_ascii=False),
            )
            emit("config:changed", {"version": self.store.config_version()})
            return self._current_environment()

        if method == "debug.preview":
            return self.domain.preview_debug_action(params["actionType"], params.get("payload") or {})
        if method == "debug.apply":
            action = self.domain.apply_debug_action(params["actionId"])
            self.proxy.refresh_rules()
            if action["type"] == "throttle" and action["status"] == "applied":
                throttle_value = action["preview"]["payload"]
                result = self.throttle.update(
                    bool(throttle_value.get("enabled", True)),
                    int(throttle_value.get("upKbPerSecond", 0)),
                    int(throttle_value.get("downKbPerSecond", 0)),
                    int(throttle_value.get("latencyMs", 0)),
                )
                self.store.set_setting("throttle", json.dumps(result))
                emit("proxy:throttle", result)
            emit("debug:action", {"action": action})
            emit("config:changed", {"version": self.store.config_version()})
            return action
        if method == "debug.restore":
            action = self.domain.restore_debug_action(params["actionId"])
            self.proxy.refresh_rules()
            if action["type"] == "throttle" and action["status"] == "restored":
                throttle_value = action["before"].get("throttle") or {}
                result = self.throttle.update(
                    bool(throttle_value.get("enabled", False)),
                    int(throttle_value.get("upKbPerSecond", 0)),
                    int(throttle_value.get("downKbPerSecond", 0)),
                    int(throttle_value.get("latencyMs", 0)),
                )
                self.store.set_setting("throttle", json.dumps(result))
                emit("proxy:throttle", result)
            emit("debug:action", {"action": action})
            emit("config:changed", {"version": self.store.config_version()})
            return action
        if method == "debug.actions":
            return self.store.list_debug_actions(int(params.get("limit", 100)))
        if method == "debug.verify":
            return await asyncio.to_thread(
                self.domain.verify_debug_action,
                params["actionId"],
                source_ip=str(params.get("sourceIp", "")),
                limit=int(params.get("limit", 200)),
            )

        if method == "imports.list":
            return self.store.list_imports()
        if method == "imports.har":
            data = self._json_param(params)
            return await asyncio.to_thread(
                self.domain.import_har, data, params.get("batchLabel")
            )
        if method == "imports.openapi":
            data = self._json_param(params)
            return await asyncio.to_thread(
                self.domain.import_openapi,
                data,
                str(params.get("name") or "OpenAPI"),
            )
        if method == "imports.otlp":
            data = self._json_param(params)
            return await asyncio.to_thread(
                self.domain.import_otlp,
                data,
                str(params.get("source") or "OTLP JSON"),
            )
        if method == "exports.har":
            return await asyncio.to_thread(
                self.domain.export_har,
                params.get("batchId") or self.store.get_current_batch()["id"],
                params,
            )
        if method == "openapi.validate":
            return await asyncio.to_thread(
                self.domain.validate_openapi,
                params["requestId"],
                params.get("configId"),
            )
        if method == "openapi.templates":
            return await asyncio.to_thread(self._path_templates, params.get("configId"))
        if method == "observability.query":
            return await asyncio.to_thread(
                self.domain.query_observability,
                params["endpoint"],
                params["traceId"],
            )

        if method == "compose.preview":
            return await asyncio.to_thread(self.agent.composer.preview, params)
        if method == "compose.start":
            return self.agent.composer.start(params["jobId"])
        if method == "compose.status":
            async with self.compose_reads:
                return await asyncio.to_thread(self.agent.composer.get, params["jobId"])
        if method == "compose.stop":
            return self.agent.composer.stop(params["jobId"])
        if method == "compose.list":
            async with self.compose_reads:
                return await asyncio.to_thread(self.agent.composer.list_jobs, int(params.get("offset", 0)), int(params.get("limit", 20)))

        if method == "replay.preview":
            return await asyncio.to_thread(
                self.domain.replay,
                params["requestId"],
                execute=False,
                edits=params.get("edits"),
                override_url=str(params.get("overrideUrl", "")),
                action_id=params.get("actionId"),
            )
        if method == "replay.execute":
            return await asyncio.to_thread(
                self.domain.replay,
                params["requestId"],
                execute=True,
                override_url=str(params.get("overrideUrl", "")),
                action_id=params.get("actionId"),
            )

        if method == "mcp.servers":
            return self.store.list_mcp_servers()
        if method == "mcp.save":
            return self.store.save_mcp_server(params)
        if method == "mcp.call":
            return await asyncio.to_thread(
                self.domain.call_mcp_tool,
                params["serverId"],
                params["toolName"],
                params.get("arguments") or {},
            )
        if method == "tickets.preview":
            return await asyncio.to_thread(
                self.domain.create_ticket,
                params["reportId"],
                str(params.get("endpoint", "")),
                False,
                params.get("ticketId"),
            )
        if method == "tickets.create":
            return await asyncio.to_thread(
                self.domain.create_ticket,
                params["reportId"],
                params["endpoint"],
                True,
                params.get("ticketId"),
            )
        if method == "checklist.generate":
            return self.domain.test_checklist(params.get("requestIds") or [])

        if method == "certificate.info":
            return self.certificate_info()
        if method == "storage.info":
            return await asyncio.to_thread(self.store.storage_info)
        if method == "storage.health":
            store, addon = self.store, self.proxy.addon
            if self.storage_health_task and not self.storage_health_task.done():
                raise ValueError("上次存储检查仍在等待磁盘响应，请先恢复磁盘，不要连续提交检查")
            self.storage_health_task = asyncio.create_task(asyncio.to_thread(storage_health, store))
            self.storage_health_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
            result = await asyncio.shield(self.storage_health_task)
            return {**result, "capture": {"lastPersistedAt": addon.last_persisted_at,
                    "lastFailure": addon.last_persist_error, "failedWrites": addon.failed_writes,
                    "queueDrops": addon.queue_drops, "recordLossEvents": addon.capture_loss,
                    "queueDepth": addon.record_queue.qsize(), "queueLimit": addon.record_queue.maxsize},
                    "notice": "最近保存时间与失败次数仅统计本次项目打开后的采集；不包含请求正文或凭据。"}
        if method == "storage.clear-all":
            await self._quiesce()
            local_state = {"projectId": self.projects["active"], "batchIds": [item["id"] for item in self.store.list_batches()], "sessionIds": [item["id"] for item in self.store.list_sessions()], "reportIds": [item["id"] for item in self.store.list_reports()]}
            self.store.clear_all(str(params.get("scope", "analysis")))
            self.proxy.refresh_rules()
            self._load_settings()
            emit("capture:cleared", {})
            return {**self.store.storage_info(), "clearedLocalState": local_state}
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

    def _generate_report(self, run_id: str) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        evidence = self.store.list_evidence(run_id)
        scope = run["scope"]
        summary = run.get("summary") or "模型未返回结论，请查看执行事件。"
        lines = [
            f"# {scope.get('batchLabel') or '抓包分析'}：分析报告",
            "",
            "## 环境与分析范围",
            "",
            f"- 批次：{scope.get('batchLabel')} (`{scope.get('batchId')}`)",
            f"- 设备：{', '.join(scope.get('devices') or []) or '未指定'}",
            f"- 范围样本：{scope.get('requestCount')} / 批次总数 {scope.get('batchCount')}",
            f"- 快照时间：{scope.get('snapshotAt')}",
            f"- 环境：{', '.join(scope.get('environments') or []) or '未记录'}",
            f"- App 版本：{', '.join(scope.get('appVersions') or []) or '未记录'}",
            f"- 构建号：{', '.join(scope.get('buildNumbers') or []) or '未记录'}",
            f"- 配置版本：{scope.get('configVersion')} / {scope.get('configHash')}",
            f"- 运行模式：{run['mode']}",
            "",
            "## 调查结论、候选原因与待查",
            "",
            summary,
            "",
            "## 关键证据",
            "",
        ]
        if evidence:
            for item in evidence:
                state = item["state"]
                lines.append(
                    f"- `{item['requestId']}` v{item['requestVersion']} · "
                    f"{item['direction']} `{item['locator'] or ''}` · {item['summary']} · 状态 `{state}`"
                )
        else:
            lines.append("- 本轮没有生成结构化证据，结论完整性受限。")
        lines.extend(
            [
                "",
                "## 数据缺口与边界",
                "",
                "- 手机代理只观察经过本应用的流量；服务内部 Span 需要导入后才会出现。",
                f"- 快照内未完成请求：{scope.get('unfinishedCount', 0)}；创建时明确排除的进行中请求：{scope.get('excludedUnfinishedCount', 0)}。",
                "- 正文缺失、流式未保存或采集截断会在对应证据中标记。",
                "",
                "## 复现与验证",
                "",
                "- 在相同设备、环境、账号和业务前置条件下再次执行同一操作。",
                "- 对关键失败字段和成功样本执行字段对比，并新增捕获记录验证。",
            ]
        )
        lines.extend(["", "## 已观察事实与复现请求", ""])
        for source in (scope.get("requestVersions") or [])[:50]:
            try:
                row = self.store.request_summary(source["id"])
                valid = row["version"] == source["version"]
                lines.append(f"- `{row['id']}` v{source['version']} · {'有效' if valid else '已变化，当前值不可充当原事实'} · {row['method']} {self.domain.redactor.url(row['url'])} · HTTP {row.get('status')} · {row.get('durationMs')} ms · {row.get('startedAt')}")
            except ValueError:
                lines.append(f"- `{source['id']}` 已删除，无法回溯原事实。")
        lines.extend(["", "## 预期与实际", "", "- 预期：以业务需求和下方人工验证清单为准；未记录的预期须由复核者补充。", "- 实际：仅以有效版本的抓包与结构化证据为准。候选原因仍需人工验证。", "", "## 相关调试动作", ""])
        actions = [item for item in self.store.list_debug_actions() if item["preview"].get("payload", {}).get("ownerRunId") == run_id]
        lines.extend([f"- `{item['id']}` · {item['type']} · {item['status']} · {item['createdAt']}" for item in actions] or ["- 本轮无关联调试动作。"])
        ids = {item["id"] for item in scope.get("requestVersions") or []}
        lines.extend(["", "## 人工验证清单", ""])
        for checklist in self.store.list_configs("qa_checklist"):
            for check in checklist["config"].get("items") or []:
                if ids.intersection(check.get("requestIds") or []):
                    lines.append(f"- [{check.get('status', 'pending')}] {check.get('step')}；预期：{check.get('expected')}；备注：{check.get('note', '')}；证据：{', '.join(check.get('requestIds') or [])}")
        return self.store.save_report(
            {
                "sessionId": run["sessionId"],
                "runId": run_id,
                "title": f"{scope.get('batchLabel') or '抓包'} · 分析报告",
                "content": "\n".join(lines),
                "scope": scope,
                "status": "draft",
            }
        )

    def _path_templates(self, config_id: str | None = None) -> list[dict[str, Any]]:
        configs = [
            item
            for item in self.store.list_configs("openapi")
            if item["enabled"] and (config_id is None or item["id"] == config_id)
        ]
        batch = self.store.get_current_batch()
        aggregate = self.domain.aggregate(batch["id"], {}, "endpoint")
        templates = []
        for group in aggregate["groups"]:
            url = group["key"].split(" ", 1)[-1]
            from urllib.parse import urlsplit

            parsed = urlsplit(url)
            candidates = self.domain.openapi_candidates(group["key"].split(" ", 1)[0], parsed.path, configs)
            matched = None
            if candidates:
                config, operation, template = candidates[0]
                matched = {"configId": config["id"], "template": template, "operationId": operation.get("operationId")}
            templates.append({"endpoint": group["key"], "openapi": matched})
        return templates

    @staticmethod
    def _json_param(params: dict[str, Any]) -> dict[str, Any]:
        if isinstance(params.get("data"), dict):
            return params["data"]
        if isinstance(params.get("json"), str):
            return json.loads(params["json"])
        raise ValueError("缺少 JSON 导入数据")

    def certificate_info(self) -> dict[str, Any]:
        cert = self.proxy.cert_dir / "mitmproxy-ca-cert.pem"
        import hashlib
        import ssl
        fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest() if cert.exists() else None
        return {
            "path": str(cert),
            "exists": cert.exists(),
            "url": "http://mitm.it/",
            "directory": str(self.proxy.cert_dir),
            "fingerprint": fingerprint,
        }

    def _request_detail(self, request_id: str) -> dict[str, Any]:
        return self._with_body_preview(self.store.request_detail(request_id, preview_chars=16_000))

    @staticmethod
    def _with_body_preview(detail: dict[str, Any]) -> dict[str, Any]:
        for key in ("requestBody", "responseBody"):
            body = detail.get(key)
            if not body or not body.get("path"):
                continue
            path = Path(body["path"])
            if not path.exists():
                continue
            if path.stat().st_size > 1_500_000:
                continue
            data = path.read_bytes()
            direction = "request" if key == "requestBody" else "response"
            content_type = next((v for k, v in detail[f"{direction}Headers"] if k.lower() == "content-type"), "").lower()
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
            read_only = (name.startswith("requests.") and name != "requests.add-relation") or name in ("agent.original-task", "agent.context.identity", "reports.history", "compose.status", "compose.list", "agent.history", "agent.rebuild-preview", "agent.context.preview", "agent.context", "storage.health", "agent.performance-compare", "agent.evidence", "agent.runs", "agent.run", "agent.events", "agent.status", "sessions.get", "sessions.list", "reports.get", "reports.list")
            cancel_event = threading.Event() if read_only else None
            token = CANCEL_EVENT.set(cancel_event)
            try:
                if read_only:
                    async with asyncio.timeout(20):
                        result = await app.dispatch(name, args)
                else:
                    result = await app.dispatch(name, args)
                response = {"type": "response", "id": req_id, "ok": True, "result": result}
            except TimeoutError:
                if cancel_event:
                    cancel_event.set()
                message = "读取超时（20 秒），请缩小范围或重试" if read_only else "操作等待超时，回执未知；请先核对操作历史与实际结果，不要直接重复执行"
                response = {"type": "response", "id": req_id, "ok": False, "error": message, "errorCode": "timeout"}
            except Exception as error:
                logging.error("RPC %s failed (%s)", name, type(error).__name__)
                response = {
                    "type": "response",
                    "id": req_id,
                    "ok": False,
                    "error": str(error),
                    "errorCode": error_code(error),
                }
            finally:
                CANCEL_EVENT.reset(token)
            with _stdout_lock:
                sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
                sys.stdout.flush()

        asyncio.create_task(handle(), name=f"rpc-{method}")
    await app.agent.drain()
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
