from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from .errors import AppError
from .privacy import Redactor
from .jobs import check_cancelled
from .store import Store, new_id, now_ms


TRACE_PARENT = re.compile(
    r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-(.*))?$"
)
ZERO_TRACE = "0" * 32
ZERO_SPAN = "0" * 16
NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def normalize_headers(headers: list[Any]) -> list[list[str]]:
    result = []
    for item in headers:
        if isinstance(item, dict) and "name" in item:
            result.append([str(item["name"]), str(item.get("value", ""))])
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            result.append([str(item[0]), str(item[1])])
    return result


def header_value(headers: list[list[str]], name: str) -> str:
    target = name.lower()
    for key, value in normalize_headers(headers):
        if key.lower() == target:
            return value
    return ""


def parse_trace_context(headers: list[list[str]]) -> dict[str, Any]:
    value = header_value(headers, "traceparent").strip().lower()
    match = TRACE_PARENT.match(value)
    if not match:
        return {"valid": False, "traceId": None, "parentSpanId": None, "traceState": header_value(headers, "tracestate")}
    version, trace_id, parent_span_id, flags, extra = match.groups()
    valid = (
        version != "ff"
        and not (version == "00" and extra)
        and trace_id != ZERO_TRACE
        and parent_span_id != ZERO_SPAN
    )
    return {
        "valid": valid,
        "traceId": trace_id if valid else None,
        "parentSpanId": parent_span_id if valid else None,
        "traceState": header_value(headers, "tracestate"),
        "flags": int(flags, 16),
    }


def _json_pointer(value: Any, pointer: str) -> Any:
    if pointer == "":
        return value
    if not pointer.startswith("/") or re.search(r"~(?![01])", pointer):
        raise ValueError("非法 JSON Pointer")
    current = value
    for raw in pointer[1:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", token):
                raise ValueError("非法数组下标")
            current = current[int(token)]
        elif isinstance(current, dict):
            current = current[token]
        else:
            raise KeyError(pointer)
    return current


def _walk_json(value: Any, prefix: str = "") -> dict[str, Any]:
    result: dict[str, Any] = {}
    if isinstance(value, dict):
        if not value:
            result[prefix or "/"] = value
        for key, item in value.items():
            token = str(key).replace("~", "~0").replace("/", "~1")
            result.update(_walk_json(item, f"{prefix}/{token}"))
    elif isinstance(value, list):
        if not value:
            result[prefix or "/"] = value
        for index, item in enumerate(value):
            result.update(_walk_json(item, f"{prefix}/{index}"))
    else:
        result[prefix or "/"] = value
    return result


def _percentile(values: list[int], percentile: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return ordered[index]


class DomainService:
    def __init__(self, store: Store, emit) -> None:
        self.store = store
        self.emit = emit
        self.redactor = Redactor(store.get_setting("redaction_salt", "") or "local")

    # Scope
    def build_scope(
        self,
        batch_id: str,
        filters: dict[str, Any] | None = None,
        selected_ids: list[str] | None = None,
        scenario_id: str | None = None,
        mode: str = "snapshot",
    ) -> dict[str, Any]:
        if mode != "snapshot":
            raise AppError("scope_invalid", "目前只支持固定snapshot范围，请重新选择分析范围")
        filters = dict(filters or {})
        snapshot_at = now_ms()
        filters.pop("cursor", None)
        filters["startedBefore"] = min(int(filters.get("startedBefore") or snapshot_at), snapshot_at)
        selection = None
        if selected_ids is not None:
            if not selected_ids:
                raise AppError("scope_selection_missing", "选择范围为空，请先选择请求")
            selection = set(selected_ids)
        if scenario_id:
            try:
                scenario = self.store.get_scenario(scenario_id)
            except ValueError as error:
                raise AppError("scope_scenario_missing", "原场景已删除，请重新选择场景；未调用模型。") from error
            if scenario["batchId"] != batch_id:
                raise AppError("scope_scenario_invalid", "场景不属于当前批次，请调整场景")
            members = {item["id"] for item in scenario["requests"]}
            selection = members if selection is None else selection & members
        if selection is not None:
            if not selection:
                raise AppError("scope_empty", "选择或场景范围为空，请先补充样本")
            if len(selection) > 100_000:
                raise ValueError("范围超过10万条，请缩小选择或场景")
            rows = []
            ids = sorted(selection)
            for offset in range(0, len(ids), 500):
                check_cancelled()
                page = self.query(batch_id, {**filters, "includeIds": ids[offset:offset + 500], "limit": 500})
                rows.extend(page["items"])
            if selected_ids is not None and set(selected_ids) != {row["id"] for row in rows}:
                raise AppError("scope_selection_missing", "选择包含已删除、跨批次、不属于场景或不符合筛选条件的请求，请重新选择；未调用模型。")
        else:
            total = self.query(batch_id, {**filters, "limit": 1})["matchCount"]
            if total > 100_000:
                raise ValueError("范围超过10万条，请按设备、时间或接口缩小范围；不会将采样冒充全量")
            rows = self.query_all(batch_id, filters)
        matched_count = len(rows)
        unfinished = [row for row in rows if row.get("requestState") == "in_progress"]
        if unfinished and selected_ids is not None:
            raise AppError("scope_unfinished", f"所选请求中有{len(unfinished)}条仍在进行中，请等待完成或取消选择后再分析；尚未创建任务，也未调用模型。")
        # Completed records have stable versions. Never freeze a moving response into
        # an otherwise immutable Run; publish the omitted coverage explicitly.
        rows = [row for row in rows if row.get("requestState") != "in_progress"]
        if not rows:
            raise AppError("scope_empty", f"分析范围没有已完成请求（{len(unfinished)}条仍在进行中），请等待完成、处理超时或调整筛选；尚未调用模型。")
        with self.store.connect() as db:
            batch_row = db.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if batch_row is None:
            raise AppError("scope_batch_missing", "原批次已删除，请重新选择范围；未调用模型。")
        batch = self.store._batch_to_dict(batch_row)
        scope = {
            "id": new_id("scope"),
            "batchId": batch_id,
            "batchLabel": batch["label"],
            "filters": filters,
            "selectedIds": selected_ids or [],
            "scenarioId": scenario_id,
            "mode": mode,
            "snapshotAt": snapshot_at,
            "configHash": self.store.config_hash(),
            "configVersion": self.store.config_version(),
            "requestVersions": [{"id": row["id"], "version": row["version"]} for row in rows],
            "requestCount": len(rows),
            "batchCount": self.store.query_requests(batch_id, limit=1)["batchCount"],
            "devices": sorted({row["sourceIp"] for row in rows if row.get("sourceIp")}),
            "hosts": sorted({row["host"] for row in rows}),
            "environments": sorted({row["environment"] for row in rows if row.get("environment")}),
            "appVersions": sorted({row["appVersion"] for row in rows if row.get("appVersion")}),
            "buildNumbers": sorted({row["buildNumber"] for row in rows if row.get("buildNumber")}),
            "businessRules": self.store.list_configs("business_rule"),
            "startedAfter": min((row["startedAt"] for row in rows), default=None),
            "startedBefore": max((row["startedAt"] for row in rows), default=None),
            "unfinishedCount": 0,
            "matchedCountAtCreation": matched_count,
            "excludedUnfinishedCount": len(unfinished),
            "expired": False,
        }
        scope["signature"] = self._scope_signature(scope)
        return scope

    def _scope_signature(self, scope: dict[str, Any]) -> str:
        content = {key: value for key, value in scope.items() if key != "signature"}
        key = (self.store.get_setting("redaction_salt", "") or "").encode()
        return hmac.new(key, json.dumps(content, sort_keys=True, ensure_ascii=False).encode(), hashlib.sha256).hexdigest()

    def validate_scope_payload(self, scope: dict[str, Any]) -> None:
        if not hmac.compare_digest(str(scope.get("signature", "")), self._scope_signature(scope)):
            raise AppError("scope_invalid", "分析范围已被修改，请重新选择范围")
        if scope.get("expired") or scope.get("configHash") != self.store.config_hash():
            raise AppError("scope_expired", "范围配置已失效，请重新选择范围")
        valid, changed = self.store.request_versions_valid(scope.get("requestVersions") or [])
        if not valid or not scope.get("requestVersions"):
            raise AppError("scope_expired", f"范围为空或样本已变化: {changed[:10]}")

    def query_all(self, batch_id: str, filters: dict[str, Any], max_rows: int = 100_000) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        cursor = None
        while len(items) < max_rows:
            check_cancelled()
            page = self.query(batch_id, {**filters, "cursor": cursor, "limit": 2000})
            items.extend(page["items"])
            cursor = page.get("nextCursor")
            if not cursor or not page["items"]:
                break
        return items[:max_rows]

    def query(self, batch_id: str, filters: dict[str, Any]) -> dict[str, Any]:
        self.validate_scope(filters.get("scopeRunId"))
        self.refresh_business_index(batch_id)
        result = self.store.query_requests(
            batch_id,
            query=str(filters.get("query", "")),
            method=str(filters.get("method", "")),
            status=str(filters.get("status", "")),
            source_ip=str(filters.get("sourceIp", "")),
            host=str(filters.get("host", "")),
            path_prefix=str(filters.get("pathPrefix", "")),
            path_exact=str(filters.get("pathExact", "")),
            started_after=filters.get("startedAfter"),
            started_before=filters.get("startedBefore"),
            trace_id=str(filters.get("traceId", "")),
            environment=str(filters.get("environment", "")),
            app_version=str(filters.get("appVersion", "")),
            request_state=str(filters.get("requestState", "")),
            errors_only=bool(filters.get("errorsOnly", False)),
            limit=int(filters.get("limit", 100)),
            cursor=filters.get("cursor"),
            sort=str(filters.get("sort", "desc")),
            since_started_at=filters.get("sinceStartedAt"),
            exclude_ids=filters.get("excludeIds"),
            include_ids=filters.get("includeIds"),
            scope_run_id=filters.get("scopeRunId"),
        )
        self.validate_scope(filters.get("scopeRunId"))
        return result

    def validate_scope(self, run_id: str | None) -> None:
        if not run_id:
            return
        scope = self.store.get_run(run_id)["scope"]
        valid, changed = self.store.request_versions_valid(scope.get("requestVersions") or [])
        if scope.get("expired") or not valid or scope.get("configHash") != self.store.config_hash():
            raise AppError("scope_expired", f"分析快照已失效，请创建新范围。变更请求: {changed[:10]}")

    def tree(
        self,
        batch_id: str,
        filters: dict[str, Any] | None = None,
        parent: dict[str, Any] | None = None,
        limit: int = 500,
    ) -> dict[str, Any]:
        """Return one level of the capture tree for the requested parent node."""
        filters = dict(filters or {})
        self.refresh_business_index(batch_id)
        parent = dict(parent or {"type": "root"})
        parent_type = str(parent.get("type") or "root")
        safe_limit = max(1, min(int(limit), 2000))
        batch_page = self.store.query_requests(batch_id, limit=1)
        coverage = {
            "batchCount": batch_page["batchCount"],
            "matchedCount": self.store.query_requests(batch_id, **self._tree_store_filters(filters, limit=1))[
                "matchCount"
            ],
        }

        if parent_type == "hosts":
            page = self.store.query_requests(batch_id, **self._tree_store_filters(filters), host_summary=True)
            nodes = []
            for row in page["items"]:
                root = self._tree_root(row)
                nodes.append({"type": "host", "key": root, "root": root, "name": root.split("://", 1)[-1],
                              "scheme": row["scheme"], "host": row["host"], "port": row["port"],
                              "count": row["count"], "failureCount": row["failures"], "inProgressCount": row["pending"],
                              "latestStatus": None, "latestStartedAt": row["latest"]})
            offset = max(0, int(parent.get("offset") or 0))
            if parent.get("targetId"):
                target_root = self._tree_root(self.store.request_summary(parent["targetId"]))
                index = next((i for i, node in enumerate(nodes) if node["root"] == target_root), None)
                if index is not None:
                    offset = index // safe_limit * safe_limit
            offset = min(offset, max(0, (len(nodes) - 1) // safe_limit * safe_limit))
            return {"nodes": nodes[offset:offset + safe_limit], "offset": offset,
                    "nextOffset": offset + safe_limit if offset + safe_limit < len(nodes) else None,
                    "nodeCount": len(nodes), "coverage": coverage}

        if parent_type in ("group", "host-requests"):
            root = str(parent.get("root") or "")
            method = str(parent.get("method") or "").upper()
            path = str(parent.get("path") or "/")
            parsed_root = urlsplit(root)
            offset = max(0, int(parent.get("offset") or 0))
            restrictions = {"path_exact": path, "method": method} if parent_type == "group" else {}
            page = self.store.query_requests(batch_id, **(self._tree_store_filters(filters, safe_limit) | restrictions | {"host": parsed_root.hostname or "", "scheme": parsed_root.scheme, "port": parsed_root.port or (443 if parsed_root.scheme == "https" else 80), "offset": offset, "seek_id": parent.get("targetId"), "cursor": None}))
            offset = page.get("offset", offset)
            items = page["items"]
            next_offset = offset + len(items) if offset + len(items) < page["matchCount"] else None
            return {
                "parent": parent,
                "items": items,
                "offset": offset,
                "nextOffset": next_offset,
                "matchCount": page["matchCount"],
                "coverage": coverage,
            }

        subtree_filters = self._tree_store_filters(filters)
        if parent_type in ("host", "directory"):
            parsed = urlsplit(str(parent.get("root") or ""))
            subtree_filters.update(host=parsed.hostname or "", scheme=parsed.scheme,
                                   port=parsed.port or (443 if parsed.scheme == "https" else 80))
        grouped_page = self.store.query_requests(batch_id, **subtree_filters, tree_summary=True)
        rows = grouped_page["items"]
        coverage["partial"] = grouped_page["partial"]
        coverage["groupedCount"] = len(rows)
        coverage["businessStateChecked"] = True
        if parent_type == "search":
            nodes = self._group_nodes(rows)
        elif parent_type == "root":
            nodes = self._host_nodes(rows)
        else:
            root = str(parent.get("root") or "")
            host_rows = [row for row in rows if self._tree_root(row) == root]
            prefix = "" if parent_type == "host" else str(parent.get("path") or "")
            nodes, truncated = self._directory_nodes(host_rows, root, prefix, 100_000)
            coverage["partial"] = coverage["partial"] or truncated
        offset = max(0, int(parent.get("offset") or 0))
        target_id = parent.get("targetId")
        if target_id and parent_type == "root":
            target_root = self._tree_root(self.store.request_summary(target_id))
            index = next((index for index, node in enumerate(nodes) if node["root"] == target_root), None)
            if index is not None:
                offset = index // safe_limit * safe_limit
        target_path = parent.get("targetPath")
        if target_path and parent_type in ("host", "directory"):
            target_path = str(target_path).split("?")[0]
            index = next((index for index, node in enumerate(nodes) if node.get("path") == target_path or node["type"] == "directory" and target_path.startswith(str(node.get("path", "")).rstrip("/") + "/")), None)
            if index is not None:
                offset = index // safe_limit * safe_limit
        offset = min(offset, max(0, (len(nodes) - 1) // safe_limit * safe_limit))
        page = nodes[offset:offset+safe_limit]
        return {"parent": parent, "nodes": page, "offset": offset, "nextOffset": offset + len(page) if offset + len(page) < len(nodes) else None, "nodeCount": len(nodes), "truncated": bool(coverage.get("partial")), "coverage": coverage, "directories": sum(node["type"] == "directory" for node in page), "groups": sum(node["type"] == "group" for node in page)}

    @staticmethod
    def _tree_store_filters(filters: dict[str, Any], limit: int = 1) -> dict[str, Any]:
        allowed = {
            "query",
            "method",
            "status",
            "sourceIp",
            "host",
            "pathPrefix",
            "pathExact",
            "startedAfter",
            "startedBefore",
            "traceId",
            "environment",
            "appVersion",
            "requestState",
            "errorsOnly",
            "sort",
            "limit",
            "cursor",
            "sinceStartedAt",
            "excludeIds",
            "scopeRunId",
        }
        aliases = {
            "sourceIp": "source_ip", "pathPrefix": "path_prefix", "pathExact": "path_exact",
            "startedAfter": "started_after", "startedBefore": "started_before", "traceId": "trace_id",
            "appVersion": "app_version", "requestState": "request_state", "errorsOnly": "errors_only",
            "sinceStartedAt": "since_started_at", "excludeIds": "exclude_ids", "scopeRunId": "scope_run_id",
        }
        return {aliases.get(key, key): value for key, value in filters.items() if key in allowed} | {"limit": limit}

    @staticmethod
    def _tree_root(row: dict[str, Any]) -> str:
        default_port = 443 if row["scheme"] == "https" else 80
        port = "" if int(row["port"]) == default_port else f":{row['port']}"
        host = str(row["host"])
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"{row['scheme']}://{host}{port}"

    def _host_nodes(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            buckets[self._tree_root(row)].append(row)
        return [
            {
                "type": "host",
                "key": root,
                "root": root,
                "name": root.split("://", 1)[-1],
                "scheme": items[0]["scheme"],
                "host": items[0]["host"],
                "port": items[0]["port"],
                **self._node_stats(items),
            }
            for root, items in sorted(buckets.items(), key=lambda item: item[0])
        ]

    def _group_nodes(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            path = row["path"].split("?")[0] or "/"
            buckets[f"{self._tree_root(row)}|{row['method']}|{path}"].append(row)
        nodes = []
        for key, items in buckets.items():
            root, method, path = key.split("|", 2)
            nodes.append(
                {
                    "type": "group",
                    "key": f"group:{key}",
                    "root": root,
                    "method": method,
                    "path": path,
                    **self._node_stats(items),
                }
            )
        return sorted(nodes, key=lambda item: (-item["count"], item["key"]))

    def _directory_nodes(
        self,
        rows: list[dict[str, Any]],
        root: str,
        prefix: str,
        limit: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        normalized = prefix if prefix != "/" else ""
        if normalized:
            rows = [
                row
                for row in rows
                if (row["path"].split("?")[0] or "/") == normalized
                or (row["path"].split("?")[0] or "/").startswith(normalized + "/")
            ]
        tree: dict[str, Any] = {"children": {}, "rows": [], "direct": False}
        for row in rows:
            pathname = row["path"].split("?")[0] or "/"
            tree["rows"].append(row)
            if pathname == (normalized or "/"):
                tree["direct"] = True
                continue
            relative = pathname[len(normalized) :] if normalized else pathname
            # Empty and trailing segments are meaningful URL characters.
            segments = (relative[1:] if relative.startswith("/") else relative).split("/")
            node = tree
            for segment in segments:
                node = node["children"].setdefault(segment, {"children": {}, "rows": [], "direct": False})
                node["rows"].append(row)
            node["direct"] = True

        direct_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            pathname = row["path"].split("?")[0] or "/"
            if pathname == (normalized or "/"):
                direct_groups[(row["method"], pathname)].append(row)
        nodes = [
            {
                "type": "group",
                "key": f"group:{root}|{method}|{path}",
                "root": root,
                "method": method,
                "path": path,
                **self._node_stats(items),
            }
            for (method, path), items in direct_groups.items()
        ]
        for name, child in tree["children"].items():
            labels = [name]
            node = child
            while not self._node_direct_groups(node) and len(node["children"]) == 1:
                child_name, node = next(iter(node["children"].items()))
                labels.append(child_name)
            path = f"{normalized}/{labels[0]}" if normalized else f"/{labels[0]}"
            for label in labels[1:]:
                path += f"/{label}"
            nodes.append(
                {
                    "type": "directory",
                    "key": f"dir:{root}:{path}",
                    "root": root,
                    "name": "/".join(labels) or "/",
                    "path": path,
                    **self._node_stats(node["rows"]),
                }
            )
        nodes.sort(key=lambda item: (item["type"] != "directory", -item["count"], item.get("name") or item.get("path") or ""))
        return nodes[:limit], len(nodes) > limit

    @staticmethod
    def _node_direct_groups(node: dict[str, Any]) -> bool:
        return bool(node.get("direct"))

    @staticmethod
    def _node_stats(items: list[dict[str, Any]]) -> dict[str, Any]:
        latest = max(items, key=lambda item: item["startedAt"])
        return {
            "count": sum(item.get("_count", 1) for item in items),
            "failureCount": sum(item.get("_failures", 0) for item in items) if any("_count" in item for item in items) else sum(
                1
                for item in items
                if (item.get("status") or 0) >= 400
                or item.get("error")
                or item.get("tlsError")
                or item.get("ruleError")
                or item.get("businessState", {}).get("state") == "business-failure"
            ),
            "inProgressCount": sum(item.get("_pending", int(item.get("requestState") == "in_progress")) for item in items),
            "latestStatus": latest.get("status"),
            "latestStartedAt": latest.get("startedAt"),
        }

    def refresh_business_index(self, batch_id: str) -> None:
        rules = self.store.list_configs("business_rule")
        digest = hashlib.sha256(json.dumps(rules, sort_keys=True).encode()).hexdigest()
        key = f"business-index:{batch_id}"
        if self.store.get_setting(key) == digest:
            return
        cursor = ""
        while True:
            with self.store.connect() as db:
                rows = db.execute("SELECT id, version FROM requests WHERE batch_id = ? AND id > ? ORDER BY id LIMIT 500", (batch_id, cursor)).fetchall()
            if not rows:
                break
            updates = [(self.business_state(row["id"], rules)["state"], row["id"], row["version"]) for row in rows]
            with self.store.connect() as db:
                db.executemany("UPDATE requests SET business_state = ? WHERE id = ? AND version = ?", updates)
            cursor = rows[-1]["id"]
        self.store.set_setting(key, digest)

    def business_state(self, request_id: str, rules: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        rules = rules if rules is not None else self.store.list_configs("business_rule")
        if not any(rule["enabled"] for rule in rules):
            return {"state": "unknown", "configured": False}
        detail = self.store.request_detail(request_id)
        for config in rules:
            if not config["enabled"]:
                continue
            rule = config["config"]
            if rule.get("hostPattern") and not re.search(str(rule["hostPattern"]), detail["host"]):
                continue
            if rule.get("pathPattern") and not re.search(str(rule["pathPattern"]), detail["path"]):
                continue
            pointer = str(rule.get("errorPointer") or "")
            success_values = [str(value) for value in rule.get("successValues") or []]
            statuses = [int(value) for value in rule.get("successStatuses") or [200]]
            if detail["status"] not in statuses:
                return {
                    "state": "http-failure",
                    "configured": True,
                    "ruleId": config["id"],
                    "ruleName": config["name"],
                    "evidence": {"locator": "response/status", "value": detail["status"]},
                }
            if not pointer:
                return {"state": "success", "configured": True, "ruleId": config["id"], "ruleName": config["name"]}
            try:
                parsed = json.loads(detail["responseBodyText"] or "null")
                value = _json_pointer(parsed, pointer)
            except (json.JSONDecodeError, KeyError, IndexError, ValueError):
                return {
                    "state": "unknown",
                    "configured": True,
                    "ruleId": config["id"],
                    "ruleName": config["name"],
                    "reason": "业务字段不存在或正文不是有效 JSON",
                }
            success = str(value) in success_values
            return {
                "state": "success" if success else "business-failure",
                "configured": True,
                "ruleId": config["id"],
                "ruleName": config["name"],
                "evidence": {"locator": f"response#{pointer}", "value": self.redactor.value(value, pointer.rsplit("/", 1)[-1])},
                "errorMap": rule.get("errorMap") or {},
            }
        return {"state": "unknown", "configured": False}

    # Content
    def read_content(
        self,
        request_id: str,
        *,
        direction: str = "response",
        header_name: str = "",
        query_key: str = "",
        pointer: str = "",
        offset: int = 0,
        limit: int = 12_000,
        raw_preview: bool = False,
        local_raw: bool = False,
        kind: str = "body",
        form_key: str = "",
    ) -> dict[str, Any]:
        if direction not in ("request", "response"):
            raise ValueError("direction 必须是 request 或 response")
        detail = self.store.request_detail(request_id, preview_chars=0 if local_raw else None)
        limit = max(1, min(int(limit), 60_000))
        offset = max(0, int(offset))
        result: dict[str, Any] = {
            "requestId": request_id,
            "requestVersion": detail["version"],
            "direction": direction,
            "captureBodyState": detail["bodyStates"][direction],
            "storedSize": detail[f"{direction}BodySize"],
            "truncated": detail[f"{direction}Truncated"],
            "locator": f"{direction}",
        }
        if kind == "url":
            return {**result, "kind": "url", "value": self.redactor.url(detail["url"]), "locator": "url", "available": True}
        if local_raw and not header_name and not query_key and not pointer and kind == "body":
            chunk, has_more = self.store.body_range(request_id, direction, offset, limit)
            return {**result, "kind": "body", "value": chunk, "available": detail["bodyStates"][direction] not in ("missing", "stream-not-saved"), "offset": offset, "nextOffset": offset + len(chunk) if has_more else None, "previewState": "truncated-preview" if has_more else "complete", "view": "local-original"}
        if header_name:
            headers = detail[f"{direction}Headers"]
            value = header_value(headers, header_name)
            result.update(
                {
                    "kind": "header",
                    "name": header_name,
                    "value": [self.redactor.text(str(v), header_name) for k, v in headers if k.lower() == header_name.lower()],
                    "present": any(key.lower() == header_name.lower() for key, _ in headers),
                    "locator": f"{direction}/headers/{header_name}",
                }
            )
            return result
        if query_key:
            values = [
                value
                for key, value in parse_qsl(urlsplit(detail["url"]).query, keep_blank_values=True)
                if key == query_key
            ]
            result.update(
                {
                    "kind": "query",
                    "name": query_key,
                    "value": [self.redactor.text(item, query_key) for item in values],
                    "present": bool(values),
                    "locator": f"url/query/{query_key}",
                }
            )
            return result
        detail_text = detail[f"{direction}BodyText"]
        content_type = header_value(detail[f"{direction}Headers"], "content-type")
        if detail_text is None:
            reason = detail["bodyStates"][direction]
            if detail["method"] == "CONNECT":
                reason = "connect-tunnel"
            elif reason == "available":
                reason = "missing"
            result.update({"kind": "body", "available": False, "reason": reason, "value": None})
            return result
        if form_key or kind == "form":
            from email.parser import BytesParser
            from email.policy import default
            fields = []
            if "application/x-www-form-urlencoded" in content_type:
                fields = [{"name": k, "value": self.redactor.text(v, k)} for k, v in parse_qsl(detail_text, keep_blank_values=True)]
            elif "multipart/form-data" in content_type:
                raw = self.store.body_bytes(request_id, direction) or b""
                message = BytesParser(policy=default).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw)
                for part in message.iter_parts() if message.is_multipart() else []:
                    name = part.get_param("name", header="content-disposition") or ""
                    data = part.get_payload(decode=True) or b""
                    filename = part.get_filename()
                    fields.append({"name": name, "filename": self.redactor.text(filename or ""), "mime": part.get_content_type(), "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "value": None if filename else self.redactor.text(data.decode(part.get_content_charset() or "utf-8", "replace"), name)})
            else:
                return {**result, "available": False, "reason": "unsupported-form-content-type", "value": []}
            values = [field for field in fields if not form_key or field["name"] == form_key]
            return {**result, "kind": "form", "value": values, "present": bool(values), "available": True, "locator": f"{direction}/form/{form_key}", "partial": bool(detail[f"{direction}Truncated"])}
        parsed: Any
        can_json = False
        try:
            parsed = json.loads(detail_text)
            can_json = True
        except json.JSONDecodeError:
            parsed = None
        if pointer or kind == "json-pointer":
            if not can_json:
                return {**result, "kind": "json-pointer", "available": False, "reason": "capture-truncated" if detail[f"{direction}Truncated"] else "invalid-json", "locator": f"{direction}#{pointer}", "value": None}
            try:
                value = _json_pointer(parsed, pointer)
            except (KeyError, IndexError, ValueError) as error:
                return {**result, "kind": "json-pointer", "available": False, "reason": "capture-truncated" if detail[f"{direction}Truncated"] else "invalid-or-missing-pointer", "error": str(error), "locator": f"{direction}#{pointer}", "value": None}
            result.update(
                {
                    "kind": "json-pointer",
                    "locator": f"{direction}#{pointer}",
                    "value": self.redactor.value(value, pointer.replace("~1", "/").replace("~0", "~")),
                    "available": True,
                    "previewState": "complete-value",
                }
            )
            return result
        # Redact with complete structural context before slicing. A partial JSON fragment
        # cannot safely identify a short password or a secret split across two pages.
        sanitized = self.redactor.body(detail_text, content_type)
        safe_text = sanitized if isinstance(sanitized, str) else json.dumps(sanitized, ensure_ascii=False, indent=2)
        full_length = len(safe_text)
        chunk = safe_text[offset : offset + limit]
        value: Any = chunk
        if can_json and offset == 0 and full_length <= limit and not raw_preview:
            value = sanitized
        result.update(
            {
                "kind": "body",
                "available": True,
                "value": value,
                "contentType": content_type,
                "totalLength": full_length,
                "offset": offset,
                "nextOffset": offset + len(chunk) if offset + len(chunk) < full_length else None,
                "locator": f"{direction}#chars/{offset}-{offset + len(chunk)}",
                "previewState": "truncated-preview" if full_length > len(chunk) else "complete",
                "jsonValid": can_json,
            }
        )
        return result

    def evidence(
        self,
        run_id: str,
        request_id: str,
        direction: str,
        locator: str,
        summary: str,
        value: Any,
    ) -> dict[str, Any]:
        request = self.store.request_summary(request_id)
        return self.store.add_evidence(
            run_id,
            request_id,
            request["version"],
            direction,
            summary,
            locator=locator,
            redacted_value=self.redactor.value(value),
        )

    # Aggregation and comparison
    def aggregate(self, batch_id: str, filters: dict[str, Any], group_by: str = "endpoint") -> dict[str, Any]:
        rows = self.query_all(batch_id, filters)
        business_rules = self.store.list_configs("business_rule")
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            if group_by == "status":
                key = str(row.get("status") or "pending")
            elif group_by == "business":
                state = row["businessState"]["state"]
                key = state
            elif group_by == "device":
                key = row.get("sourceIp") or "unknown"
            else:
                path = row["path"].split("?")[0]
                key = f"{row['method']} {row['scheme']}://{row['host']}:{row['port']}{path}"
            groups[key].append(row)
        output = []
        for key, items in groups.items():
            durations = [int(item["durationMs"]) for item in items if item.get("durationMs") is not None]
            failures = [
                item
                for item in items
                if (item.get("status") or 0) >= 400
                or item.get("error")
                or item.get("ruleError")
                or item.get("tlsError")
                or item.get("businessState", {}).get("state") == "business-failure"
            ]
            output.append(
                {
                    "key": self.redactor.text(key),
                    "count": len(items),
                    "failureCount": len(failures),
                    "failureRate": (len(failures) / len(items)) if items else 0,
                    "p50Ms": _percentile(durations, 0.5),
                    "p95Ms": _percentile(durations, 0.95),
                    "maxMs": max(durations) if durations else None,
                    "sampleIds": [item["id"] for item in items[:8]],
                    "latestStatus": max(items, key=lambda row: (row["startedAt"], row["id"])).get("status"),
                    "latestStartedAt": max(item["startedAt"] for item in items),
                }
            )
        output.sort(key=lambda item: (-item["failureCount"], -(item["p95Ms"] or 0), item["key"]))
        return {
            "groupBy": group_by,
            "totalSamples": len(rows),
            "coverage": {
                "batchCount": self.store.query_requests(batch_id, limit=1)["batchCount"],
                "matchedCount": self.query(batch_id, {**filters, "limit": 1})["matchCount"],
                "scannedCount": len(rows),
                "uncheckedCount": max(0, self.query(batch_id, {**filters, "limit": 1})["matchCount"] - len(rows)),
                "unfinishedCount": sum(row["requestState"] == "in_progress" for row in rows),
                "percentileBasis": "scanned-samples",
            },
            "groups": output,
        }

    def compare(self, request_id_a: str, request_id_b: str) -> dict[str, Any]:
        a = self.store.request_detail(request_id_a)
        b = self.store.request_detail(request_id_b)
        dynamic_configs = self.store.list_configs("dynamic_fields")
        ignored = [
            str(pattern)
            for config in dynamic_configs
            if config["enabled"]
            for pattern in config["config"].get("patterns") or []
        ]
        differences: list[dict[str, Any]] = []
        same: list[str] = []

        def compare_value(kind: str, path: str, left: Any, right: Any) -> None:
            if left == right:
                same.append(f"{kind}:{path}")
                return
            ignored_field = any(re.search(pattern, path) for pattern in ignored)
            differences.append(
                {
                    "kind": kind,
                    "path": path,
                    "locator": (f"url/query/{path[1:]}" if kind == "query" else f"{kind.split('-')[0]}/headers{path}" if kind.endswith("-header") else f"{kind.split('-')[0]}#chars/0-16000" if kind.endswith("-body-text") else f"{kind.split('-')[0]}#{path}" if kind.endswith("-body") else "response/status" if path == "status" else f"overview/{path}"),
                    "direction": "overview" if kind == "request" or kind == "query" else kind.split("-")[0],
                    "a": self.redactor.value(left, path.rsplit("/", 1)[-1]),
                    "b": self.redactor.value(right, path.rsplit("/", 1)[-1]),
                    "ignored": ignored_field,
                }
            )

        for key in ("method", "scheme", "host", "port", "path", "status", "durationMs", "error", "tlsError", "ruleError", "matchedRule"):
            left, right = a.get(key), b.get(key)
            if key == "path":
                left, right = self.redactor.url(left or ""), self.redactor.url(right or "")
            compare_value("request", key, left, right)
        queries = []
        for detail in (a, b):
            values = defaultdict(list)
            for name, value in parse_qsl(urlsplit(detail["url"]).query, keep_blank_values=True):
                values[name].append(self.redactor.value(value, name))
            queries.append(values)
        for name in sorted(set(queries[0]) | set(queries[1])):
            compare_value("query", "/" + name, queries[0].get(name), queries[1].get(name))
        for direction in ("request", "response"):
            left_headers, right_headers = defaultdict(list), defaultdict(list)
            for name, value in a[f"{direction}Headers"]:
                left_headers[name.lower()].append(value)
            for name, value in b[f"{direction}Headers"]:
                right_headers[name.lower()].append(value)
            for name in sorted(set(left_headers) | set(right_headers)):
                compare_value(f"{direction}-header", f"/{name}", left_headers.get(name), right_headers.get(name))
            try:
                left_json = json.loads(a[f"{direction}BodyText"] or "null")
                right_json = json.loads(b[f"{direction}BodyText"] or "null")
                left_fields = _walk_json(self.redactor.value(left_json))
                right_fields = _walk_json(self.redactor.value(right_json))
                for pointer in sorted(set(left_fields) | set(right_fields)):
                    compare_value(f"{direction}-body", pointer, left_fields.get(pointer), right_fields.get(pointer))
            except json.JSONDecodeError:
                compare_value(f"{direction}-body-text", "/", a[f"{direction}BodyText"], b[f"{direction}BodyText"])
        valid, _ = self.store.request_versions_valid([{"id": a["id"], "version": a["version"]}, {"id": b["id"], "version": b["version"]}])
        if not valid:
            raise ValueError("比较期间来源发生变化，请重新比较")
        return {
            "a": self._comparison_summary(a),
            "b": self._comparison_summary(b),
            "differences": differences,
            "ignored": [item for item in differences if item["ignored"]],
            "sameCount": len(same),
            "limits": {
                "requestStates": [a["requestState"], b["requestState"]],
                "bodyStates": {"a": a["bodyStates"], "b": b["bodyStates"]},
                "dynamicPatterns": ignored,
            },
        }

    def _comparison_summary(self, detail: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": detail["id"],
            "version": detail["version"],
            "method": detail["method"],
            "url": self.redactor.url(detail["url"]),
            "status": detail["status"],
            "durationMs": detail["durationMs"],
            "environment": detail["environment"],
            "appVersion": detail["appVersion"],
            "startedAt": detail["startedAt"],
            "bodyStates": detail["bodyStates"],
        }

    def compare_scenarios(self, scenario_id_a: str, scenario_id_b: str) -> dict[str, Any]:
        from .qa import QAService
        a = self.store.get_scenario(scenario_id_a)["requests"]
        b = self.store.get_scenario(scenario_id_b)["requests"]
        pairing = [config for config in self.store.list_configs("qa_pairing") if config["enabled"]]
        config = pairing[0]["config"] if pairing else {}
        return QAService(self).pair([row["id"] for row in a], [row["id"] for row in b], config.get("selector"), config.get("steps"))

    def trace_context(self, request_id: str) -> dict[str, Any]:
        detail = self.store.request_detail(request_id)
        context = parse_trace_context(detail["requestHeaders"])
        return {**context, "observed": bool(detail["traceId"]), "storedTraceId": detail["traceId"]}

    def trace_groups(self, batch_id: str, filters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        rows = self.query_all(batch_id, {**(filters or {}), "traceId": ""})
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        invalid = 0
        for row in rows:
            if row.get("traceValid") and row.get("traceId"):
                groups[row["traceId"]].append(row)
            else:
                invalid += 1
        return [
            {
                "traceId": trace_id,
                "requests": items,
                "count": len(items),
                "boundary": "同一有效 W3C Trace ID 的代理可见请求；不代表服务端全部 Span。",
            }
            for trace_id, items in sorted(groups.items(), key=lambda item: item[1][0]["startedAt"])
        ] + ([{"traceId": None, "invalidCount": invalid}] if invalid else [])

    def relations(self, batch_id: str, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        rows = self.query_all(batch_id, filters or {}, max_rows=10_000)
        by_id = {row["id"]: row for row in rows}
        edges: list[dict[str, Any]] = []
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            if row.get("traceValid") and row.get("traceId"):
                groups[row["traceId"]].append(row)
        edge_limit = 10_000
        for trace_id, items in groups.items():
            ordered = sorted(items, key=lambda item: (item["startedAt"], item["id"]))
            for source, target in zip(ordered, ordered[1:]):
                if len(edges) >= edge_limit:
                    break
                edges.append({"sourceId": source["id"], "targetId": target["id"], "type": "same-trace", "confidence": "explicit", "basis": {"traceId": trace_id}, "boundary": "同 Trace 的相邻观察，仅作分组，不表示调用因果"})
        association_rules = self.store.list_configs("association")
        for config in association_rules:
            if not config["enabled"]:
                continue
            rule = config["config"]
            field_name = str(rule.get("field") or "")
            if not field_name:
                continue
            from .qa import QAService
            qa = QAService(self)
            values: dict[str, list[dict[str, Any]]] = defaultdict(list)
            window = max(1, min(int(rule.get("timeWindowMs", 60000)), 86400000))
            for row in rows[:10_000]:
                check_cancelled()
                if rule.get("hostPattern") and not re.search(str(rule["hostPattern"]), row["host"]):
                    continue
                if rule.get("pathPattern") and not re.search(str(rule["pathPattern"]), row["path"].split("?")[0]):
                    continue
                try:
                    if rule.get("kind") in ("header", "query", "pointer"):
                        value = qa.field_value(row["id"], {"kind": rule["kind"], "direction": rule.get("direction", "response"), "path": rule.get("path", field_name)})
                    else:
                        detail = self.store.request_detail(row["id"])
                        value = self._find_key(json.loads(detail["responseBodyText"] or detail["requestBodyText"] or "null"), field_name)
                except (ValueError, KeyError, TypeError, IndexError):
                    continue
                if value not in (None, "", []):
                    device = row.get("sourceIp") if rule.get("sameDevice", True) else "*"
                    values[json.dumps([device, value], sort_keys=True)].append(row)
            for value, items in values.items():
                ordered = sorted(items, key=lambda item: (item["startedAt"], item["id"]))
                for source, target in zip(ordered, ordered[1:]):
                    if len(edges) >= edge_limit:
                        break
                    if target["startedAt"] - source["startedAt"] <= window:
                        edges.append({"sourceId": source["id"], "targetId": target["id"], "type": "shared-business-key", "confidence": "explicit", "basis": {"ruleId": config["id"], "field": field_name, "kind": rule.get("kind", "recursive-field"), "value": self.redactor.stable(value), "timeWindowMs": window, "sameDevice": rule.get("sameDevice", True)}, "boundary": "业务字段相同且符合约束，不证明调用方向"})
        from bisect import bisect_left
        redirects = defaultdict(list)
        for row in rows:
            redirects[(row.get("sourceIp"), row["url"])].append(row)
        for candidates in redirects.values():
            candidates.sort(key=lambda item: (item["startedAt"], item["id"]))
        redirect_times = {key: [item["startedAt"] for item in items] for key, items in redirects.items()}
        for row in rows:
            check_cancelled()
            if len(edges) >= edge_limit:
                break
            if (row.get("status") or 0) not in (301, 302, 303, 307, 308):
                continue
            location = header_value(self.store.request_detail(row["id"], preview_chars=0)["responseHeaders"], "location")
            key = (row.get("sourceIp"), urllib.parse.urljoin(row["url"], location))
            candidates = redirects.get(key, [])
            index = bisect_left(redirect_times.get(key, []), row["startedAt"])
            if index < len(candidates) and candidates[index]["id"] == row["id"]:
                index += 1
            if location and index < len(candidates):
                target = candidates[index]
                if target["startedAt"] - row["startedAt"] <= 60000:
                    edges.append({"sourceId": row["id"], "targetId": target["id"], "type": "redirect-candidate", "confidence": "candidate", "basis": {"location": self.redactor.url(location)}, "boundary": "同设备 URL 与时间接近，未证明客户端实际遵循跳转"})
        retry_buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            body_hash = self._request_body_hash(row["id"])
            retry_buckets[f"{row.get('sourceIp')} {row['method']} {row['host']}{row['path']} {body_hash}"].append(row)
        for items in retry_buckets.values():
            ordered = sorted(items, key=lambda item: item["startedAt"])
            for source, target in zip(ordered, ordered[1:]):
                delta = target["startedAt"] - source["startedAt"]
                if delta <= 15_000:
                    edges.append(
                        {
                            "sourceId": source["id"],
                            "targetId": target["id"],
                            "type": "retry-candidate",
                            "confidence": "candidate",
                            "basis": {"deltaMs": delta},
                            "boundary": "相同方法与请求体摘要且时间接近；可能是重试、轮询或重复提交。",
                        }
                    )
        for edge in self.store.list_relations(batch_id):
            if edge["sourceId"] in by_id and edge["targetId"] in by_id:
                edges.append(
                    {
                        "sourceId": edge["sourceId"],
                        "targetId": edge["targetId"],
                        "type": edge["type"],
                        "confidence": "manual",
                        "basis": self.redactor.value(edge["basis"]),
                        "boundary": "用户人工归组，不代表调用因果。",
                    }
                )
        return {
            "edges": edges[:edge_limit],
            "traceGroups": [
                {"traceId": trace_id, "requestIds": [item["id"] for item in items]}
                for trace_id, items in groups.items()
            ],
            "approximateGroups": self._approximate_groups(rows),
            "coverage": {
                "observedRequests": len(rows),
                "matchedRequests": self.query(batch_id, {**(filters or {}), "limit": 1})["matchCount"],
                "rowLimit": 10000,
                "edgeLimit": edge_limit,
                "edgesLimited": len(edges) >= edge_limit,
                "pairing": "adjacent-in-group",
                "traceRequests": sum(len(items) for items in groups.values()),
                "unknownRelations": "代理只观察经过本机的流量；服务内部调用需要导入 Trace。",
            },
        }

    @staticmethod
    def _find_key(value: Any, key: str) -> Any:
        if isinstance(value, dict):
            if key in value:
                return value[key]
            for item in value.values():
                found = DomainService._find_key(item, key)
                if found is not None:
                    return found
        elif isinstance(value, list):
            for item in value:
                found = DomainService._find_key(item, key)
                if found is not None:
                    return found
        return None

    def _request_body_hash(self, request_id: str) -> str:
        body = self.store.body_bytes(request_id, "request") or b""
        return hashlib.sha256(body).hexdigest()[:12]

    @staticmethod
    def _approximate_groups(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            key = f"{row.get('sourceIp') or 'unknown'} {row['host']}"
            buckets[key].append(row)
        groups = []
        for key, items in buckets.items():
            if len(items) < 2:
                continue
            groups.append(
                {
                    "key": key,
                    "requestIds": [item["id"] for item in items[:50]],
                    "type": "time-device-nearby",
                    "boundary": "只代表同设备、同 Host 的时间邻近，不构成调用关系。",
                }
            )
        return groups[:100]

    def waterfall(self, trace_id: str) -> dict[str, Any]:
        trace_id = trace_id.strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", trace_id) or trace_id == ZERO_TRACE:
            raise ValueError("Trace ID 必须是 32 位非全零十六进制字符串")
        proxies = self.query_all(
            self.store.get_current_batch()["id"],
            {"traceId": trace_id, "limit": 2000},
        )
        spans = self.store.list_spans(trace_id)
        span_by_id = {span["spanId"]: span for span in spans if span.get("spanId")}
        proxy_parent_map = {
            item["parentSpanId"]: item
            for item in proxies
            if item.get("parentSpanId")
        }
        associations: list[dict[str, Any]] = []
        for proxy in proxies:
            direct = [
                span
                for span in spans
                if proxy.get("parentSpanId")
                and span.get("parentSpanId") == proxy["parentSpanId"]
            ]
            candidates = [
                span
                for span in spans
                if span not in direct
                and (
                    str(proxy["path"].split("?")[0]) in str(span.get("attributes") or "")
                    or str(proxy["host"]) in str(span.get("attributes") or "")
                )
            ]
            for span, confidence, basis in [
                *[
                    (
                        span,
                        "explicit",
                        "服务端根 Span 的 parentSpanId 与请求 traceparent 调用方 Span ID 一致。",
                    )
                    for span in direct
                ],
                *[
                    (
                        span,
                        "candidate",
                        "同 Trace，且 Span 属性中出现请求 Host 或路径；未证明是本次请求的根 Span。",
                    )
                    for span in candidates
                ],
            ]:
                associations.append(
                    {
                        "requestId": proxy["id"],
                        "spanId": span["spanId"],
                        "serviceName": span.get("serviceName"),
                        "confidence": confidence,
                        "basis": basis,
                    }
                )
        associated_by_span = {
            item["spanId"]: item for item in associations if item["confidence"] == "explicit"
        }
        clock_skews: dict[str, float] = {}
        for association in associations:
            if association["confidence"] != "explicit":
                continue
            proxy = next(item for item in proxies if item["id"] == association["requestId"])
            span = span_by_id.get(association["spanId"])
            if not span or span.get("startNs") is None:
                continue
            span_start_ms = span["startNs"] / 1_000_000
            request_start = proxy.get("requestFinishedAt") or proxy["startedAt"]
            request_end = proxy.get("finishedAt") or (
                proxy["startedAt"] + (proxy.get("durationMs") or 0)
            )
            if span_start_ms < request_start - 1_500:
                clock_skews[span["id"]] = span_start_ms - request_start
            elif span_start_ms > request_end + 1_500:
                clock_skews[span["id"]] = span_start_ms - request_end
        start = min(
            [item["startedAt"] * 1_000_000 for item in proxies]
            + [item["startNs"] for item in spans if item.get("startNs") is not None],
            default=0,
        )
        end = max(
            [
                (
                    item.get("finishedAt")
                    or (item["startedAt"] + (item.get("durationMs") or 0))
                )
                * 1_000_000
                for item in proxies
            ]
            + [item["endNs"] for item in spans if item.get("endNs") is not None],
            default=0,
        )
        total = max(1, end - start)
        entries = []
        for item in proxies:
            item_start = item["startedAt"] * 1_000_000
            item_duration = (item.get("durationMs") or 0) * 1_000_000
            entries.append(
                {
                    "kind": "proxy-request",
                    "id": item["id"],
                    "name": f"{item['method']} {item['path']}",
                    "serviceName": "client-proxy",
                    "startOffsetMs": max(0, (item_start - start) / 1_000_000),
                    "durationMs": item_duration / 1_000_000,
                    "percentStart": max(0, (item_start - start) / total * 100),
                    "percentWidth": max(0.2, min(100, item_duration / total * 100)),
                    "status": item.get("status"),
                    "parentId": None,
                    "depth": 0,
                    "connectionType": "root",
                    "clockSkewMs": None,
                }
            )
        linked_ids = {}
        for span in spans:
            for link in span.get("links") or []:
                trace = str(link.get("traceId") or "")
                if trace not in linked_ids:
                    linked_ids[trace] = {item["spanId"] for item in self.store.list_spans(trace)}
        for span in spans:
            span_start = span.get("startNs") or start
            span_end = span.get("endNs") or span_start
            span_parent = span.get("parentSpanId")
            parent_id = None
            connection_type = "unlinked"
            if span_parent and span_parent in span_by_id:
                parent_id = f"external-span:{span_by_id[span_parent]['id']}"
                connection_type = "span-parent"
            elif span_parent and span_parent in proxy_parent_map:
                parent_id = f"proxy-request:{proxy_parent_map[span_parent]['id']}"
                connection_type = "trace-parent"
            elif span.get("links"):
                connection_type = "async-link"
            elif span["id"] in associated_by_span:
                parent_id = f"proxy-request:{associated_by_span[span['id']]['requestId']}"
                connection_type = "trace-parent"
            depth = 1 if connection_type == "trace-parent" else 0
            if connection_type == "span-parent":
                cursor = span
                seen = set()
                while cursor.get("parentSpanId") in span_by_id and cursor["spanId"] not in seen:
                    seen.add(cursor["spanId"])
                    cursor = span_by_id[cursor["parentSpanId"]]
                    depth += 1
            entries.append(
                {
                    "kind": "external-span",
                    "id": span["id"],
                    "name": span["name"],
                    "serviceName": span["serviceName"],
                    "spanId": span["spanId"],
                    "parentSpanId": span["parentSpanId"],
                    "startOffsetMs": max(0, (span_start - start) / 1_000_000),
                    "durationMs": (span_end - span_start) / 1_000_000,
                    "percentStart": max(0, (span_start - start) / total * 100),
                    "percentWidth": max(0.2, min(100, (span_end - span_start) / total * 100)),
                    "links": [{**link, "targetPresent": str(link.get("spanId") or "") in linked_ids.get(str(link.get("traceId") or ""), set()) } for link in span.get("links") or []],
                    "spanKind": span.get("spanKind"),
                    "sampled": span["sampled"],
                    "attributes": span.get("attributes") or {},
                    "parentId": parent_id,
                    "depth": depth,
                    "connectionType": connection_type,
                    "clockSkewMs": round(clock_skews[span["id"]], 1) if span["id"] in clock_skews else None,
                }
            )
        entries.sort(key=lambda item: item["startOffsetMs"])
        unsampled = sum(1 for item in spans if not item["sampled"])
        return {
            "traceId": trace_id,
            "startNs": start,
            "endNs": end,
            "entries": entries,
            "associations": associations,
            "coverage": {
                "proxyRequests": len(proxies),
                "importedSpans": len(spans),
                "unsampledSpans": unsampled,
                "sampledSpans": len(spans) - unsampled,
                "explicitAssociations": sum(1 for item in associations if item["confidence"] == "explicit"),
                "candidateAssociations": sum(1 for item in associations if item["confidence"] == "candidate"),
                "asyncLinks": sum(1 for span in spans if span.get("links")),
                "clockSkewCandidates": len(clock_skews),
                "missingParentSpans": sum(
                    1
                    for span in spans
                    if span.get("parentSpanId")
                    and span["parentSpanId"] not in span_by_id
                    and span["parentSpanId"] not in proxy_parent_map
                ),
                "gapStatement": "只展示代理观察到和已导入的 Span；sampled flags 不能代表链路完整率。parent 与 Links 独立保留，未知调用不会补绘。",
            },
        }

    def duplicate_patterns(self, batch_id: str, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        rows = self.query_all(batch_id, filters or {})
        buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in rows:
            buckets[f"{item['method']} {item['host']}{item['path']}"].append(item)
        patterns = []
        for key, items in buckets.items():
            ordered = sorted(items, key=lambda item: item["startedAt"])
            intervals = [b["startedAt"] - a["startedAt"] for a, b in zip(ordered, ordered[1:])]
            if len(items) >= 3:
                avg_interval = sum(intervals) / len(intervals) if intervals else 0
                pattern_type = (
                    "polling"
                    if len(intervals) >= 2 and max(intervals) - min(intervals) < max(500, avg_interval * 0.2)
                    else "repeat"
                )
                patterns.append(
                    {
                        "key": self.redactor.text(key),
                        "count": len(items),
                        "averageIntervalMs": round(avg_interval),
                        "pattern": pattern_type,
                        "requestIds": [item["id"] for item in items[:30]],
                        "boundary": "基于方法与 URL 的时间统计；Query 和动态字段未单独聚类。",
                    }
                )
        patterns.sort(key=lambda item: -item["count"])
        return {"patterns": patterns, "coverage": {"samples": len(rows)}}

    # Imports
    def import_har(self, data: dict[str, Any], batch_label: str | None = None) -> dict[str, Any]:
        entries = data.get("log", {}).get("entries")
        if not isinstance(entries, list):
            raise ValueError("HAR 缺少 log.entries")
        batch = self.store.create_batch(batch_label or f"HAR 导入 {time.strftime('%m-%d %H:%M')}")
        imported = 0
        failures = []
        for entry_index, entry in enumerate(entries[:20_000]):
            try:
                request = entry.get("request") or {}
                response = entry.get("response") or {}
                request_headers = normalize_headers(request.get("headers") or [])
                response_headers = normalize_headers(response.get("headers") or [])
                trace = parse_trace_context(request_headers)
                url = str(request.get("url") or "")
                if not url:
                    raise ValueError("缺少请求 URL")
                parsed = urlsplit(url)
                started = self._parse_timestamp(entry.get("startedDateTime")) or now_ms()
                duration = int(float(entry.get("time") or 0))
                request_body = self._har_body(request.get("postData") or {})
                response_content = response.get("content") or {}
                response_body = self._har_body(response_content)
                self.store.save_request(
                    {
                        "id": f"req_{uuid.uuid4().hex[:12]}",
                        "batch_id": batch["id"],
                        "sequence": imported + 1,
                        "method": str(request.get("method") or "GET"),
                        "scheme": parsed.scheme or "https",
                        "host": (parsed.hostname or "").lower(),
                        "port": parsed.port or (443 if parsed.scheme == "https" else 80),
                        "path": (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else ""),
                        "url": url,
                        "status": response.get("status"),
                        "content_type": header_value(response_headers, "content-type"),
                        "started_at": started,
                        "finished_at": started + duration,
                        "duration_ms": duration,
                        "size": int((response_content or {}).get("size") or len(response_body or b"")),
                        "source_ip": "har-import",
                        "request_state": "completed",
                        "http_version": response.get("httpVersion") or request.get("httpVersion"),
                        "trace_id": trace.get("traceId"),
                        "parent_span_id": trace.get("parentSpanId"),
                        "trace_state": trace.get("traceState"),
                        "trace_valid": int(bool(trace.get("valid"))),
                        "request_headers": request_headers,
                        "response_headers": response_headers,
                        "request_body": request_body,
                        "response_body": response_body,
                        "request_body_state": entry.get("_aiProxy", {}).get("bodyStates", {}).get("request") or ("available" if request_body else ("empty" if request_body is not None else "missing")),
                        "response_body_state": entry.get("_aiProxy", {}).get("bodyStates", {}).get("response") or ("available" if response_body else ("empty" if response_body is not None else "missing")),
                    }
                )
                imported += 1
            except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as error:
                failures.append({"index": entry_index, "reason": self.redactor.text(str(error))})
        summary = {"batchId": batch["id"], "imported": imported, "skipped": len(entries) - imported, "partial": len(entries) > imported, "format": "HAR 1.2", "limit": 20_000, "failedCount": len(failures), "failures": failures[:100], "omittedEntries": max(0, len(entries)-20_000)}
        self.store.save_import("har", data.get("log", {}).get("creator", {}).get("name"), summary)
        self.emit("capture:batch-created", batch)
        return {**summary, "batch": batch}

    @staticmethod
    def _har_body(body: dict[str, Any]) -> bytes | None:
        if not body:
            return None
        if body.get("encoding") == "base64" and body.get("text"):
            try:
                return base64.b64decode(body["text"], validate=True)
            except ValueError as error:
                raise ValueError("HAR 正文 base64 无效") from error
        text = body.get("text")
        if text is None and body.get("params"):
            return urllib.parse.urlencode(
                [(item.get("name", ""), item.get("value", "")) for item in body["params"]]
            ).encode()
        return str(text).encode() if text is not None else None

    @staticmethod
    def _parse_timestamp(value: str | None) -> int | None:
        if not value:
            return None
        try:
            from datetime import datetime

            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return int(parsed.timestamp() * 1000)
        except ValueError:
            return None

    def export_har(self, batch_id: str, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        matched = self.query(batch_id, {**(filters or {}), "limit": 1})["matchCount"]
        rows = self.query_all(batch_id, filters or {}, max_rows=20_000)
        entries = []
        used_bytes = 0
        for row in rows:
            detail = self.store.request_detail(row["id"])
            request_body = self.store.body_bytes(row["id"], "request")
            response_body = self.store.body_bytes(row["id"], "response")
            entries.append(
                {
                    "startedDateTime": self._iso_time(row["startedAt"]),
                    "time": row.get("durationMs") or 0,
                    "request": {
                        "method": row["method"],
                        "url": row["url"],
                        "httpVersion": row.get("httpVersion") or "HTTP/1.1",
                        "headers": [{"name": name, "value": value} for name, value in detail["requestHeaders"]],
                        "queryString": [
                            {"name": key, "value": value}
                            for key, value in parse_qsl(urlsplit(row["url"]).query, keep_blank_values=True)
                        ],
                        "headersSize": -1,
                        "bodySize": len(request_body or b""),
                        **(
                            {"postData": {"mimeType": header_value(detail["requestHeaders"], "content-type"), "text": base64.b64encode(request_body).decode(), "encoding": "base64"}}
                            if request_body is not None
                            else {}
                        ),
                    },
                    "response": {
                        "status": row.get("status") or 0,
                        "statusText": "",
                        "httpVersion": row.get("httpVersion") or "HTTP/1.1",
                        "headers": [{"name": name, "value": value} for name, value in detail["responseHeaders"]],
                        "content": {
                            "size": len(response_body or b""),
                            "mimeType": detail.get("contentType") or "",
                            **({"text": base64.b64encode(response_body).decode(), "encoding": "base64"} if response_body is not None else {}),
                        },
                        "redirectURL": header_value(detail["responseHeaders"], "location"),
                        "headersSize": -1,
                        "bodySize": len(response_body or b""),
                    },
                    "cache": {},
                    "timings": {"send": 0, "wait": row.get("durationMs") or 0, "receive": 0},
                    "_aiProxy": {
                        "requestId": row["id"],
                        "version": row["version"],
                        "bodyStates": detail["bodyStates"],
                    },
                }
            )
            used_bytes += len(json.dumps(entries[-1], ensure_ascii=False).encode())
            if used_bytes > 20 * 1024 * 1024:
                entries.pop()
                break
        return {
            "log": {
                "version": "1.2",
                "creator": {"name": "AI Proxy", "version": "0.2.0"},
                "entries": entries,
                "_aiProxy": {"exported": len(entries), "matched": matched, "omitted": max(0, matched-len(entries)), "partial": matched > len(entries), "limitRows": 20_000, "limitBytes": 20 * 1024 * 1024, "view": "local-original"},
            }
        }

    @staticmethod
    def _iso_time(timestamp: int) -> str:
        from datetime import datetime, timezone

        return datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat().replace("+00:00", "Z")

    def import_openapi(self, data: dict[str, Any], name: str) -> dict[str, Any]:
        if not (data.get("openapi") or data.get("swagger")):
            raise ValueError("不是可识别的 OpenAPI/Swagger 文档")
        paths = data.get("paths")
        if not isinstance(paths, dict):
            raise ValueError("OpenAPI 缺少 paths")
        operation_count = 0
        templates = {}
        for path, operations in paths.items():
            if not isinstance(operations, dict):
                continue
            for method, operation in operations.items():
                if method.lower() not in ("get", "post", "put", "patch", "delete", "head", "options"):
                    continue
                operation_count += 1
                templates[f"{method.upper()} {path}"] = {
                    "operationId": operation.get("operationId") if isinstance(operation, dict) else None,
                    "parameters": [*(operations.get("parameters") or []), *((operation.get("parameters") if isinstance(operation, dict) else None) or [])],
                    "requestBody": operation.get("requestBody") if isinstance(operation, dict) else None,
                    "responses": operation.get("responses") if isinstance(operation, dict) else {},
                }
        config = self.store.save_config(
            {
                "kind": "openapi",
                "name": name,
                "config": {"spec": data, "operations": templates, "version": data.get("openapi") or data.get("swagger")},
            }
        )
        summary = {"configId": config["id"], "paths": len(paths), "operations": operation_count}
        self.store.save_import("openapi", name, summary)
        return {**config, "summary": summary}

    def openapi_candidates(self, method_name: str, request_path: str, configs: list[dict[str, Any]]) -> list:
        candidates = []
        for config in configs:
            for key, operation in config["config"].get("operations", {}).items():
                method, template = key.split(" ", 1)
                if method != method_name:
                    continue
                spec = config["config"].get("spec", {})
                bases = [spec.get("basePath", "")]
                for server in spec.get("servers") or []:
                    server_url = server.get("url", "")
                    for key, value in (server.get("variables") or {}).items():
                        server_url = server_url.replace("{" + key + "}", str(value.get("default", "")))
                    bases.append(urlsplit(server_url).path.rstrip("/"))
                pattern = re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(template))
                if any(re.fullmatch(re.escape(base.rstrip("/")) + pattern, request_path.split("?")[0]) for base in bases):
                    candidates.append((config, operation, template))
        return sorted(candidates, key=lambda candidate: (candidate[2].count("{"), -len(candidate[2])))

    def validate_openapi(self, request_id: str, config_id: str | None = None) -> dict[str, Any]:
        request = self.store.request_detail(request_id)
        configs = [item for item in self.store.list_configs("openapi") if item["enabled"]]
        if config_id:
            configs = [item for item in configs if item["id"] == config_id]
        candidates = self.openapi_candidates(request["method"], request["path"], configs)
        if not candidates:
            return {"matched": False, "message": "没有匹配的 OpenAPI 操作", "requestId": request_id}
        candidates.sort(key=lambda candidate: (candidate[2].count("{"), -len(candidate[2])))
        config, operation, template = candidates[0]
        issues = []
        query_pairs = parse_qsl(urlsplit(request["url"]).query, keep_blank_values=True)
        query_keys = {key for key, _ in query_pairs}
        header_keys = {name.lower() for name, _ in request["requestHeaders"]}
        for parameter in operation.get("parameters") or []:
            if isinstance(parameter, dict) and parameter.get("$ref"):
                issues.append({"path": "request/parameters", "message": "参数引用未检查", "unchecked": True})
                continue
            if not isinstance(parameter, dict) or not parameter.get("required"):
                continue
            name = str(parameter.get("name") or "")
            location = str(parameter.get("in") or "")
            if location not in ("query", "header", "path"):
                issues.append({"path": f"request/{location}/{name}", "message": "此参数来源未检查", "unchecked": True})
                continue
            present = (
                location == "query" and name in query_keys
                or location == "header" and name.lower() in header_keys
                or location == "path" and f"{{{name}}}" in template
            )
            if not present:
                issues.append({"path": f"request/{location}/{name}", "message": "缺少必填参数"})
        request_body_spec = operation.get("requestBody") or {}
        request_schema = None
        if isinstance(request_body_spec, dict):
            content = request_body_spec.get("content") or {}
            media = next(
                (
                    value
                    for key, value in content.items()
                    if "json" in str(key).lower() and isinstance(value, dict)
                ),
                {},
            )
            request_schema = media.get("schema")
            if request_body_spec.get("required") and request["requestBodyText"] is None:
                issues.append({"path": "request/body", "message": "缺少必填请求正文"})
        if request_schema is not None and request["requestBodyText"] is not None:
            try:
                request_value = json.loads(request["requestBodyText"])
            except json.JSONDecodeError:
                issues.append({"path": "request/body", "message": "请求正文不是有效 JSON"})
            else:
                issues.extend(
                    self._schema_issues(
                        request_value,
                        request_schema,
                        config["config"].get("spec", {}),
                        "request/body",
                    )
                )
        responses = operation.get("responses") or {}
        status_key = str(request.get("status") or "")
        response_spec = None
        for response_key in (status_key, status_key.upper(), f"{status_key[:1]}XX", f"{status_key[:1]}xx", "default"):
            if response_key in responses:
                response_spec = responses[response_key]
                break
        if responses and response_spec is None:
            issues.append({"path": "status", "message": f"响应状态 {status_key} 未在契约中声明"})
        schema_ref = (response_spec.get("schema") if isinstance(response_spec, dict) else None)
        if isinstance(response_spec, dict):
            if response_spec.get("$ref"):
                issues.append({"path": "response", "message": "响应对象引用未检查", "unchecked": True})
            content = response_spec.get("content") or {}
            media = next(
                (
                    value
                    for key, value in content.items()
                    if "json" in str(key).lower() and isinstance(value, dict)
                ),
                {},
            )
            schema_ref = media.get("schema", schema_ref)
        issues.extend(self._validate_response_schema(request["responseBodyText"], schema_ref, config["config"].get("spec", {})))
        return {
            "matched": True,
            "configId": config["id"],
            "template": template,
            "operationId": operation.get("operationId"),
            "issues": issues,
            "partial": any(item.get("unchecked") for item in issues) or any(request.get(f"{direction}Truncated") for direction in ("request", "response")),
            "result": "failed" if any(not item.get("unchecked") for item in issues) else ("partial" if any(item.get("unchecked") for item in issues) or any(request.get(f"{d}Truncated") for d in ("request", "response")) else "passed-supported-subset"),
            "support": {"version": config["config"].get("version"), "keywords": ["type", "required", "properties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "additionalProperties", "$ref-local"], "limits": {"depth": 8, "arrayItems": 100}, "boundary": "仅校验已声明支持的 JSON 子集；未检查项不会算作通过"},
            "requestId": request_id,
        }

    def _validate_response_schema(self, text: str | None, schema: Any, spec: dict[str, Any]) -> list[dict[str, Any]]:
        if schema is None:
            return []
        if text is None:
            return [{"path": "/", "message": "响应正文未保存，未检查契约", "unchecked": True}]
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return [{"path": "/", "message": "响应不是有效 JSON"}]
        return self._schema_issues(value, schema, spec, "")

    def _schema_issues(
        self,
        value: Any,
        schema: Any,
        spec: dict[str, Any],
        path: str,
        depth: int = 0,
    ) -> list[dict[str, Any]]:
        if depth > 8:
            return [{"path": path, "message": "超过校验深度，未检查", "unchecked": True}]
        if isinstance(schema, bool):
            return [] if schema else [{"path": path, "message": "契约禁止此值"}]
        resolved = self._resolve_schema(schema, spec)
        if not resolved:
            return [] if schema == {} else [{"path": path, "message": "引用无法解析或循环过深", "unchecked": True}]
        label = path or "/"
        issues: list[dict[str, Any]] = []
        for required in resolved.get("required") or []:
            if not isinstance(value, dict) or required not in value:
                issues.append({"path": f"{path}/{required}".replace("//", "/"), "message": "缺少必填字段"})
        common_types = {
            "string": str,
            "integer": int,
            "number": (int, float),
            "boolean": bool,
            "object": dict,
            "array": list,
        }
        unsupported = set(resolved) - {"type", "required", "properties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "additionalProperties", "nullable", "description", "title", "example", "examples", "default", "$ref"}
        if unsupported:
            issues.append({"path": label, "message": f"未检查关键词: {sorted(unsupported)}", "unchecked": True})
        if value is None and (resolved.get("nullable") or resolved.get("type") == "null" or isinstance(resolved.get("type"), list) and "null" in resolved["type"]):
            return issues
        expected = resolved.get("type")
        if expected == "null" and value is not None:
            return [*issues, {"path": label, "message": "类型应为 null"}]
        if isinstance(resolved.get("additionalProperties"), dict):
            issues.append({"path": label, "message": "additionalProperties 的 schema 约束未检查", "unchecked": True})
        if isinstance(expected, list):
            issues.append({"path": label, "message": "联合类型未检查", "unchecked": True})
            expected = None
        valid_type = expected not in common_types or (
            isinstance(value, common_types[expected])
            and not (expected in ("integer", "number") and isinstance(value, bool))
        )
        if not valid_type:
            issues.append({"path": label, "message": f"类型应为 {expected}"})
            return issues
        if "enum" in resolved and value not in resolved["enum"]:
            issues.append({"path": label, "message": "值不在 enum 中"})
        if "const" in resolved and value != resolved["const"]:
            issues.append({"path": label, "message": "值与 const 不符"})
        constraints = []
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            constraints = [("minimum", value, lambda a, b: a >= b), ("maximum", value, lambda a, b: a <= b)]
        elif isinstance(value, str):
            constraints = [("minLength", len(value), lambda a, b: a >= b), ("maxLength", len(value), lambda a, b: a <= b)]
            if "pattern" in resolved:
                try:
                    if not re.search(str(resolved["pattern"]), value):
                        issues.append({"path": label, "message": "不满足 pattern"})
                except re.error:
                    issues.append({"path": label, "message": "非法 pattern", "unchecked": True})
        elif isinstance(value, list):
            constraints = [("minItems", len(value), lambda a, b: a >= b), ("maxItems", len(value), lambda a, b: a <= b)]
            if len(value) > 100:
                issues.append({"path": label, "message": f"数组仅检查前100项，未检查 {len(value)-100} 项", "unchecked": True})
        for keyword, actual, compare in constraints:
            if keyword in resolved and not compare(actual, resolved[keyword]):
                issues.append({"path": label, "message": f"不满足 {keyword}"})
        if isinstance(value, dict) and resolved.get("additionalProperties") is False:
            for extra in set(value) - set(resolved.get("properties") or {}):
                issues.append({"path": f"{path}/{extra}", "message": "不允许额外字段"})
        if isinstance(value, dict):
            for name, child_schema in (resolved.get("properties") or {}).items():
                if name in value:
                    issues.extend(
                        self._schema_issues(
                            value[name],
                            child_schema,
                            spec,
                            f"{path}/{name}",
                            depth + 1,
                        )
                    )
        if isinstance(value, list) and "items" in resolved:
            for index, item in enumerate(value[:100]):
                issues.extend(
                    self._schema_issues(
                        item,
                        resolved["items"],
                        spec,
                        f"{path}/{index}",
                        depth + 1,
                    )
                )
        return issues

    @staticmethod
    def _resolve_schema(schema: Any, spec: dict[str, Any], depth: int = 0) -> dict[str, Any]:
        if depth > 10 or not isinstance(schema, dict):
            return {}
        ref = schema.get("$ref")
        if ref and not ref.startswith("#/"):
            return {}
        if ref and ref.startswith("#/"):
            current: Any = spec
            for token in ref[2:].split("/"):
                current = current.get(token.replace("~1", "/").replace("~0", "~"), {})
            return DomainService._resolve_schema(current, spec, depth + 1)
        return schema

    def import_otlp(self, data: dict[str, Any], source: str = "OTLP JSON") -> dict[str, Any]:
        spans = []
        resource_spans = data.get("resourceSpans") or data.get("resource_spans") or []
        if not isinstance(resource_spans, list):
            raise ValueError("OTLP resourceSpans 必须是数组")
        for resource in resource_spans:
            if len(spans) >= 20_000:
                break
            if not isinstance(resource, dict):
                continue
            service_name = ""
            for attr in (resource.get("resource") or {}).get("attributes") or []:
                if attr.get("key") == "service.name":
                    service_name = str((attr.get("value") or {}).get("stringValue") or "")
            for scope in resource.get("scopeSpans") or resource.get("instrumentationLibrarySpans") or []:
                if len(spans) >= 20_000:
                    break
                if not isinstance(scope, dict):
                    continue
                for span in scope.get("spans") or []:
                    if len(spans) >= 20_000:
                        break
                    if not isinstance(span, dict):
                        continue
                    trace_id = self._decode_otlp_id(span.get("traceId"))
                    span_id = self._decode_otlp_id(span.get("spanId"))
                    if not re.fullmatch(r"[0-9a-f]{32}", trace_id) or trace_id == ZERO_TRACE:
                        continue
                    if not re.fullmatch(r"[0-9a-f]{16}", span_id) or span_id == ZERO_SPAN:
                        continue
                    spans.append(
                        {
                            "traceId": trace_id,
                            "spanId": span_id,
                            "parentSpanId": self._decode_otlp_id(span.get("parentSpanId")) if span.get("parentSpanId") else None,
                            "serviceName": service_name,
                            "name": span.get("name"),
                            "startNs": self._to_int(span.get("startTimeUnixNano")),
                            "endNs": self._to_int(span.get("endTimeUnixNano")),
                            "links": [
                                {
                                    "traceId": self._decode_otlp_id(link.get("traceId")),
                                    "spanId": self._decode_otlp_id(link.get("spanId")),
                                    "attributes": link.get("attributes") or [],
                                }
                                for link in span.get("links") or []
                            ],
                            "attributes": {
                                item.get("key"): next(iter((item.get("value") or {}).values()), None)
                                for item in span.get("attributes") or []
                                if isinstance(item, dict)
                            },
                            "sampled": ((span.get("flags") or 0) & 1) == 1,
                            "raw": span,
                        }
                    )
        imports = self.store.save_import("otlp-json", source, {"spans": len(spans), "limit": 20_000})
        self.store.save_spans(imports["id"], spans)
        return {**imports, "imported": len(spans)}

    @staticmethod
    def _decode_otlp_id(value: Any) -> str:
        if not value:
            return ""
        text = str(value)
        if re.fullmatch(r"[0-9a-fA-F]{16}|[0-9a-fA-F]{32}", text):
            return text.lower()
        try:
            return base64.b64decode(text).hex()
        except (ValueError, TypeError):
            return text.lower()

    @staticmethod
    def _to_int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    # Debug preview/apply/restore
    def preview_debug_action(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        payload = dict(payload)
        if action_type == "map-local":
            payload["filePath"], payload["fileHash"] = self.validate_shared_file(payload)
        batch_id = payload.get("targetBatchId") or self.store.get_current_batch()["id"]
        payload["targetBatchId"] = batch_id
        payload["targetEnvironment"] = self.store.get_setting("active_environment")
        baseline_filters: dict[str, Any] = {"limit": 200, "sort": "desc"}
        source = str(payload.get("source") or "")
        if source:
            parsed = urlsplit(source.rstrip("*"))
            baseline_filters.update(host=parsed.hostname or "", pathPrefix=parsed.path or "/")
        if payload.get("sourceIp"):
            baseline_filters["sourceIp"] = payload["sourceIp"]
        payload["baselineVersions"] = [{"id": row["id"], "version": row["version"]} for row in self.query(batch_id, baseline_filters)["items"]]
        current_version = self.store.config_version()
        config_hash = self.store.config_hash()
        before: dict[str, Any]
        after: dict[str, Any]
        if action_type in ("map-local", "map-remote", "rewrite"):
            before = {"rules": self.store.list_rules()}
            proposed = {
                "type": "local" if action_type == "map-local" else "remote" if action_type == "map-remote" else "rewrite",
                **payload,
                "enabled": True,
            }
            after = {"rules": [*before["rules"], proposed]}
        elif action_type == "throttle":
            before = {"throttle": json.loads(self.store.get_setting("throttle", "{}") or "{}")}
            after = {
                "throttle": {
                    "enabled": bool(payload.get("enabled", True)),
                    "upKbPerSecond": int(payload.get("upKbPerSecond", 0)),
                    "downKbPerSecond": int(payload.get("downKbPerSecond", 0)),
                    "latencyMs": int(payload.get("latencyMs", 0)),
                }
            }
        else:
            raise ValueError("不支持的调试操作")
        preview = {
            "type": action_type,
            "payload": payload,
            "impact": payload.get("impact") or "作用于所有经过本代理的流量",
            "restore": "执行后可在调试操作历史中恢复；若配置已被其他操作修改则拒绝覆盖。",
            "before": before,
            "after": after,
            "configVersion": current_version,
            "configHash": config_hash,
        }
        action = self.store.save_debug_action(
            {
                "type": action_type,
                "preview": preview,
                "before": before,
                "after": after,
                "status": "preview",
                "configVersion": current_version,
                "idempotencyKey": payload.get("idempotencyKey") or new_id("idem"),
            }
        )
        return action

    def apply_debug_action(self, action_id: str) -> dict[str, Any]:
        action = self.store.get_debug_action(action_id)
        if action["status"] == "applied":
            return action
        if action["status"] != "preview":
            raise ValueError(f"当前状态不能执行: {action['status']}")
        if not self.store.claim_debug_action(action_id, "preview", "applying"):
            return self.store.get_debug_action(action_id)
        if self.store.config_version() != action["configVersion"]:
            updated = self.store.save_debug_action(
                {
                    **action,
                    "status": "conflict",
                    "result": {"error": "预览后配置已变化，请重新预览。"},
                }
            )
            return updated
        payload = action["preview"]["payload"]
        result: dict[str, Any] = {}
        try:
            if action["type"] == "throttle":
                result["throttle"] = action["after"]["throttle"]
                self.store.set_setting("throttle", json.dumps(result["throttle"]))
                self.store.bump_config_version()
            elif action["type"] == "map-local":
                self.validate_shared_file(payload)
                rule = self.store.save_rule(
                    {
                        "type": "local",
                        "source": payload["source"],
                        "filePath": payload["filePath"],
                        "responseStatus": int(payload.get("responseStatus", 200)),
                        "delayMs": int(payload.get("delayMs", 0)),
                        "disconnect": bool(payload.get("disconnect", False)),
                        "enabled": True,
                    }
                )
                result["ruleId"] = rule["id"]
            elif action["type"] == "map-remote":
                rule = self.store.save_rule(
                    {
                        "type": "remote",
                        "source": payload["source"],
                        "target": payload["target"],
                        "enabled": True,
                    }
                )
                result["ruleId"] = rule["id"]
            elif action["type"] == "rewrite":
                rule = self.store.save_rule({"type": "rewrite", **payload, "enabled": True})
                result["ruleId"] = rule["id"]
            result["configHash"] = self.store.config_hash()
            return self.store.save_debug_action(
                {
                    **action,
                    "status": "applied",
                    "result": result,
                    "appliedAt": now_ms(),
                }
            )
        except Exception as error:
            return self.store.save_debug_action({**action, "status": "failed", "result": {"error": str(error)}})

    def restore_debug_action(self, action_id: str) -> dict[str, Any]:
        action = self.store.get_debug_action(action_id)
        if action["status"] == "restored":
            return action
        if action["status"] != "applied":
            raise ValueError("只有已执行的操作可以恢复")
        if not self.store.claim_debug_action(action_id, "applied", "restoring"):
            return self.store.get_debug_action(action_id)
        current_hash = self.store.config_hash()
        expected_hash = action["result"].get("configHash")
        if current_hash != expected_hash:
            return self.store.save_debug_action(
                {
                    **action,
                    "status": "restore-conflict",
                    "result": {
                        **action["result"],
                        "error": "当前规则或弱网配置已被修改，未覆盖现有配置。",
                    },
                }
            )
        try:
            rule_id = action["result"].get("ruleId")
            if rule_id:
                self.store.delete_rule(rule_id)
            elif action["type"] == "throttle":
                self.store.set_setting("throttle", json.dumps(action["before"].get("throttle") or {}))
                self.store.bump_config_version()
            return self.store.save_debug_action(
                {**action, "status": "restored", "restoredAt": now_ms()}
            )

        except Exception as error:
            return self.store.save_debug_action(
                {
                    **action,
                    "status": "applied",
                    "result": {**action["result"], "error": str(error)},
                }
            )

    def validate_shared_file(self, payload: dict[str, Any]) -> tuple[str, str]:
        session_id = payload.get("ownerSessionId")
        if not session_id:
            raise ValueError("Map Local 需要会话共享文件授权")
        path = Path(str(payload.get("filePath") or "")).resolve(strict=True)
        session = self.store.get_session(str(session_id))
        if str(path) not in {item["path"] for item in session["files"]}:
            raise ValueError("该文件未授权给当前会话")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        granted = self.store.get_setting(f"file-grant:{session_id}:{path}")
        if digest != granted or (payload.get("fileHash") and payload["fileHash"] != digest):
            raise ValueError("共享文件已变化，请重新共享并预览")
        return str(path), digest

    def assert_action_owner(self, action_id: str, session_id: str, run_id: str) -> None:
        payload = self.store.get_debug_action(action_id)["preview"]["payload"]
        if payload.get("ownerSessionId") != session_id or payload.get("ownerRunId") != run_id:
            raise ValueError("调试动作不属于当前会话和 Run，请重新预览")
    def verify_debug_action(
        self,
        action_id: str,
        *,
        source_ip: str = "",
        limit: int = 200,
    ) -> dict[str, Any]:
        action = self.store.get_debug_action(action_id)
        if action["status"] not in ("applied", "restored", "restore-conflict"):
            raise ValueError("只有已经应用过的调试操作可以验证")
        since = int(action.get("appliedAt") or action["createdAt"])
        payload = action["preview"]["payload"]
        batch_id = payload.get("targetBatchId")
        if not batch_id:
            raise ValueError("旧动作没有固定批次，请重新预览后验证")
        filters: dict[str, Any] = {"startedAfter": since, "startedBefore": action.get("restoredAt") or now_ms(), "sort": "desc"}
        source_ip = source_ip or str(payload.get("sourceIp") or "")
        if source_ip:
            filters["sourceIp"] = source_ip
        source = str(payload.get("source") or "")
        if source:
            parsed = urlsplit(source.rstrip("*"))
            filters.update(host=parsed.hostname or "", pathPrefix=parsed.path or "/")
        rows = self.query_all(batch_id, filters)
        if source:
            from .rules import source_matches
            rows = [row for row in rows if source_matches(source, row["url"])]
        business_rules = self.store.list_configs("business_rule")
        for row in rows:
            row["businessState"] = self.business_state(row["id"], business_rules)
        failures = [
            row
            for row in rows
            if (row.get("status") or 0) >= 400
            or row.get("error")
            or row.get("ruleError")
            or row["businessState"]["state"] == "business-failure"
        ]
        rule_id = action.get("result", {}).get("ruleId")
        rule_hits = [row for row in rows if rule_id and row.get("matchedRule") == rule_id]
        status_counts: dict[str, int] = defaultdict(int)
        business_counts: dict[str, int] = defaultdict(int)
        for row in rows:
            status_counts[str(row.get("status") or "pending")] += 1
            business_counts[row["businessState"]["state"]] += 1
        safe_limit = max(1, min(int(limit), 1000))
        baseline_valid, changed = self.store.request_versions_valid(payload.get("baselineVersions") or [])
        baseline = []
        for version in payload.get("baselineVersions") or []:
            if version["id"] not in changed:
                baseline.append(self.store.request_summary(version["id"]))
        expected = payload.get("expected") or {}
        checks = []
        for row in rows:
            states = []
            if action["type"] == "map-local":
                states.append({"check": "rule-hit", "passed": row.get("matchedRule") == rule_id})
                if payload.get("disconnect"):
                    states.append({"check": "disconnect", "passed": bool(row.get("error"))})
                else:
                    states.append({"check": "status", "passed": row.get("status") == int(payload.get("responseStatus", 200))})
            if expected.get("status") is not None:
                states.append({"check": "expected-status", "passed": row.get("status") == int(expected["status"])})
            minimum = expected.get("minDurationMs", payload.get("delayMs"))
            if minimum:
                states.append({"check": "duration", "passed": (row.get("durationMs") or 0) >= int(minimum)})
            if "pointer" in expected:
                try:
                    value = _json_pointer(json.loads(self.store.request_detail(row["id"])["responseBodyText"] or "null"), expected["pointer"])
                    states.append({"check": "expected-field", "passed": value == expected.get("value")})
                except (ValueError, KeyError, IndexError, TypeError):
                    states.append({"check": "expected-field", "passed": False})
            candidates = [old for old in baseline if old["method"] == row["method"] and old["host"] == row["host"] and old["path"].split("?")[0] == row["path"].split("?")[0] and old.get("sourceIp") == row.get("sourceIp")]
            old = max(candidates, key=lambda value: value["startedAt"]) if candidates else None
            checks.append({"requestId": row["id"], "baselineId": old["id"] if old else None, "durationDeltaMs": (row.get("durationMs") or 0) - (old.get("durationMs") or 0) if old else None, "checks": states, "result": "failed" if any(not state["passed"] for state in states) else "passed" if states and old else "insufficient-evidence"})
        verdict = "failed" if any(item["result"] == "failed" for item in checks) else "passed" if checks and baseline_valid and all(item["result"] == "passed" for item in checks) else "insufficient-evidence"
        return {
            "actionId": action_id,
            "actionType": action["type"],
            "actionStatus": action["status"],
            "batchId": batch_id,
            "since": since,
            "until": filters["startedBefore"],
            "verdict": verdict,
            "checks": checks[:safe_limit],
            "baselineChangedIds": changed,
            "targetEnvironment": payload.get("targetEnvironment"),
            "sourceIp": source_ip or None,
            "newRequestCount": len(rows),
            "ruleHitCount": len(rule_hits),
            "failureCount": len(failures),
            "statusBreakdown": dict(sorted(status_counts.items())),
            "businessBreakdown": dict(sorted(business_counts.items())),
            "samples": rows[:safe_limit],
            "failureSamples": failures[:safe_limit],
            "verificationSteps": [
                "使用相同设备、环境和业务前置条件执行一次原操作",
                "确认新增请求命中预期规则或弱网设置",
                "对比关键状态、业务码、字段和耗时，并保留仍存在的缺口",
            ],
            "boundary": (
                "只统计当前批次在该操作应用后产生的代理可见请求；"
                "不证明服务端内部根因，也不自动重放写操作。"
            ),
        }

    # External reads/writes
    def replay(self, request_id: str, *, execute: bool = False, override_url: str = "", action_id: str | None = None, edits: dict[str, Any] | None = None, owner_session: str | None = None, owner_run: str | None = None) -> dict[str, Any]:
        from .replay import ReplayService
        return ReplayService(self).replay(request_id, execute=execute, override_url=override_url, action_id=action_id, edits=edits, owner_session=owner_session, owner_run=owner_run)

    def query_observability(self, endpoint: str, trace_id: str) -> dict[str, Any]:
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("http", "https"):
            raise ValueError("可观测平台地址必须是 HTTP(S)")
        url = endpoint.replace("{traceId}", urllib.parse.quote(trace_id))
        request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
        try:
            with NO_PROXY_OPENER.open(request, timeout=20) as response:
                body = response.read(2 * 1024 * 1024)
                text = body.decode("utf-8", "replace")
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    data = None
                return {
                    "ok": True,
                    "status": response.status,
                    "data": self.redactor.value(data),
                    "text": None if data is not None else self.redactor.text(text),
                    "truncated": len(body) >= 2 * 1024 * 1024,
                    "boundary": "只读查询用户明确配置的平台；结果完整性由该平台采样与保留策略决定。",
                }
        except urllib.error.HTTPError as error:
            return {"ok": False, "status": error.code, "error": self.redactor.text(error.read(64 * 1024).decode("utf-8", "replace"))}

    def call_mcp_tool(self, server_id: str, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        server = next((item for item in self.store.list_mcp_servers() if item["id"] == server_id), None)
        if server is None or not server["enabled"]:
            raise ValueError("MCP 服务不存在或未启用")
        if tool_name not in server["allowedTools"]:
            raise ValueError("工具不在 MCP 白名单中")
        parsed_endpoint = urlsplit(server["endpoint"])
        if parsed_endpoint.scheme not in ("http", "https"):
            raise ValueError("MCP Endpoint 必须是 HTTP(S)")
        encoded_arguments = json.dumps(arguments, ensure_ascii=False)
        if len(encoded_arguments.encode("utf-8")) > 256 * 1024:
            raise ValueError("MCP 工具参数超过 256 KiB 限制")
        payload = json.dumps(
            {"jsonrpc": "2.0", "id": new_id("mcp"), "method": "tools/call", "params": {"name": tool_name, "arguments": arguments}},
            ensure_ascii=False,
        ).encode()
        request = urllib.request.Request(
            server["endpoint"],
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with NO_PROXY_OPENER.open(request, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024)
        except urllib.error.HTTPError as error:
            raise ValueError(
                f"MCP HTTP {error.code}: {self.redactor.text(error.read(64 * 1024).decode('utf-8', 'replace'))}"
            ) from error
        if len(raw) >= 2 * 1024 * 1024:
            raise ValueError("MCP 响应超过 2 MiB 限制")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError("MCP 响应不是有效 JSON") from error
        if data.get("error"):
            raise ValueError(f"MCP 返回错误：{self.redactor.value(data['error'])}")
        result = data.get("result")
        if result is None:
            raise ValueError("MCP 响应缺少 result")
        return {"server": server["name"], "tool": tool_name, "result": self.redactor.value(result)}

    def create_ticket(
        self,
        report_id: str,
        endpoint: str,
        execute: bool = False,
        ticket_id: str | None = None,
    ) -> dict[str, Any]:
        report = self.store.get_report(report_id)
        report_hash = hashlib.sha256(json.dumps([report["title"], report["content"], report["scope"]], sort_keys=True).encode()).hexdigest()
        if execute and not ticket_id:
            raise ValueError("发送工单前必须预览")
        if ticket_id:
            ticket = self.store.get_ticket(ticket_id)
            if ticket["reportId"] != report_id:
                raise ValueError("工单预览与报告不匹配")
            payload = ticket["payload"]
            if payload.get("endpoint") != endpoint or payload.get("reportHash") != report_hash:
                raise ValueError("工单目的地或报告内容已变化，请重新预览")
            if ticket["status"] != "preview":
                return ticket
        else:
            payload = {
                "endpoint": endpoint,
                "reportHash": report_hash,
                "title": self.redactor.text(str(report["title"])),
                "body": self.redactor.text(str(report["content"])),
                "scope": self.redactor.value(report["scope"]),
                "source": "AI Proxy",
            }
            ticket = self.store.save_ticket(
                {
                    "reportId": report_id,
                    "provider": "webhook",
                    "status": "preview",
                    "payload": payload,
                }
            )
        if not execute:
            return ticket
        if not self.store.claim_ticket(ticket["id"]):
            return self.store.get_ticket(ticket["id"])
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("http", "https"):
            return self.store.save_ticket(
                {
                    **ticket,
                    "status": "failed",
                    "result": {"error": "工单 Webhook 必须是 HTTP(S)"},
                }
            )
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with NO_PROXY_OPENER.open(request, timeout=30) as response:
                text = response.read(512 * 1024).decode("utf-8", "replace")
                return self.store.save_ticket(
                    {
                        **ticket,
                        "status": "created",
                        "result": {"status": response.status, "body": self.redactor.text(text)},
                    }
                )
        except Exception as error:
            return self.store.save_ticket(
                {**ticket, "status": "unknown", "result": {"error": str(error), "resultUnknown": True}}
            )

    def test_checklist(self, request_ids: list[str]) -> dict[str, Any]:
        items = []
        for request_id in request_ids:
            detail = self.store.request_detail(request_id)
            business = self.business_state(request_id)
            facts = [
                f"状态码为 {detail['status'] if detail['status'] is not None else '无响应'}",
                f"耗时为 {detail['durationMs']} ms",
            ]
            if detail.get("error"):
                facts.append(f"代理观察到错误：{self.redactor.text(str(detail['error']))}")
            if detail.get("ruleError"):
                facts.append(f"规则执行错误：{self.redactor.text(str(detail['ruleError']))}")
            suggestions = [
                "使用相同账号、环境和设备复现一次，并保留新旧请求",
                "核对请求参数中的动态字段、鉴权状态和业务前置数据",
            ]
            if business["state"] in ("business-failure", "unknown"):
                suggestions.append("为该接口配置业务成功码与错误字段后再验证")
            if detail["bodyStates"]["response"] != "available":
                suggestions.append(f"响应正文状态为 {detail['bodyStates']['response']}，需要重新采集明文正文")
            items.append(
                {
                    "requestId": request_id,
                    "title": f"{detail['method']} {detail['path'].split('?')[0]}",
                    "facts": facts,
                    "steps": suggestions,
                }
            )
        return {"items": items, "note": "这些是人工验证点，不会自动生成或执行自动化测试。"}

    # Startup/metadata helpers
    def enrich_new_requests(self, environment: dict[str, Any] | None = None) -> int:
        if not environment:
            return 0
        batch = self.store.get_current_batch()
        rows = self.query_all(batch["id"], {"limit": 2000})
        missing = [row["id"] for row in rows if not row.get("environment")]
        return self.store.update_request_metadata(
            missing,
            {
                "environment": environment.get("name"),
                "app_version": environment.get("appVersion"),
                "build_number": environment.get("buildNumber"),
            },
        )
