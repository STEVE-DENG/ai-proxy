"""Local diagnostics and comparable, metadata-only performance summaries."""
from __future__ import annotations

import errno
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any

from .store import Store, now_ms


def storage_health(store: Store) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    actions = {
        errno.ENOSPC: "磁盘空间不足，请移走不需要的文件后重新检查；不会自动清理抓包数据。",
        errno.EDQUOT: "磁盘配额已满，请释放配额后重新检查。",
        errno.EACCES: "目录访问被拒绝，请在 Finder 中核对当前账户的读写权限。",
        errno.EPERM: "系统拒绝访问，请核对目录权限和系统隐私设置。",
        errno.EROFS: "目录位于只读卷，请恢复可写卷后重新检查。",
        errno.ENOENT: "数据路径不存在，请恢复原目录后重新打开项目。",
    }

    def failed(name: str, error: Exception) -> None:
        # Never include exception text: it can contain SQL, user data or paths.
        checks.append({"name": name, "status": "error", "code": getattr(error, "sqlite_errorname", type(error).__name__),
                       "message": actions.get(getattr(error, "errno", None),
                           "检查失败，请核对目录、磁盘与数据库是否可读；保留原文件，不要直接删库。")})

    disk = None
    try:
        usage = shutil.disk_usage(store.data_dir)
        disk = {"freeBytes": usage.free, "totalBytes": usage.total}
        low = usage.free < 512 * 1024 * 1024
        checks.append({"name": "磁盘余量", "status": "warning" if low else "ok",
                       "message": "可用空间低于512 MiB，请尽快释放空间。" if low else "可用空间已读取；采集期间仍可能变化。"})
    except OSError as error:
        failed("磁盘余量", error)
    for label, directory in (("项目目录读写", store.data_dir), ("正文目录读写", store.body_dir)):
        probe = None
        try:
            if directory.is_symlink():
                raise OSError(errno.EPERM, "symlink probe refused")
            # mkstemp uses O_EXCL and 0600; never overwrite an existing file.
            fd, name = tempfile.mkstemp(prefix=".ai-proxy-health-", dir=directory)
            probe = Path(name)
            with os.fdopen(fd, "w+b") as handle:
                handle.write(b"ai-proxy-storage-probe")
                handle.flush()
                os.fsync(handle.fileno())
                handle.seek(0)
                if handle.read() != b"ai-proxy-storage-probe":
                    raise OSError(errno.EIO, "probe mismatch")
            probe.unlink()
            probe = None
            checks.append({"name": label, "status": "ok", "message": "独立临时文件创建、写入、读取与删除成功。"})
        except OSError as error:
            failed(label, error)
        finally:
            if probe is not None:
                try:
                    probe.unlink(missing_ok=True)
                except OSError:
                    checks.append({"name": "临时文件清理", "status": "warning", "message": "诊断临时文件未能删除；恢复目录权限后清理 .ai-proxy-health- 前缀文件。"})
    try:
        if store.db_path.is_symlink():
            raise OSError(errno.EPERM, "symlink database refused")
        with closing(sqlite3.connect(store.db_path.absolute().as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            db.execute("PRAGMA query_only=ON")
            db.execute("SELECT name FROM sqlite_master LIMIT 1").fetchone()
            db.execute("SELECT id FROM requests LIMIT 1").fetchone()
        checks.append({"name": "数据库只读访问", "status": "ok", "message": "数据库及请求表可读取；未执行完整性扫描或修复。"})
    except (OSError, sqlite3.Error) as error:
        failed("数据库只读访问", error)
    return {"checkedAt": now_ms(), "dataDir": str(store.data_dir), "disk": disk, "checks": checks,
            "status": "error" if any(c["status"] == "error" for c in checks) else "warning" if any(c["status"] == "warning" for c in checks) else "ok"}


def performance_context(store: Store, provider: dict, scope: dict, mode: str) -> dict:
    def digest(value: Any) -> str:
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"version": 1, "protocol": provider.get("protocol"), "model": provider.get("model"), "mode": mode,
            "endpointKey": digest([store.get_setting("redaction_salt"), provider.get("protocol"), str(provider.get("baseUrl", "")).rstrip("/")]),
            "scopeKey": digest([scope.get("batchId"), scope.get("configHash"),
                                sorted(scope.get("requestVersions") or [], key=lambda item: item["id"]),
                                store.get_setting("redaction_salt")]),
            "sampleCount": scope.get("requestCount"), "cachePolicy": provider.get("cachePolicy", "auto")}


def compare_performance(store: Store, run_ids: list[str]) -> dict:
    if not isinstance(run_ids, list) or not 2 <= len(run_ids) <= 10 or any(not isinstance(i, str) for i in run_ids) or len(set(run_ids)) != len(run_ids):
        raise ValueError("请选择2–10条不同的执行记录")
    items = []
    for run_id in run_ids:
        with store.connect() as db:
            run = db.execute("SELECT id, model, status, created_at, started_at, finished_at FROM analysis_runs WHERE id = ?", (run_id,)).fetchone()
            if run is None:
                raise ValueError("所选执行记录不存在或已清理")
            rows = db.execute("SELECT event_type, payload_json FROM run_events WHERE run_id = ? AND event_type IN ('performance_context', 'model_usage', 'tool_cache_usage') ORDER BY seq LIMIT 202", (run_id,)).fetchall()
        events = [(row["event_type"], json.loads(row["payload_json"])) for row in rows]
        context = next((p for kind, p in events if kind == "performance_context"), None)
        metric_keys = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "durationMs", "firstOutputMs")
        steps = [{key: p.get(key) for key in metric_keys} for kind, p in events if kind == "model_usage"]
        local = next((p for kind, p in events if kind == "tool_cache_usage"), None)
        def total(key: str) -> int | None:
            values = [p.get(key) for p in steps]
            return sum(values) if values and all(isinstance(v, (int, float)) and v >= 0 for v in values) else None
        items.append({"runId": run_id, "model": run["model"], "status": run["status"], "createdAt": run["created_at"],
                      "durationMs": run["finished_at"] - run["started_at"] if run["finished_at"] and run["started_at"] else None,
                      "context": context, "modelRequests": len(steps), "inputTokens": total("inputTokens"),
                      "outputTokens": total("outputTokens"), "cacheReadTokens": total("cacheReadTokens"), "cacheWriteTokens": total("cacheWriteTokens"),
                      "firstOutputMs": steps[0].get("firstOutputMs") if steps else None,
                      "modelDurationMs": total("durationMs"), "localToolCache": local, "steps": steps,
                      "truncated": len(rows) >= 202})
    keys = ("version", "protocol", "model", "mode", "endpointKey", "scopeKey")
    comparable = all(item["context"] and item["status"] == "completed" and not item["truncated"] for item in items)
    comparable = bool(comparable and all(all(item["context"].get(k) == items[0]["context"].get(k) for k in keys) for item in items))
    return {"items": items, "comparable": comparable,
            "notice": "同模型、端点、样本版本和规则范围的已完成记录；提示、历史长度、工具路径仍可能不同，请展开单次用量核对。" if comparable else "条件不一致、任务未完成或旧记录缺少对比元数据；仅展示各自用量，不据此判断优化效果。",
            "cost": None, "costNotice": "没有可靠价格和计费口径，不估算费用；缓存读写Token不额外加到输入总量。"}
