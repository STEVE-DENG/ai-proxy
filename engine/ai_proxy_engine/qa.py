from __future__ import annotations

import base64
import hashlib
import json
import re
from collections import defaultdict
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from .domain import _json_pointer, header_value
from .store import new_id, now_ms


class QAService:
    def __init__(self, domain) -> None:
        self.domain = domain
        self.store = domain.store
        self.redactor = domain.redactor

    def get(self, item_id: str, kind: str | None = None) -> dict[str, Any]:
        item = next((item for item in self.store.list_configs(kind) if item["id"] == item_id), None)
        if item is None:
            raise ValueError("保存的 QA 项目不存在")
        return item

    def save(self, kind: str, name: str, config: dict[str, Any], item_id: str | None = None, expected_updated: int | None = None) -> dict[str, Any]:
        if kind not in ("qa_recipe", "qa_checklist", "qa_baseline", "qa_pairing", "qa_matrix", "qa_run"):
            raise ValueError("无效 QA 项目类型")
        if item_id and expected_updated is not None and self.get(item_id, kind)["updatedAt"] != expected_updated:
            raise ValueError("内容已被修改，请重新加载")
        return self.store.save_config({"id": item_id, "kind": kind, "name": name, "config": config})

    def catalog(self) -> dict[str, Any]:
        batch_id = self.store.get_current_batch()["id"]
        return {"items": [item for item in self.store.list_configs() if item["kind"].startswith("qa_")], "scenarios": self.store.list_scenarios(batch_id), "reports": self.store.list_reports(), "sessions": self.store.list_sessions(), "streamCapture": self.store.get_setting("capture_stream_events", "false") == "true", "projectId": self.store.data_dir.name, "websocketCapture": self.store.get_setting("capture_websocket_frames", "false") == "true"}

    def field_value(self, request_id: str, selector: dict[str, Any]) -> Any:
        detail = self.store.request_detail(request_id)
        direction = selector.get("direction", "response")
        if direction not in ("request", "response"):
            raise ValueError("字段方向必须是 request/response")
        kind, path = selector.get("kind", "pointer"), str(selector.get("path", ""))
        if kind == "header":
            return header_value(detail[f"{direction}Headers"], path)
        if kind == "query":
            return [value for key, value in parse_qsl(urlsplit(detail["url"]).query, keep_blank_values=True) if key == path]
        if kind == "status":
            return detail["status"]
        if kind == "pointer":
            if detail[f"{direction}Truncated"]:
                raise ValueError("采集截断，无法确定字段")
            return _json_pointer(json.loads(detail[f"{direction}BodyText"] or "null"), path)
        raise ValueError("不支持的字段来源")

    def pair(self, a_ids: list[str], b_ids: list[str], selector: dict[str, Any] | None = None, steps: dict[str, str] | None = None) -> dict[str, Any]:
        buckets = [defaultdict(list), defaultdict(list)]
        unpaired = []
        steps = steps or {}
        for side, ids in enumerate((a_ids, b_ids)):
            for request_id in ids:
                try:
                    row = self.store.request_summary(request_id)
                    key = f"{row['method']} {row['scheme']}://{row['host']}:{row['port']}{row['path'].split('?')[0]}"
                    if steps:
                        if request_id not in steps:
                            raise ValueError("缺少人工业务步骤")
                        key += " step=" + steps[request_id]
                    if selector:
                        value = self.field_value(request_id, selector)
                        if value in (None, "", []):
                            raise ValueError("业务键缺失")
                        key += " business=" + self.redactor.stable(json.dumps(value, sort_keys=True))
                    buckets[side][key].append(row)
                except (ValueError, KeyError, IndexError, TypeError) as error:
                    unpaired.append({"scenario": "a" if side == 0 else "b", "id": request_id, "reason": str(error)})
        pairs = []
        for key in sorted(set(buckets[0]) | set(buckets[1])):
            left, right = buckets[0][key], buckets[1][key]
            if len(left) == len(right) == 1:
                comparison = self.domain.compare(left[0]["id"], right[0]["id"])
                pairs.append({"key": self.redactor.text(key), "aId": left[0]["id"], "bId": right[0]["id"], "comparison": comparison, "differenceCount": sum(not item["ignored"] for item in comparison["differences"]), "durationRegressionMs": (right[0].get("durationMs") or 0) - (left[0].get("durationMs") or 0), "businessState": self.domain.business_state(right[0]["id"])})
            else:
                for side, rows in enumerate((left, right)):
                    unpaired.extend({"scenario": "a" if side == 0 else "b", "id": row["id"], "key": self.redactor.text(key), "reason": "缺少另一侧样本" if not left or not right else "重复业务键，请指定步骤或更精确业务键"} for row in rows)
        return {"aCount": len(a_ids), "bCount": len(b_ids), "pairs": pairs, "unpaired": unpaired, "pairing": "unique-endpoint-step-business-key", "boundary": "重复候选不按出现位置强行配对"}

    def baseline(self, scenario_id: str, name: str, selector: dict[str, Any] | None = None, steps: dict[str, str] | None = None) -> dict[str, Any]:
        scenario = self.store.get_scenario(scenario_id)
        ids = [row["id"] for row in scenario["requests"]]
        if not ids:
            raise ValueError("场景没有请求")
        failures = []
        for request_id in ids:
            row = self.store.request_summary(request_id)
            if row.get("requestState") != "completed" or not row.get("status") or row["status"] >= 400 or row.get("error") or row.get("ruleError") or self.domain.business_state(request_id)["state"] == "business-failure":
                failures.append(request_id)
        if failures:
            raise ValueError("基线含失败请求，请先修正场景成员")
        return self.save("qa_baseline", name, {"scenarioId": scenario_id, "versions": self.store.request_versions(ids), "selector": selector, "steps": steps or {}, "environment": self.store.get_setting("active_environment"), "createdAt": now_ms()})

    def compare_baseline(self, baseline_id: str, scenario_id: str, steps: dict[str, str] | None = None) -> dict[str, Any]:
        baseline = self.get(baseline_id, "qa_baseline")["config"]
        valid, changed = self.store.request_versions_valid(baseline["versions"])
        if not valid:
            raise ValueError(f"固定基线样本已变化或删除: {changed[:10]}")
        scenario = self.store.get_scenario(scenario_id)
        result = self.pair([item["id"] for item in baseline["versions"]], [item["id"] for item in scenario["requests"]], baseline.get("selector"), {**(baseline.get("steps") or {}), **(steps or {})})
        result["summary"] = {"addedOrUncovered": len(result["unpaired"]), "businessFailures": sum(pair["businessState"]["state"] == "business-failure" for pair in result["pairs"]), "changedPairs": sum(pair["differenceCount"] > 0 for pair in result["pairs"]), "slowerPairs": sum(pair["durationRegressionMs"] > 0 for pair in result["pairs"])}
        return result

    def checklist(self, request_ids: list[str], name: str) -> dict[str, Any]:
        generated = self.domain.test_checklist(request_ids)
        items = []
        for index, item in enumerate(generated.get("items") or []):
            for step in item.get("steps") or [item.get("title") or f"复核样本 {index+1}"]:
                items.append({"id": new_id("check"), "step": step, "expected": "确认状态码、业务码和关键字段符合需求", "status": "pending", "requestIds": [item["requestId"]] if item.get("requestId") else request_ids, "note": "", "source": item})
        if not items:
            items = [{"id": new_id("check"), "step": "在相同环境与前置条件下复现操作", "expected": "请求结果符合业务预期", "status": "pending", "requestIds": request_ids, "note": ""}]
        return self.save("qa_checklist", name, {"items": items, "generatedAt": now_ms(), "boundary": "仅人工执行，不生成或运行自动化测试"})

    def recipe_start(self, recipe_id: str) -> dict[str, Any]:
        recipe = self.get(recipe_id, "qa_recipe")
        steps = recipe["config"].get("steps") or []
        if not steps or len(steps) > 50:
            raise ValueError("场景需要1至50个步骤")
        return self.save("qa_run", recipe["name"], {"recipeId": recipe_id, "steps": steps, "index": 0, "status": "paused", "variables": {}, "results": [], "activePreview": None, "createdAt": now_ms(), "environment": self.store.get_setting("active_environment")})

    def recipe_step(self, run_id: str, execute: bool = False, action_id: str | None = None) -> dict[str, Any]:
        item = self.get(run_id, "qa_run")
        config = item["config"]
        index = int(config["index"])
        if config["status"] in ("failed", "completed"):
            raise ValueError("场景已结束，不能自动重试；请核对结果后创建新场景运行")
        if config["environment"] != self.store.get_setting("active_environment"):
            raise ValueError("环境已切换，请创建新的场景运行")
        step = config["steps"][index]
        def substitute(value):
            if isinstance(value, dict):
                return {k: substitute(v) for k, v in value.items()}
            if isinstance(value, list):
                return [substitute(v) for v in value]
            if isinstance(value, str):
                def replacement(match):
                    if match[1] not in config["variables"]:
                        raise ValueError(f"前置变量缺失: {match[1]}")
                    return str(config["variables"][match[1]])
                return re.sub(r"\$\{([a-zA-Z_][\w]*)\}", replacement, value)
            return value
        if not execute:
            preview = self.domain.replay(step["requestId"], edits=substitute(step.get("edits") or {}))
            config["activePreview"] = preview["id"]
            self.save("qa_run", item["name"], config, item["id"])
            return {"runId": run_id, "index": index, "step": step.get("name"), "preview": preview}
        if not action_id or action_id != config.get("activePreview"):
            raise ValueError("请确认本步骤的固定预览")
        result = self.domain.replay(step["requestId"], execute=True, action_id=action_id)
        config["activePreview"] = None
        config["results"].append({"index": index, "actionId": result["id"], "response": result["response"]})
        expected = int(step.get("expectedStatus") or 200)
        if result["status"] != "completed" or result["response"].get("status") != expected:
            config["status"] = "failed"
        else:
            try:
                captured = result["response"]["capturedRequestId"]
                for extract in step.get("extract") or []:
                    name = str(extract["name"])
                    if not re.fullmatch(r"[a-zA-Z_]\w*", name):
                        raise ValueError("变量名非法")
                    config["variables"][name] = self.field_value(captured, extract)
                config["index"] += 1
                config["status"] = "completed" if config["index"] >= len(config["steps"]) else "paused"
            except (ValueError, KeyError, TypeError, IndexError) as error:
                config["status"], config["error"] = "failed", str(error)
        saved = self.save("qa_run", item["name"], config, item["id"])
        return self.redactor.value(saved)

    def auth(self, batch_id: str, filters: dict[str, Any]) -> dict[str, Any]:
        rows = self.domain.query_all(batch_id, {**filters, "sort": "asc"}, max_rows=5000)
        events = []
        last: dict[tuple[str, str, str], str] = {}
        for row in rows:
            detail = self.store.request_detail(row["id"], preview_chars=0)
            reasons = []
            for direction, keys in (("request", ("authorization", "cookie")), ("response", ("set-cookie",))):
                for key in keys:
                    value = header_value(detail[f"{direction}Headers"], key)
                    identity = (row.get("sourceIp") or "", row["host"], key)
                    if value:
                        digest = self.redactor.stable(value)
                        if last.get(identity) != digest:
                            reasons.append({"type": "credential-change-candidate", "field": key, "value": digest})
                        last[identity] = digest
            if row.get("status") in (401, 403):
                reasons.append({"type": "auth-http-failure", "status": row["status"]})
            if re.search(r"refresh|token|login|oauth", row["path"], re.I):
                reasons.append({"type": "auth-endpoint-candidate"})
            location = header_value(detail["responseHeaders"], "location")
            if location:
                reasons.append({"type": "redirect", "location": self.redactor.url(location)})
            business = self.domain.business_state(row["id"])
            if business["state"] == "business-failure":
                reasons.append({"type": "business-failure", "evidence": business.get("evidence")})
            if reasons:
                events.append({"requestId": row["id"], "startedAt": row["startedAt"], "device": row.get("sourceIp"), "url": self.redactor.url(row["url"]), "reasons": reasons})
        matched = self.domain.query(batch_id, {**filters, "limit": 1})["matchCount"]
        return {"events": events, "coverage": {"scanned": len(rows), "matched": matched, "unchecked": max(0, matched-len(rows))}, "boundary": "时间线为候选解释，不证明凭据有效性；缺少登录、刷新或重定向请求时请补采。不会自行获取凭据。"}

    def file_info(self, request_id: str, direction: str) -> dict[str, Any]:
        detail = self.store.request_detail(request_id, preview_chars=0)
        data = self.store.body_bytes(request_id, direction)
        content_type = header_value(detail[f"{direction}Headers"], "content-type")
        result = {"requestId": request_id, "direction": direction, "mime": content_type, "size": len(data or b""), "sha256": hashlib.sha256(data).hexdigest() if data is not None else None, "captureState": detail["bodyStates"][direction], "truncated": detail[f"{direction}Truncated"], "contentDisposition": self.redactor.text(header_value(detail[f"{direction}Headers"], "content-disposition")), "available": data is not None}
        if "multipart" in content_type:
            result["fields"] = self.domain.read_content(request_id, direction=direction, kind="form")["value"]
        result["streams"] = self.redactor.value(detail.get("ruleEvidence", {}).get("streamEvents"))
        result["websocket"] = self.redactor.value(detail.get("ruleEvidence", {}).get("websocket"))
        return result

    def evidence_package(self, report_id: str) -> dict[str, Any]:
        report = self.store.get_report(report_id)
        evidence = self.store.list_evidence(report["runId"]) if report.get("runId") else []
        ids = {item["requestId"] for item in evidence}
        ids.update(item["id"] for item in report["scope"].get("requestVersions") or [])
        expected = {item["id"]: item["version"] for item in report["scope"].get("requestVersions") or []}
        expected.update({item["requestId"]: item["requestVersion"] for item in evidence})
        samples, missing = [], []
        for request_id in list(sorted(ids))[:200]:
            try:
                detail = self.store.request_detail(request_id)
                samples.append({"id": request_id, "version": detail["version"], "expectedVersion": expected.get(request_id), "sourceState": "valid" if expected.get(request_id) == detail["version"] else "stale-current-copy", "method": detail["method"], "url": self.redactor.url(detail["url"]), "status": detail["status"], "environment": detail.get("environment"), "appVersion": detail.get("appVersion"), "buildNumber": detail.get("buildNumber"), "requestHeaders": self.redactor.headers(detail["requestHeaders"]), "responseHeaders": self.redactor.headers(detail["responseHeaders"]), "requestBody": self.redactor.body(detail["requestBodyText"], header_value(detail["requestHeaders"], "content-type")), "responseBody": self.redactor.body(detail["responseBodyText"], header_value(detail["responseHeaders"], "content-type")), "bodyStates": detail["bodyStates"], "ruleEvidence": self.redactor.value(detail["ruleEvidence"])})
            except ValueError:
                missing.append(request_id)
        package = {"format": "ai-proxy-evidence-v1", "createdAt": now_ms(), "report": {**report, "title": self.redactor.text(report["title"]), "content": self.redactor.text(report["content"]), "scope": self.redactor.value(report["scope"])}, "evidence": self.redactor.value(evidence), "samples": samples, "checklists": [self.redactor.value(item) for item in self.store.list_configs("qa_checklist") if any(set(check.get("requestIds") or []) & ids for check in item["config"].get("items") or [])], "actions": [self.redactor.value(action) for action in self.store.list_debug_actions() if action["preview"].get("payload", {}).get("ownerRunId") == report.get("runId")], "missing": missing, "omittedCount": max(0, len(ids)-200), "boundary": "固定脱敏副本；不包含二进制原文、账户密钥；导入后仅供阅读，不能执行动作"}
        if len(json.dumps(package, ensure_ascii=False).encode()) > 20 * 1024 * 1024:
            raise ValueError("证据包超过20 MiB，请缩小报告范围")
        package["sha256"] = hashlib.sha256(json.dumps(package, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return package

    def import_package(self, package: dict[str, Any]) -> dict[str, Any]:
        if package.get("format") != "ai-proxy-evidence-v1":
            raise ValueError("不支持的证据包格式")
        package = dict(package)
        digest = package.pop("sha256", "")
        if digest != hashlib.sha256(json.dumps(package, sort_keys=True, ensure_ascii=False).encode()).hexdigest():
            raise ValueError("证据包内容校验失败")
        package["readOnly"] = True
        return self.store.save_config({"kind": "evidence_package", "name": package.get("report", {}).get("title") or "导入证据包", "config": package})

    def operations(self, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 500))
        with self.store.connect() as db:
            replay_ids = [row[0] for row in db.execute("SELECT id FROM replay_actions ORDER BY created_at DESC LIMIT ?", (limit,))]
            ticket_ids = [row[0] for row in db.execute("SELECT id FROM tickets ORDER BY created_at DESC LIMIT ?", (limit,))]
        rows = [{"kind": "replay", **self.store.get_replay_action(item)} for item in replay_ids]
        rows.extend({"kind": "ticket", **self.store.get_ticket(item)} for item in ticket_ids)
        rows.extend({"kind": "debug", **item} for item in self.store.list_debug_actions(limit))
        return self.redactor.value(sorted(rows, key=lambda row: row["createdAt"], reverse=True)[:limit])

    def matrix_preview(self, request_id: str, session_id: str, case: str, matrix_id: str | None = None) -> dict[str, Any]:
        templates = {
            "empty-list": (200, {"data": [], "code": 0}, 0, False),
            "missing-field": (200, {}, 0, False),
            "business-error": (200, {"code": 10001, "message": "人工业务错误场景"}, 0, False),
            "401": (401, {"message": "Unauthorized"}, 0, False),
            "429": (429, {"message": "Too Many Requests"}, 0, False),
            "500": (500, {"message": "Internal Server Error"}, 0, False),
            "delay": (200, {"code": 0}, 3000, False),
            "disconnect": (200, {}, 0, True),
        }
        if case not in templates:
            raise ValueError("不支持的故障模板")
        detail = self.store.request_summary(request_id)
        if matrix_id:
            matrix = self.get(matrix_id, "qa_matrix")
            for action_id in matrix["config"].get("actionIds") or []:
                if self.store.get_debug_action(action_id)["status"] in ("applied", "restoring", "restore-conflict"):
                    raise ValueError("请先恢复当前场景，再预览下一项")
        else:
            matrix = self.save("qa_matrix", f"故障矩阵 {detail['method']} {detail['path'].split('?')[0]}", {"requestId": request_id, "actionIds": [], "results": []})
        status, body, delay, disconnect = templates[case]
        directory = self.store.data_dir / "generated-mocks"
        directory.mkdir(exist_ok=True)
        path = directory / f"{new_id('mock')}.json"
        path.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        self.store.add_session_file(session_id, str(path))
        action = self.domain.preview_debug_action("map-local", {"source": detail["url"], "filePath": str(path), "ownerSessionId": session_id, "targetRequestId": request_id, "targetBatchId": detail["batchId"], "sourceIp": detail.get("sourceIp"), "responseStatus": status, "delayMs": delay, "disconnect": disconnect, "matrixId": matrix["id"], "case": case, "impact": "匹配此接口的代理流量；请使用同一设备手动执行后验证"})
        config = matrix["config"]
        config["actionIds"].append(action["id"])
        self.save("qa_matrix", matrix["name"], config, matrix["id"])
        return {"matrixId": matrix["id"], "case": case, "action": action}

    def matrix_record(self, matrix_id: str, action_id: str) -> dict[str, Any]:
        matrix = self.get(matrix_id, "qa_matrix")
        if action_id not in matrix["config"].get("actionIds", []):
            raise ValueError("动作不属于此矩阵")
        result = self.domain.verify_debug_action(action_id)
        matrix["config"].setdefault("results", []).append({"actionId": action_id, "recordedAt": now_ms(), "verification": result})
        self.save("qa_matrix", matrix["name"], matrix["config"], matrix["id"])
        return result

    def matrix_restore(self, matrix_id: str) -> dict[str, Any]:
        matrix = self.get(matrix_id, "qa_matrix")
        results = []
        for action_id in reversed(matrix["config"].get("actionIds", [])):
            action = self.store.get_debug_action(action_id)
            if action["status"] == "applied":
                results.append(self.domain.restore_debug_action(action_id))
        return {"matrixId": matrix_id, "results": results, "boundary": "只恢复本组已应用动作；冲突时保留现配置"}
