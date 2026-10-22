from __future__ import annotations

import json
import mimetypes
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any


MAX_BODY_BYTES = 5 * 1024 * 1024


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.body_dir = data_dir / "bodies"
        self.body_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = data_dir / "ai-proxy.sqlite3"
        self._write_lock = threading.Lock()
        self._init_schema()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _init_schema(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS batches (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY,
                    batch_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    method TEXT NOT NULL,
                    scheme TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    path TEXT NOT NULL,
                    url TEXT NOT NULL,
                    status INTEGER,
                    content_type TEXT,
                    started_at INTEGER NOT NULL,
                    duration_ms INTEGER,
                    size INTEGER,
                    source_ip TEXT,
                    encrypted INTEGER NOT NULL DEFAULT 0,
                    tls_error TEXT,
                    matched_rule TEXT,
                    actual_url TEXT,
                    rule_error TEXT,
                    request_headers TEXT,
                    response_headers TEXT,
                    request_body_path TEXT,
                    response_body_path TEXT,
                    request_body_size INTEGER,
                    response_body_size INTEGER,
                    request_truncated INTEGER NOT NULL DEFAULT 0,
                    response_truncated INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    FOREIGN KEY(batch_id) REFERENCES batches(id)
                );
                CREATE INDEX IF NOT EXISTS idx_requests_batch ON requests(batch_id, sequence);
                CREATE TABLE IF NOT EXISTS rules (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    sort_order INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    target TEXT,
                    file_path TEXT,
                    phase TEXT,
                    part TEXT,
                    action TEXT,
                    header_name TEXT,
                    header_value TEXT,
                    search TEXT,
                    replace TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    meta TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
                CREATE TABLE IF NOT EXISTS providers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    protocol TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    model TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS session_files (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                );
                """
            )
            count = db.execute("SELECT COUNT(*) FROM batches").fetchone()[0]
            if count == 0:
                db.execute(
                    "INSERT INTO batches(id, label, created_at) VALUES (?, ?, ?)",
                    (new_id("batch"), "首次抓包", now_ms()),
                )

    def get_current_batch(self) -> dict[str, Any]:
        with self.connect() as db:
            batch_id = self.get_setting("current_batch_id")
            row = db.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if row is None:
                row = db.execute(
                    "SELECT * FROM batches ORDER BY created_at DESC LIMIT 1"
                ).fetchone()
                self.set_setting("current_batch_id", row["id"])
            return dict(row)

    def list_batches(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT b.*, COUNT(r.id) AS request_count
                FROM batches b LEFT JOIN requests r ON r.batch_id = b.id
                GROUP BY b.id ORDER BY b.created_at DESC
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def create_batch(self, label: str | None = None) -> dict[str, Any]:
        batch_id = new_id("batch")
        created_at = now_ms()
        with self.connect() as db:
            db.execute(
                "INSERT INTO batches(id, label, created_at) VALUES (?, ?, ?)",
                (batch_id, label or f"抓包 {time.strftime('%H:%M')}", created_at),
            )
        self.set_setting("current_batch_id", batch_id)
        return {"id": batch_id, "label": label or f"抓包 {time.strftime('%H:%M')}", "created_at": created_at, "request_count": 0}

    def select_batch(self, batch_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if row is None:
                raise ValueError("抓包批次不存在")
        self.set_setting("current_batch_id", batch_id)
        return dict(row)

    def clear_batch(self, batch_id: str) -> None:
        with self.connect() as db:
            paths = db.execute(
                "SELECT request_body_path, response_body_path FROM requests WHERE batch_id = ?",
                (batch_id,),
            ).fetchall()
            db.execute("DELETE FROM requests WHERE batch_id = ?", (batch_id,))
        for row in paths:
            for value in row:
                if value:
                    Path(value).unlink(missing_ok=True)

    def delete_batch(self, batch_id: str) -> None:
        batches = self.list_batches()
        if len(batches) <= 1:
            self.clear_batch(batch_id)
            return
        self.clear_batch(batch_id)
        with self.connect() as db:
            db.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
            row = db.execute(
                "SELECT id FROM batches ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        if self.get_setting("current_batch_id") == batch_id:
            self.set_setting("current_batch_id", row["id"])

    def _body_path(self, request_id: str, direction: str) -> Path:
        return self.body_dir / f"{request_id}-{direction}.bin"

    def _write_body(self, request_id: str, direction: str, data: bytes | None) -> tuple[str | None, int | None, bool]:
        if data is None:
            return None, None, False
        truncated = len(data) > MAX_BODY_BYTES
        payload = data[:MAX_BODY_BYTES]
        path = self._body_path(request_id, direction)
        path.write_bytes(payload)
        path.chmod(0o600)
        return str(path), len(data), truncated

    def save_request(self, data: dict[str, Any]) -> dict[str, Any]:
        request_id = data["id"]
        with self._write_lock:
            req_path, req_size, req_truncated = self._write_body(
                request_id, "request", data.pop("request_body", None)
            )
            res_path, res_size, res_truncated = self._write_body(
                request_id, "response", data.pop("response_body", None)
            )
            headers = {
                "request_headers": json.dumps(data.pop("request_headers", [])),
                "response_headers": json.dumps(data.pop("response_headers", [])),
                "request_body_path": req_path,
                "response_body_path": res_path,
                "request_body_size": req_size,
                "response_body_size": res_size,
                "request_truncated": int(req_truncated),
                "response_truncated": int(res_truncated),
            }
            row = {**data, **headers}
            columns = ", ".join(row)
            placeholders = ", ".join("?" for _ in row)
            with self.connect() as db:
                db.execute(
                    f"INSERT OR REPLACE INTO requests({columns}) VALUES ({placeholders})",
                    tuple(row.values()),
                )
            return self.request_summary(request_id)

    def _request_row_to_summary(self, row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        return {
            "id": value["id"],
            "batchId": value["batch_id"],
            "sequence": value["sequence"],
            "method": value["method"],
            "scheme": value["scheme"],
            "host": value["host"],
            "port": value["port"],
            "path": value["path"],
            "url": value["url"],
            "status": value["status"],
            "contentType": value["content_type"],
            "startedAt": value["started_at"],
            "durationMs": value["duration_ms"],
            "size": value["size"],
            "sourceIp": value["source_ip"],
            "encrypted": bool(value["encrypted"]),
            "tlsError": value["tls_error"],
            "matchedRule": value["matched_rule"],
            "actualUrl": value["actual_url"],
            "ruleError": value["rule_error"],
            "error": value["error"],
            "requestTruncated": bool(value["request_truncated"]),
            "responseTruncated": bool(value["response_truncated"]),
        }

    def request_summary(self, request_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if row is None:
                raise ValueError("请求记录不存在")
            return self._request_row_to_summary(row)

    def request_detail(self, request_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if row is None:
                raise ValueError("请求记录不存在")
            value = dict(row)
        summary = self._request_row_to_summary(row)
        request_body = self._read_body(value["request_body_path"])
        response_body = self._read_body(value["response_body_path"])
        return {
            **summary,
            "requestHeaders": json.loads(value["request_headers"] or "[]"),
            "responseHeaders": json.loads(value["response_headers"] or "[]"),
            "requestBody": request_body,
            "responseBody": response_body,
            "requestBodySize": value["request_body_size"],
            "responseBodySize": value["response_body_size"],
            "requestBodyText": self._preview_body(value["request_body_path"]),
            "responseBodyText": self._preview_body(value["response_body_path"]),
        }

    def _read_body(self, path: str | None) -> dict[str, Any] | None:
        if not path:
            return None
        body_path = Path(path)
        if not body_path.exists():
            return None
        data = body_path.read_bytes()
        mime = mimetypes.guess_type(body_path.name)[0] or "application/octet-stream"
        return {
            "size": len(data),
            "base64": None,
            "path": str(body_path),
            "mime": mime,
        }

    def _preview_body(self, path: str | None) -> str | None:
        if not path:
            return None
        body_path = Path(path)
        if not body_path.exists():
            return None
        data = body_path.read_bytes()
        if b"\x00" in data[:2048]:
            return None
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")

    def list_requests(
        self,
        batch_id: str,
        query: str = "",
        method: str = "",
        status: str = "",
        source_ip: str = "",
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        clauses = ["batch_id = ?"]
        values: list[Any] = [batch_id]
        if query:
            clauses.append("(url LIKE ? OR host LIKE ? OR path LIKE ?)")
            values.extend([f"%{query}%"] * 3)
        if method:
            clauses.append("method = ?")
            values.append(method.upper())
        if status:
            try:
                status_number = int(status)
                if status_number == 200:
                    clauses.append("status >= 200 AND status < 300")
                elif status_number == 300:
                    clauses.append("status >= 300 AND status < 400")
                elif status_number == 400:
                    clauses.append("status >= 400 AND status < 500")
                elif status_number == 500:
                    clauses.append("status >= 500")
                else:
                    clauses.append("status = ?")
                    values.append(status_number)
            except ValueError:
                pass
        if source_ip:
            clauses.append("source_ip = ?")
            values.append(source_ip)
        values.append(max(1, min(limit, 1000)))
        with self.connect() as db:
            rows = db.execute(
                f"SELECT * FROM requests WHERE {' AND '.join(clauses)} ORDER BY sequence DESC LIMIT ?",
                tuple(values),
            ).fetchall()
            return [self._request_row_to_summary(row) for row in reversed(rows)]

    def list_rules(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM rules ORDER BY sort_order, created_at").fetchall()
            return [self._rule_to_dict(row) for row in rows]

    def _rule_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        return {
            "id": value["id"],
            "type": value["type"],
            "enabled": bool(value["enabled"]),
            "sortOrder": value["sort_order"],
            "source": value["source"],
            "target": value["target"],
            "filePath": value["file_path"],
            "phase": value["phase"],
            "part": value["part"],
            "action": value["action"],
            "headerName": value["header_name"],
            "headerValue": value["header_value"],
            "search": value["search"],
            "replace": value["replace"],
            "createdAt": value["created_at"],
        }

    def save_rule(self, data: dict[str, Any]) -> dict[str, Any]:
        rule_id = data.get("id") or new_id("rule")
        allowed = {
            "type": "type",
            "source": "source",
            "target": "target",
            "filePath": "file_path",
            "phase": "phase",
            "part": "part",
            "action": "action",
            "headerName": "header_name",
            "headerValue": "header_value",
            "search": "search",
            "replace": "replace",
        }
        with self.connect() as db:
            existing = db.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
            if existing:
                updates = {column: data.get(key) for key, column in allowed.items() if key in data}
                if "enabled" in data:
                    updates["enabled"] = int(bool(data["enabled"]))
                if updates:
                    assignments = ", ".join(f"{column} = ?" for column in updates)
                    db.execute(
                        f"UPDATE rules SET {assignments} WHERE id = ?",
                        (*updates.values(), rule_id),
                    )
            else:
                sort_order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM rules").fetchone()[0]
                values = {
                    "id": rule_id,
                    "type": data["type"],
                    "enabled": int(bool(data.get("enabled", True))),
                    "sort_order": sort_order,
                    "source": data["source"],
                    "target": data.get("target"),
                    "file_path": data.get("filePath"),
                    "phase": data.get("phase"),
                    "part": data.get("part"),
                    "action": data.get("action"),
                    "header_name": data.get("headerName"),
                    "header_value": data.get("headerValue"),
                    "search": data.get("search"),
                    "replace": data.get("replace"),
                    "created_at": now_ms(),
                }
                db.execute(
                    f"INSERT INTO rules({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
                    tuple(values.values()),
                )
            row = db.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
            return self._rule_to_dict(row)

    def delete_rule(self, rule_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM rules WHERE id = ?", (rule_id,))

    def reorder_rules(self, ids: list[str]) -> None:
        with self.connect() as db:
            for index, rule_id in enumerate(ids):
                db.execute("UPDATE rules SET sort_order = ? WHERE id = ?", (index + 1, rule_id))

    def list_sessions(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM sessions ORDER BY updated_at DESC").fetchall()
            return [
                {
                    "id": row["id"],
                    "title": row["title"],
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
                for row in rows
            ]

    def get_session(self, session_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is None:
                raise ValueError("会话不存在")
            messages = db.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            ).fetchall()
            files = db.execute(
                "SELECT * FROM session_files WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            ).fetchall()
        return {
            "id": row["id"],
            "title": row["title"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "messages": [
                {
                    "id": msg["id"],
                    "role": msg["role"],
                    "content": msg["content"],
                    "meta": json.loads(msg["meta"] or "{}"),
                    "createdAt": msg["created_at"],
                }
                for msg in messages
            ],
            "files": [
                {"id": item["id"], "path": item["path"], "createdAt": item["created_at"]}
                for item in files
            ],
        }

    def create_session(self, title: str = "新会话") -> dict[str, Any]:
        session_id = new_id("session")
        timestamp = now_ms()
        with self.connect() as db:
            db.execute(
                "INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (session_id, title, timestamp, timestamp),
            )
        return self.get_session(session_id)

    def delete_session(self, session_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM session_files WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        meta: dict[str, Any] | None = None,
        message_id: str | None = None,
    ) -> dict[str, Any]:
        message_id = message_id or new_id("message")
        created_at = now_ms()
        with self.connect() as db:
            db.execute(
                "INSERT INTO messages(id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (message_id, session_id, role, content, json.dumps(meta or {}, ensure_ascii=False), created_at),
            )
            db.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                (created_at, session_id),
            )
            title_row = db.execute("SELECT title FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if role == "user" and title_row and title_row["title"] == "新会话":
                title = content.strip().replace("\n", " ")[:26] or "新会话"
                db.execute("UPDATE sessions SET title = ? WHERE id = ?", (title, session_id))
        return {
            "id": message_id,
            "role": role,
            "content": content,
            "meta": meta or {},
            "createdAt": created_at,
        }

    def update_message_meta(self, message_id: str, meta: dict[str, Any]) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE messages SET meta = ? WHERE id = ?",
                (json.dumps(meta, ensure_ascii=False), message_id),
            )

    def add_session_file(self, session_id: str, path: str) -> dict[str, Any]:
        file_id = new_id("file")
        created_at = now_ms()
        with self.connect() as db:
            db.execute(
                "INSERT INTO session_files(id, session_id, path, created_at) VALUES (?, ?, ?, ?)",
                (file_id, session_id, path, created_at),
            )
        return {"id": file_id, "path": path, "createdAt": created_at}

    def list_providers(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM providers ORDER BY created_at").fetchall()
            return [
                {
                    "id": row["id"],
                    "name": row["name"],
                    "protocol": row["protocol"],
                    "baseUrl": row["base_url"],
                    "model": row["model"],
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
                for row in rows
            ]

    def save_provider(self, data: dict[str, Any]) -> dict[str, Any]:
        provider_id = data.get("id") or new_id("provider")
        timestamp = now_ms()
        with self.connect() as db:
            existing = db.execute("SELECT id FROM providers WHERE id = ?", (provider_id,)).fetchone()
            if existing:
                db.execute(
                    "UPDATE providers SET name=?, protocol=?, base_url=?, model=?, updated_at=? WHERE id=?",
                    (data["name"], data["protocol"], data["baseUrl"], data["model"], timestamp, provider_id),
                )
            else:
                db.execute(
                    "INSERT INTO providers(id, name, protocol, base_url, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (provider_id, data["name"], data["protocol"], data["baseUrl"], data["model"], timestamp, timestamp),
                )
        return next(item for item in self.list_providers() if item["id"] == provider_id)

    def delete_provider(self, provider_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM providers WHERE id = ?", (provider_id,))

    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.connect() as db:
            db.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def storage_info(self) -> dict[str, Any]:
        total = sum(path.stat().st_size for path in self.data_dir.rglob("*") if path.is_file())
        return {"dataDir": str(self.data_dir), "size": total}
