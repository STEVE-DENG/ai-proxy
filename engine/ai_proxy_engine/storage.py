from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Iterator

from .jobs import CANCEL_EVENT


MAX_BODY_BYTES = 5 * 1024 * 1024
SCHEMA_VERSION = 6


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load_json(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.body_dir = data_dir / "bodies"
        self.body_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = data_dir / "ai-proxy.sqlite3"
        self._write_lock = threading.Lock()
        self.capture_generation = 0
        self._initialize_with_recovery()
        self._ensure_redaction_salt()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=15)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=15000")
            event = CANCEL_EVENT.get()
            if event is not None:
                connection.set_progress_handler(lambda: 1 if event.is_set() else 0, 1000)
            with connection:
                yield connection
        finally:
            # sqlite3.Connection.__exit__ commits/rolls back, but does not close.
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
            except Exception:
                db.rollback()
                raise
            else:
                db.commit()

    def _initialize_with_recovery(self) -> None:
        backup_path = None
        if self.db_path.exists():
            with self.connect() as source:
                version = source.execute("PRAGMA user_version").fetchone()[0]
                if source.execute("SELECT 1 FROM sqlite_master WHERE name = 'schema_meta'").fetchone():
                    row = source.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()
                    version = max(version, int(row[0]) if row else 0)
                if version > SCHEMA_VERSION:
                    raise ValueError(f"数据库版本 {version} 高于支持版本 {SCHEMA_VERSION}，拒绝降级")
                if version < SCHEMA_VERSION:
                    backup_path = self.data_dir / f"migration-{version}-{now_ms()}.sqlite3"
                    with closing(sqlite3.connect(backup_path)) as backup:
                        source.backup(backup)
        try:
            self._init_schema()
        except Exception as error:
            if backup_path:
                with closing(sqlite3.connect(backup_path)) as backup, self.connect() as target:
                    backup.backup(target)
                raise RuntimeError(f"迁移失败，已恢复；备份: {backup_path}: {error}") from error
            raise

    def _init_schema(self) -> None:
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS batches (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    metadata TEXT
                );
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY,
                    batch_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    start_sequence INTEGER,
                    completed_sequence INTEGER,
                    method TEXT NOT NULL,
                    scheme TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    path TEXT NOT NULL,
                    url TEXT NOT NULL,
                    status INTEGER,
                    content_type TEXT,
                    started_at INTEGER NOT NULL,
                    request_started_at INTEGER,
                    request_finished_at INTEGER,
                    response_headers_at INTEGER,
                    finished_at INTEGER,
                    duration_ms INTEGER,
                    size INTEGER,
                    source_ip TEXT,
                    client_peer TEXT,
                    connection_id TEXT,
                    http_version TEXT,
                    encrypted INTEGER NOT NULL DEFAULT 0,
                    tls_error TEXT,
                    matched_rule TEXT,
                    actual_url TEXT,
                    rule_error TEXT,
                    rule_evidence TEXT,
                    request_headers TEXT,
                    response_headers TEXT,
                    request_headers_original TEXT,
                    response_headers_original TEXT,
                    request_body_path TEXT,
                    response_body_path TEXT,
                    request_body_size INTEGER,
                    response_body_size INTEGER,
                    request_truncated INTEGER NOT NULL DEFAULT 0,
                    response_truncated INTEGER NOT NULL DEFAULT 0,
                    request_body_state TEXT NOT NULL DEFAULT 'available',
                    response_body_state TEXT NOT NULL DEFAULT 'available',
                    request_state TEXT NOT NULL DEFAULT 'completed',
                    trace_id TEXT,
                    parent_span_id TEXT,
                    trace_state TEXT,
                    trace_valid INTEGER NOT NULL DEFAULT 0,
                    environment TEXT,
                    app_version TEXT,
                    build_number TEXT,
                    capture_loss INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    FOREIGN KEY(batch_id) REFERENCES batches(id)
                );





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
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER
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
                    run_id TEXT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    meta TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                );


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
                CREATE TABLE IF NOT EXISTS analysis_runs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    parent_run_id TEXT,
                    batch_id TEXT,
                    scope_json TEXT NOT NULL,
                    mode TEXT NOT NULL DEFAULT 'analysis',
                    provider_id TEXT,
                    model TEXT,
                    status TEXT NOT NULL,
                    status_detail TEXT,
                    budget_json TEXT,
                    usage_json TEXT,
                    summary TEXT,
                    created_at INTEGER NOT NULL,
                    started_at INTEGER,
                    finished_at INTEGER,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                );


                CREATE TABLE IF NOT EXISTS analysis_scope_requests (
                    run_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    request_version INTEGER NOT NULL,
                    PRIMARY KEY(run_id, request_id)
                );

                CREATE TABLE IF NOT EXISTS run_events (
                    run_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    step_id TEXT,
                    tool_call_id TEXT,
                    status TEXT,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(run_id, seq)
                );

                CREATE TABLE IF NOT EXISTS run_messages (
                    run_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    sdk_version TEXT,
                    messages_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS evidence (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    request_version INTEGER NOT NULL,
                    direction TEXT NOT NULL,
                    locator TEXT,
                    summary TEXT NOT NULL,
                    redacted_value_json TEXT,
                    state TEXT NOT NULL DEFAULT 'valid',
                    created_at INTEGER NOT NULL
                );


                CREATE TABLE IF NOT EXISTS reports (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    run_id TEXT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    scope_json TEXT,
                    status TEXT NOT NULL DEFAULT 'draft',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS scenarios (
                    id TEXT PRIMARY KEY,
                    batch_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    device TEXT,
                    status TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS scenario_requests (
                    scenario_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    membership TEXT NOT NULL DEFAULT 'include',
                    note TEXT,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scenario_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS relations (
                    id TEXT PRIMARY KEY,
                    batch_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    relation_type TEXT NOT NULL,
                    basis_json TEXT,
                    manual INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    UNIQUE(batch_id, source_id, target_id, relation_type)
                );


                CREATE TABLE IF NOT EXISTS configs (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS debug_actions (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    preview_json TEXT NOT NULL,
                    before_json TEXT,
                    after_json TEXT,
                    status TEXT NOT NULL,
                    config_version TEXT,
                    idempotency_key TEXT,
                    result_json TEXT,
                    created_at INTEGER NOT NULL,
                    applied_at INTEGER,
                    restored_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS imports (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    source TEXT,
                    summary_json TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS external_spans (
                    id TEXT PRIMARY KEY,
                    import_id TEXT,
                    trace_id TEXT NOT NULL,
                    span_id TEXT NOT NULL,
                    parent_span_id TEXT,
                    service_name TEXT,
                    name TEXT,
                    start_ns INTEGER,
                    end_ns INTEGER,
                    links_json TEXT,
                    attributes_json TEXT,
                    sampled INTEGER NOT NULL DEFAULT 1,
                    raw_json TEXT,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS mcp_servers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    allowed_tools_json TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS replay_actions (
                    id TEXT PRIMARY KEY,
                    request_id TEXT NOT NULL,
                    batch_id TEXT,
                    status TEXT NOT NULL,
                    request_json TEXT,
                    response_json TEXT,
                    idempotency_key TEXT,
                    created_at INTEGER NOT NULL,
                    finished_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS tickets (
                    id TEXT PRIMARY KEY,
                    report_id TEXT,
                    provider TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload_json TEXT,
                    result_json TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                """
            )
            db.executescript("""
                CREATE TABLE IF NOT EXISTS preview_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
                INSERT OR IGNORE INTO preview_revision VALUES(1,0);
                CREATE TABLE IF NOT EXISTS compose_jobs (
                    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,
                    summary_json TEXT NOT NULL, job_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_compose_jobs_created ON compose_jobs(created_at DESC,id DESC);
                CREATE INDEX IF NOT EXISTS idx_compose_jobs_status ON compose_jobs(status);
            """)
            # Conservative invalidation includes equal-size replacements and deletions.
            for table in ("requests", "scenarios", "scenario_requests", "providers", "rules", "configs", "run_messages", "messages"):
                for event in ("INSERT", "UPDATE", "DELETE"):
                    db.execute(f"CREATE TRIGGER IF NOT EXISTS preview_{table}_{event.lower()} AFTER {event} ON {table} BEGIN UPDATE preview_revision SET revision=revision+1 WHERE id=1; END")
            for event in ("INSERT", "UPDATE", "DELETE"):
                target = "OLD" if event == "DELETE" else "NEW"
                db.execute(f"""CREATE TRIGGER IF NOT EXISTS preview_settings_{event.lower()} AFTER {event} ON settings
                    WHEN {target}.key IN ('agent_context_settings','throttle','active_environment','config_version')
                      OR {target}.key LIKE 'agent-context:%' OR {target}.key LIKE 'model-window:%'
                    BEGIN UPDATE preview_revision SET revision=revision+1 WHERE id=1; END""")
            if db.execute("PRAGMA user_version").fetchone()[0] < 6:
                # One-time migration only; future lists never scan historical settings.
                for row in db.execute("SELECT value FROM settings WHERE key LIKE 'replay-job:%'").fetchall():
                    job = _load_json(row[0], {})
                    if job.get("id"):
                        summary = {key: value for key, value in job.items() if key != "actionIds"}
                        db.execute("INSERT OR IGNORE INTO compose_jobs VALUES(?,?,?,?,?)", (job["id"], job["createdAt"], job["status"], _json(summary), _json(job)))
            previous_version = db.execute("PRAGMA user_version").fetchone()[0]
            for version in range(previous_version + 1, SCHEMA_VERSION + 1):
                self._migrate_columns(db, version)
                db.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)", (version, now_ms()))
                db.execute("INSERT INTO schema_meta(key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(version),))
                db.execute(f"PRAGMA user_version={version}")
            db.execute('CREATE INDEX IF NOT EXISTS idx_requests_batch_time\n                    ON requests(batch_id, started_at, id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_requests_batch_sequence\n                    ON requests(batch_id, sequence);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_requests_source\n                    ON requests(batch_id, source_ip, started_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_requests_trace\n                    ON requests(batch_id, trace_id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_requests_host\n                    ON requests(batch_id, host, path);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_requests_host_time ON requests(batch_id, scheme, host, port, started_at, id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_runs_session ON analysis_runs(session_id, created_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_runs_status ON analysis_runs(status, created_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_scope_requests ON analysis_scope_requests(request_id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, seq);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id, created_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_evidence_request ON evidence(request_id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id, updated_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_scenarios_batch ON scenarios(batch_id, created_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(batch_id, source_id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(batch_id, target_id);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_configs_kind ON configs(kind, updated_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_debug_actions ON debug_actions(created_at);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_spans_trace ON external_spans(trace_id, start_ns);')
            db.execute('CREATE INDEX IF NOT EXISTS idx_replay_actions ON replay_actions(created_at);')
            db.execute("CREATE INDEX IF NOT EXISTS idx_messages_run_role ON messages(run_id,role,created_at)")

            count = db.execute("SELECT COUNT(*) FROM batches").fetchone()[0]
            if count == 0:
                db.execute(
                    "INSERT INTO batches(id, label, created_at, metadata) VALUES (?, ?, ?, ?)",
                    (new_id("batch"), "首次抓包", now_ms(), "{}"),
                )
    @staticmethod
    def _migrate_columns(db: sqlite3.Connection, target_version: int) -> None:
        request_columns = {
            "version": "INTEGER NOT NULL DEFAULT 1",
            "business_state": "TEXT NOT NULL DEFAULT 'unknown'",
            "start_sequence": "INTEGER",
            "completed_sequence": "INTEGER",
            "request_started_at": "INTEGER",
            "request_finished_at": "INTEGER",
            "response_headers_at": "INTEGER",
            "finished_at": "INTEGER",
            "client_peer": "TEXT",
            "connection_id": "TEXT",
            "http_version": "TEXT",
            "rule_evidence": "TEXT",
            "request_headers_original": "TEXT",
            "response_headers_original": "TEXT",
            "request_body_state": "TEXT NOT NULL DEFAULT 'available'",
            "response_body_state": "TEXT NOT NULL DEFAULT 'available'",
            "request_state": "TEXT NOT NULL DEFAULT 'completed'",
            "trace_id": "TEXT",
            "parent_span_id": "TEXT",
            "trace_state": "TEXT",
            "trace_valid": "INTEGER NOT NULL DEFAULT 0",
            "environment": "TEXT",
            "app_version": "TEXT",
            "build_number": "TEXT",
            "capture_loss": "INTEGER NOT NULL DEFAULT 0",
        }
        existing = {row["name"] for row in db.execute("PRAGMA table_info(requests)").fetchall()}
        for name, definition in request_columns.items():
            if name not in existing and (target_version == 5 if name == "business_state" else target_version == 1):
                db.execute(f"ALTER TABLE requests ADD COLUMN {name} {definition}")
        batch_existing = {row["name"] for row in db.execute("PRAGMA table_info(batches)").fetchall()}
        if target_version == 2 and "metadata" not in batch_existing:
            db.execute("ALTER TABLE batches ADD COLUMN metadata TEXT")
        message_existing = {row["name"] for row in db.execute("PRAGMA table_info(messages)").fetchall()}
        if target_version == 2 and "run_id" not in message_existing:
            db.execute("ALTER TABLE messages ADD COLUMN run_id TEXT")
        rule_existing = {row["name"] for row in db.execute("PRAGMA table_info(rules)").fetchall()}
        for name, definition in {"response_status": "INTEGER NOT NULL DEFAULT 200", "delay_ms": "INTEGER NOT NULL DEFAULT 0", "disconnect": "INTEGER NOT NULL DEFAULT 0"}.items():
            if target_version == 4 and name not in rule_existing:
                db.execute(f"ALTER TABLE rules ADD COLUMN {name} {definition}")
        if target_version == 2 and "updated_at" not in rule_existing:
            db.execute("ALTER TABLE rules ADD COLUMN updated_at INTEGER")

    def _ensure_redaction_salt(self) -> None:
        if self.get_setting("redaction_salt") is None:
            self.set_setting("redaction_salt", secrets.token_hex(24))

    # Batches
    def get_current_batch(self) -> dict[str, Any]:
        with self.connect() as db:
            batch_id = self.get_setting("current_batch_id")
            row = db.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if row is None:
                row = db.execute("SELECT * FROM batches ORDER BY created_at DESC LIMIT 1").fetchone()
                self.set_setting("current_batch_id", row["id"])
            return self._batch_to_dict(row)

    def list_batches(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT b.*, COUNT(r.id) AS request_count,
                       SUM(CASE WHEN r.request_state = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
                       SUM(CASE WHEN r.capture_loss = 1 THEN 1 ELSE 0 END) AS capture_loss
                FROM batches b LEFT JOIN requests r ON r.batch_id = b.id
                GROUP BY b.id ORDER BY b.created_at DESC
                """
            ).fetchall()
            return [
                {
                    **self._batch_to_dict(row),
                    "request_count": row["request_count"] or 0,
                    "inProgressCount": row["in_progress_count"] or 0,
                    "captureLoss": row["capture_loss"] or 0,
                }
                for row in rows
            ]

    @staticmethod
    def _batch_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "label": row["label"],
            "createdAt": row["created_at"],
            "metadata": _load_json(row["metadata"] if "metadata" in row.keys() else None, {}),
        }

    def create_batch(self, label: str | None = None, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        batch_id = new_id("batch")
        created_at = now_ms()
        resolved_label = label or f"抓包 {time.strftime('%H:%M')}"
        with self.connect() as db:
            db.execute(
                "INSERT INTO batches(id, label, created_at, metadata) VALUES (?, ?, ?, ?)",
                (batch_id, resolved_label, created_at, _json(metadata or {})),
            )
        self.set_setting("current_batch_id", batch_id)
        return {"id": batch_id, "label": resolved_label, "createdAt": created_at, "request_count": 0, "metadata": metadata or {}}

    def select_batch(self, batch_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if row is None:
                raise ValueError("抓包批次不存在")
        self.set_setting("current_batch_id", batch_id)
        return self._batch_to_dict(row)

    def clear_batch(self, batch_id: str, delete_reports: bool = False) -> None:
        with self.connect() as db:
            paths = db.execute(
                "SELECT request_body_path, response_body_path FROM requests WHERE batch_id = ?",
                (batch_id,),
            ).fetchall()
            db.execute(
                """
                UPDATE evidence SET state = 'deleted'
                WHERE request_id IN (SELECT id FROM requests WHERE batch_id = ?)
                """,
                (batch_id,),
            )
            db.execute("DELETE FROM requests WHERE batch_id = ?", (batch_id,))
            db.execute("DELETE FROM relations WHERE batch_id = ?", (batch_id,))
            db.execute("DELETE FROM scenario_requests WHERE scenario_id IN (SELECT id FROM scenarios WHERE batch_id = ?)", (batch_id,))
            db.execute("DELETE FROM scenarios WHERE batch_id = ?", (batch_id,))
            if delete_reports:
                db.execute(
                    "DELETE FROM reports WHERE run_id IN "
                    "(SELECT id FROM analysis_runs WHERE batch_id = ?)",
                    (batch_id,),
                )
            db.execute(
                "UPDATE analysis_runs SET scope_json = json_set(scope_json, '$.expired', json('true')) WHERE batch_id = ?",
                (batch_id,),
            )
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
            row = db.execute("SELECT id FROM batches ORDER BY created_at DESC LIMIT 1").fetchone()
        if self.get_setting("current_batch_id") == batch_id:
            self.set_setting("current_batch_id", row["id"])

    # Request persistence
    def _body_path(self, request_id: str, direction: str) -> Path:
        return self.body_dir / f"{request_id}-{direction}.bin"

    def _write_body(
        self, request_id: str, direction: str, data: bytes | None
    ) -> tuple[str | None, int | None, bool]:
        if data is None:
            return None, None, False
        truncated = len(data) > MAX_BODY_BYTES
        payload = data[:MAX_BODY_BYTES]
        path = self._body_path(request_id, direction)
        path.write_bytes(payload)
        path.chmod(0o600)
        return str(path), len(data), truncated

    def recover_interrupted_requests(self) -> int:
        stamp = now_ms()
        with self.connect() as db:
            cursor = db.execute(
                "UPDATE requests SET request_state = 'error', error = ?, finished_at = ?, "
                "duration_ms = MAX(0, ? - started_at), response_body_state = 'missing', "
                "version = version + 1 WHERE request_state = 'in_progress'",
                ("上次采集已中断，未收到完整响应", stamp, stamp),
            )
            return cursor.rowcount

    def save_request(self, data: dict[str, Any]) -> dict[str, Any]:
        data = dict(data)
        generation = data.pop("_capture_generation", self.capture_generation)
        if generation != self.capture_generation:
            raise ValueError("清理前的采集任务已失效")
        values = dict(data)
        request_id = str(values["id"])
        with self._write_lock:
            if "request_body" in values:
                path, size, truncated = self._write_body(request_id, "request", values.pop("request_body"))
                values["request_body_path"] = path
                values["request_body_size"] = size
                values["request_truncated"] = int(truncated or bool(values.get("request_truncated")) or values.get("request_body_state") == "capture-truncated")
            if "response_body" in values:
                path, size, truncated = self._write_body(request_id, "response", values.pop("response_body"))
                values["response_body_path"] = path
                values["response_body_size"] = size
                values["response_truncated"] = int(truncated or bool(values.get("response_truncated")) or values.get("response_body_state") == "capture-truncated")
            for key in ("request_headers", "request_headers_original", "response_headers", "response_headers_original"):
                if key in values and not isinstance(values[key], str):
                    values[key] = _json(values[key] or [])
            if "rule_evidence" in values and not isinstance(values["rule_evidence"], str):
                values["rule_evidence"] = _json(values["rule_evidence"] or {})
            with self.connect() as db:
                existing = db.execute(
                    "SELECT version FROM requests WHERE id = ?", (request_id,)
                ).fetchone()
                values["version"] = (existing["version"] + 1) if existing else 1
                if existing:
                    updates = {key: value for key, value in values.items() if key != "id"}
                    assignments = ", ".join(f"{key} = ?" for key in updates)
                    db.execute(
                        f"UPDATE requests SET {assignments} WHERE id = ?",
                        (*updates.values(), request_id),
                    )
                else:
                    columns = ", ".join(values)
                    placeholders = ", ".join("?" for _ in values)
                    db.execute(
                        f"INSERT INTO requests({columns}) VALUES ({placeholders})",
                        tuple(values.values()),
                    )
            if any(config["enabled"] for config in self.list_configs("business_rule")):
                from .domain import DomainService
                state = DomainService(self, lambda *args: None).business_state(request_id)["state"]
                with self.connect() as db:
                    db.execute("UPDATE requests SET business_state = ? WHERE id = ?", (state, request_id))
            return self.request_summary(request_id)

    def update_request_metadata(self, request_ids: list[str], metadata: dict[str, Any]) -> int:
        if not request_ids:
            return 0
        allowed = {"environment", "app_version", "build_number"}
        updates = {key: value for key, value in metadata.items() if key in allowed}
        if not updates:
            return 0
        with self.connect() as db:
            assignments = ", ".join(f"{key} = ?" for key in updates)
            for start in range(0, len(request_ids), 500):
                chunk = request_ids[start : start + 500]
                db.execute(
                    f"UPDATE requests SET {assignments}, version = version + 1 WHERE id IN ({','.join('?' for _ in chunk)})",
                    (*updates.values(), *chunk),
                )
        return len(request_ids)

    def _request_row_to_summary(self, row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        return {
            "id": value["id"],
            "batchId": value["batch_id"],
            "sequence": value["sequence"],
            "version": value.get("version", 1),
            "startSequence": value.get("start_sequence"),
            "completedSequence": value.get("completed_sequence"),
            "method": value["method"],
            "scheme": value["scheme"],
            "host": value["host"],
            "port": value["port"],
            "path": value["path"],
            "url": value["url"],
            "status": value["status"],
            "contentType": value["content_type"],
            "startedAt": value["started_at"],
            "requestStartedAt": value.get("request_started_at"),
            "requestFinishedAt": value.get("request_finished_at"),
            "responseHeadersAt": value.get("response_headers_at"),
            "finishedAt": value.get("finished_at"),
            "durationMs": value["duration_ms"],
            "size": value["size"],
            "sourceIp": value["source_ip"],
            "clientPeer": value.get("client_peer"),
            "connectionId": value.get("connection_id"),
            "httpVersion": value.get("http_version"),
            "encrypted": bool(value["encrypted"]),
            "tlsError": value["tls_error"],
            "matchedRule": value["matched_rule"],
            "actualUrl": value["actual_url"],
            "ruleError": value["rule_error"],
            "error": value["error"],
            "requestState": value.get("request_state", "completed"),
            "requestBodyState": value.get("request_body_state", "available"),
            "responseBodyState": value.get("response_body_state", "available"),
            "requestTruncated": bool(value["request_truncated"]),
            "responseTruncated": bool(value["response_truncated"]),
            "traceId": value.get("trace_id"),
            "parentSpanId": value.get("parent_span_id"),
            "traceState": value.get("trace_state"),
            "traceValid": bool(value.get("trace_valid")),
            "environment": value.get("environment"),
            "appVersion": value.get("app_version"),
            "buildNumber": value.get("build_number"),
            "captureLoss": bool(value.get("capture_loss")),
            "businessState": {"state": value.get("business_state", "unknown"), "configured": value.get("business_state", "unknown") != "unknown"},
        }

    def request_summary(self, request_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if row is None:
                raise ValueError("请求记录不存在")
            return self._request_row_to_summary(row)

    def request_detail(self, request_id: str, preview_chars: int | None = None) -> dict[str, Any]:
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
            "requestHeaders": _load_json(value["request_headers"], []),
            "responseHeaders": _load_json(value["response_headers"], []),
            "requestHeadersOriginal": _load_json(value.get("request_headers_original"), []),
            "responseHeadersOriginal": _load_json(value.get("response_headers_original"), []),
            "requestBody": request_body,
            "responseBody": response_body,
            "requestBodySize": value["request_body_size"],
            "responseBodySize": value["response_body_size"],
            "requestBodyText": self._preview_body(value["request_body_path"], preview_chars),
            "responseBodyText": self._preview_body(value["response_body_path"], preview_chars),
            "ruleEvidence": _load_json(value.get("rule_evidence"), {}),
            "bodyStates": {
                "request": value.get("request_body_state", "available"),
                "response": value.get("response_body_state", "available"),
            },
        }

    def body_range(self, request_id: str, direction: str, offset: int, limit: int) -> tuple[str, bool]:
        if direction not in ("request", "response"):
            raise ValueError("非法正文方向")
        with self.connect() as db:
            row = db.execute(f"SELECT {direction}_body_path AS path FROM requests WHERE id = ?", (request_id,)).fetchone()
        if not row or not row["path"] or not Path(row["path"]).exists():
            return "", False
        with Path(row["path"]).open(encoding="utf-8", errors="replace") as handle:
            remaining = max(0, offset)
            while remaining:
                skipped = handle.read(min(remaining, 8192))
                if not skipped:
                    return "", False
                remaining -= len(skipped)
            chunk = handle.read(max(1, limit) + 1)
        return chunk[:limit], len(chunk) > limit

    def body_bytes(self, request_id: str, direction: str) -> bytes | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if row is None:
                raise ValueError("请求记录不存在")
        key = "request_body_path" if direction == "request" else "response_body_path"
        path = row[key]
        if not path:
            return None
        body_path = Path(path)
        return body_path.read_bytes() if body_path.exists() else None

    @staticmethod
    def _read_body(path: str | None) -> dict[str, Any] | None:
        if not path:
            return None
        body_path = Path(path)
        if not body_path.exists():
            return None
        return {
            "size": body_path.stat().st_size,
            "base64": None,
            "path": str(body_path),
            "mime": mimetypes.guess_type(body_path.name)[0] or "application/octet-stream",
        }

    @staticmethod
    def _preview_body(path: str | None, limit: int | None = None) -> str | None:
        if not path:
            return None
        body_path = Path(path)
        if not body_path.exists():
            return None
        with body_path.open("rb") as handle:
            data = handle.read(None if limit is None else limit * 4)
        if b"\x00" in data[:2048]:
            return None
        try:
            return data.decode("utf-8")[:limit] if limit is not None else data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("utf-8", errors="replace")
            return text[:limit] if limit is not None else text

    def query_requests(
        self,
        batch_id: str,
        *,
        query: str = "",
        method: str = "",
        status: str = "",
        source_ip: str = "",
        host: str = "",
        path_prefix: str = "",
        path_exact: str = "",
        started_after: int | None = None,
        started_before: int | None = None,
        trace_id: str = "",
        environment: str = "",
        app_version: str = "",
        request_state: str = "",
        errors_only: bool = False,
        limit: int = 100,
        cursor: str | None = None,
        sort: str = "desc",
        since_started_at: int | None = None,
        exclude_ids: list[str] | None = None,
        include_ids: list[str] | None = None,
        scope_run_id: str | None = None,
        tree_summary: bool = False,
        host_summary: bool = False,
        seek_id: str | None = None,
        offset: int = 0,
        scheme: str = "",
        port: int | None = None,
    ) -> dict[str, Any]:
        clauses = ["batch_id = ?"]
        values: list[Any] = [batch_id]
        if scheme:
            clauses.append("scheme = ?")
            values.append(scheme)
        if port is not None:
            clauses.append("port = ?")
            values.append(port)
        if query:
            clauses.append("(url LIKE ? OR host LIKE ? OR path LIKE ?)")
            values.extend([f"%{query}%"] * 3)
        if method:
            clauses.append("method = ?")
            values.append(method.upper())
        if status:
            try:
                status_text = str(status).strip().lower()
                if status_text in ("2xx", "3xx", "4xx", "5xx"):
                    status_number = int(status_text[0]) * 100
                    clauses.append("status >= ? AND status < ?")
                    values.extend([status_number, status_number + 100])
                else:
                    status_number = int(status_text)
                    clauses.append("status = ?")
                    values.append(status_number)
            except ValueError:
                pass
        if source_ip:
            clauses.append("source_ip = ?")
            values.append(source_ip)
        if host:
            clauses.append("host = ?")
            values.append(host.lower())
        if path_prefix:
            clauses.append("path LIKE ?")
            values.append(f"{path_prefix}%")
        if path_exact:
            clauses.append("substr(path, 1, instr(path || '?', '?') - 1) = ?")
            values.append(path_exact)
        if started_after is not None:
            clauses.append("started_at >= ?")
            values.append(started_after)
        if started_before is not None:
            clauses.append("started_at <= ?")
            values.append(started_before)
        if trace_id:
            clauses.append("trace_id = ? AND trace_valid = 1")
            values.append(trace_id)
        if environment:
            clauses.append("environment = ?")
            values.append(environment)
        if app_version:
            clauses.append("app_version = ?")
            values.append(app_version)
        if request_state:
            clauses.append("request_state = ?")
            values.append(request_state)
        if errors_only:
            clauses.append("(error IS NOT NULL OR tls_error IS NOT NULL OR rule_error IS NOT NULL OR status >= 400 OR business_state = 'business-failure')")
        if exclude_ids:
            clauses.append(f"id NOT IN ({','.join('?' for _ in exclude_ids)})")
            values.extend(exclude_ids)
        if include_ids is not None:
            if not isinstance(include_ids, list) or len(include_ids) > 1000 or any(not isinstance(item, str) for item in include_ids):
                raise ValueError("includeIds必须是最多1000个请求ID的数组")
            clauses.append(f"id IN ({','.join('?' for _ in include_ids)})" if include_ids else "0")
            values.extend(include_ids)
        if scope_run_id:
            clauses.append(
                "id IN (SELECT request_id FROM analysis_scope_requests WHERE run_id = ?)"
            )
            values.append(scope_run_id)

        where = " AND ".join(f"({clause})" if " OR " in clause else clause for clause in clauses)
        descending = sort != "asc"
        cursor_value: tuple[int, str] | None = None
        if cursor:
            try:
                decoded = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
                parsed = json.loads(decoded)
                cursor_value = (int(parsed["startedAt"]), str(parsed["id"]))
            except (ValueError, KeyError, json.JSONDecodeError):
                cursor_value = None
        page_clauses = list(clauses)
        page_values = list(values)
        if cursor_value:
            operator = "<" if descending else ">"
            page_clauses.append(f"(started_at {operator} ? OR (started_at = ? AND id {operator} ?))")
            page_values.extend([cursor_value[0], cursor_value[0], cursor_value[1]])
        safe_limit = max(1, min(int(limit), 2000))
        page_values.append(safe_limit + 1)
        order = "DESC" if descending else "ASC"
        with self.connect() as db:
            total = db.execute(f"SELECT COUNT(*) FROM requests WHERE {where}", tuple(values)).fetchone()[0]
            batch_total = db.execute("SELECT COUNT(*) FROM requests WHERE batch_id = ?", (batch_id,)).fetchone()[0]
            new_count = 0
            if since_started_at is not None:
                new_count = db.execute(
                    f"SELECT COUNT(*) FROM requests WHERE {where} AND started_at > ?",
                    (*values, since_started_at),
                ).fetchone()[0]
            if host_summary:
                rows = db.execute(
                    f"SELECT scheme, host, port, COUNT(*) AS count, "
                    "SUM(CASE WHEN status >= 400 OR error IS NOT NULL OR tls_error IS NOT NULL OR rule_error IS NOT NULL OR business_state = 'business-failure' THEN 1 ELSE 0 END) AS failures, "
                    "SUM(CASE WHEN request_state = 'in_progress' THEN 1 ELSE 0 END) AS pending, "
                    f"MAX(started_at) AS latest FROM requests WHERE {where} "
                    "GROUP BY scheme, host, port ORDER BY scheme, host, port",
                    tuple(values),
                ).fetchall()
                return {"items": [dict(row) for row in rows], "matchCount": total, "batchCount": batch_total}
            if tree_summary:
                partition = "scheme, host, port, method, substr(path, 1, instr(path || '?', '?') - 1)"
                rows = db.execute(
                    f"WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY {partition} ORDER BY started_at DESC, id DESC) AS rank, "
                    f"COUNT(*) OVER (PARTITION BY {partition}) AS node_count, "
                    f"SUM(CASE WHEN status >= 400 OR error IS NOT NULL OR tls_error IS NOT NULL OR rule_error IS NOT NULL OR business_state = 'business-failure' THEN 1 ELSE 0 END) OVER (PARTITION BY {partition}) AS node_failures, "
                    f"SUM(CASE WHEN request_state = 'in_progress' THEN 1 ELSE 0 END) OVER (PARTITION BY {partition}) AS node_pending "
                    f"FROM requests WHERE {where}) SELECT * FROM ranked WHERE rank=1 LIMIT 100001",
                    tuple(values),
                ).fetchall()
                return {"items": [{**self._request_row_to_summary(row), "_count": row["node_count"], "_failures": row["node_failures"], "_pending": row["node_pending"]} for row in rows[:100000]], "partial": len(rows) > 100000, "matchCount": total, "batchCount": batch_total}
            if seek_id:
                target = db.execute(f"SELECT id, started_at FROM requests WHERE {where} AND id = ?", (*values, seek_id)).fetchone()
                if target:
                    operator = ">" if descending else "<"
                    rank = db.execute(f"SELECT COUNT(*) FROM requests WHERE {where} AND (started_at {operator} ? OR (started_at = ? AND id {operator} ?))", (*values, target["started_at"], target["started_at"], target["id"])).fetchone()[0]
                    offset = (rank // safe_limit) * safe_limit
            offset = min(max(0, int(offset)), max(0, (total - 1) // safe_limit * safe_limit))
            rows = db.execute(
                f"SELECT * FROM requests WHERE {' AND '.join(page_clauses)} "
                f"ORDER BY started_at {order}, id {order} LIMIT ? OFFSET ?",
                (*page_values, max(0, int(offset))),
            ).fetchall()
        has_more = len(rows) > safe_limit
        page_rows = rows[:safe_limit]
        next_cursor = None
        if has_more and page_rows:
            last = page_rows[-1]
            next_cursor = base64.urlsafe_b64encode(
                _json({"startedAt": last["started_at"], "id": last["id"]}).encode()
            ).decode().rstrip("=")
        return {
            "items": [self._request_row_to_summary(row) for row in page_rows],
            "matchCount": total,
            "batchCount": batch_total,
            "loadedCount": len(page_rows),
            "offset": max(0, int(offset)),
            "nextCursor": next_cursor,
            "newSinceScope": new_count,
            "sort": "asc" if not descending else "desc",
        }

    def list_requests(
        self,
        batch_id: str,
        query: str = "",
        method: str = "",
        status: str = "",
        source_ip: str = "",
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        page = self.query_requests(
            batch_id,
            query=query,
            method=method,
            status=status,
            source_ip=source_ip,
            limit=limit,
            sort="desc",
        )
        return list(reversed(page["items"]))

    def filter_options(self, batch_id: str) -> dict[str, Any]:
        with self.connect() as db:
            devices = [
                row[0]
                for row in db.execute(
                    "SELECT DISTINCT source_ip FROM requests WHERE batch_id = ? AND source_ip IS NOT NULL ORDER BY source_ip",
                    (batch_id,),
                ).fetchall()
            ]
            hosts = [
                row[0]
                for row in db.execute(
                    "SELECT DISTINCT host FROM requests WHERE batch_id = ? ORDER BY host",
                    (batch_id,),
                ).fetchall()
            ]
            environments = [
                row[0]
                for row in db.execute(
                    "SELECT DISTINCT environment FROM requests WHERE batch_id = ? AND environment IS NOT NULL ORDER BY environment",
                    (batch_id,),
                ).fetchall()
            ]
        return {"devices": devices, "hosts": hosts, "environments": environments}

    def request_versions(self, request_ids: list[str]) -> list[dict[str, Any]]:
        if not request_ids:
            return []
        result = []
        with self.connect() as db:
            for start in range(0, len(request_ids), 500):
                ids = request_ids[start:start+500]
                rows = db.execute(f"SELECT id, version FROM requests WHERE id IN ({','.join('?' for _ in ids)})", ids).fetchall()
                result.extend({"id": row["id"], "version": row["version"]} for row in rows)
        return result

    def request_versions_valid(self, versions: list[dict[str, Any]]) -> tuple[bool, list[str]]:
        invalid: list[str] = []
        current = {item["id"]: item["version"] for item in self.request_versions([str(v.get("id")) for v in versions])}
        for item in versions:
            request_id = str(item.get("id"))
            if current.get(request_id) != item.get("version"):
                invalid.append(request_id)
        return not invalid, invalid

    # Rules and local configuration versions
    def list_rules(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM rules ORDER BY sort_order, created_at").fetchall()
            return [self._rule_to_dict(row) for row in rows]

    @staticmethod
    def _rule_to_dict(row: sqlite3.Row) -> dict[str, Any]:
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
            "responseStatus": value.get("response_status", 200),
            "delayMs": value.get("delay_ms", 0),
            "disconnect": bool(value.get("disconnect", 0)),
            "updatedAt": value.get("updated_at"),
        }

    def save_rule(self, data: dict[str, Any]) -> dict[str, Any]:
        rule_id = data.get("id") or new_id("rule")
        timestamp = now_ms()
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
            "responseStatus": "response_status",
            "delayMs": "delay_ms",
            "disconnect": "disconnect",
        }
        with self.connect() as db:
            existing = db.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
            if existing:
                updates = {column: data.get(key) for key, column in allowed.items() if key in data}
                if "enabled" in data:
                    updates["enabled"] = int(bool(data["enabled"]))
                updates["updated_at"] = timestamp
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
                    "response_status": int(data.get("responseStatus", 200)),
                    "delay_ms": max(0, min(int(data.get("delayMs", 0)), 60000)),
                    "disconnect": int(bool(data.get("disconnect", False))),
                    "created_at": timestamp,
                    "updated_at": timestamp,
                }
                db.execute(
                    f"INSERT INTO rules({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
                    tuple(values.values()),
                )
            row = db.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
        self.bump_config_version()
        return self._rule_to_dict(row)

    def delete_rule(self, rule_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
        self.bump_config_version()

    def reorder_rules(self, ids: list[str]) -> None:
        with self.connect() as db:
            for index, rule_id in enumerate(ids):
                db.execute(
                    "UPDATE rules SET sort_order = ?, updated_at = ? WHERE id = ?",
                    (index + 1, now_ms(), rule_id),
                )
        self.bump_config_version()

    def config_hash(self) -> str:
        payload = {"rules": self.list_rules(), "throttle": self.get_setting("throttle", "{}"), "activeEnvironment": self.get_setting("active_environment"), "analysisConfigs": [item for item in self.list_configs() if item["kind"] in ("business_rule", "association", "dynamic_fields", "environment")]}
        return hashlib.sha256(_json(payload).encode()).hexdigest()

    def config_version(self) -> str:
        current = int(self.get_setting("config_version", "0") or 0)
        return str(current)

    def bump_config_version(self) -> str:
        with self.connect() as db:
            current = int(
                (
                    db.execute("SELECT value FROM settings WHERE key = 'config_version'").fetchone() or {"value": "0"}
                )["value"]
                or 0
            )
            next_value = current + 1
            db.execute(
                "INSERT INTO settings(key, value) VALUES ('config_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(next_value),),
            )
        return str(next_value)

    # Sessions, messages and files
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
            runs = self._list_run_rows(db, session_id)
            reports = db.execute(
                "SELECT * FROM reports WHERE session_id = ? ORDER BY updated_at DESC",
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
                    "meta": _load_json(msg["meta"], {}),
                    "createdAt": msg["created_at"],
                }
                for msg in messages
            ],
            "files": [
                {"id": item["id"], "path": item["path"], "createdAt": item["created_at"]}
                for item in files
            ],
            "runs": runs,
            "reports": [self._report_to_dict(item) for item in reports],
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
            db.execute("DELETE FROM settings WHERE key = ?", (f"agent-context:{session_id}",))
            prefix = f"agent-submission:{session_id}:"
            db.execute("DELETE FROM settings WHERE substr(key,1,?)=?", (len(prefix), prefix))
            db.execute("DELETE FROM session_files WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            db.execute(
                "DELETE FROM analysis_scope_requests WHERE run_id IN "
                "(SELECT id FROM analysis_runs WHERE session_id = ?)",
                (session_id,),
            )
            db.execute("DELETE FROM evidence WHERE run_id IN (SELECT id FROM analysis_runs WHERE session_id = ?)", (session_id,))
            db.execute("DELETE FROM run_events WHERE run_id IN (SELECT id FROM analysis_runs WHERE session_id = ?)", (session_id,))
            db.execute("DELETE FROM run_messages WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM reports WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM analysis_runs WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        meta: dict[str, Any] | None = None,
        message_id: str | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        message_id = message_id or new_id("message")
        created_at = now_ms()
        with self.connect() as db:
            db.execute(
                "INSERT INTO messages(id, session_id, run_id, role, content, meta, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (message_id, session_id, run_id, role, content, _json(meta or {}), created_at),
            )
            db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (created_at, session_id))
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
            db.execute("UPDATE messages SET meta = ? WHERE id = ?", (_json(meta), message_id))

    def add_session_file(self, session_id: str, path: str) -> dict[str, Any]:
        canonical = Path(path).resolve(strict=True)
        if not canonical.is_file():
            raise ValueError("只能共享普通文件")
        path = str(canonical)
        self.set_setting(f"file-grant:{session_id}:{path}", hashlib.sha256(canonical.read_bytes()).hexdigest())
        file_id = new_id("file")
        created_at = now_ms()
        with self.connect() as db:
            db.execute(
                "INSERT INTO session_files(id, session_id, path, created_at) VALUES (?, ?, ?, ?)",
                (file_id, session_id, path, created_at),
            )
        return {"id": file_id, "path": path, "createdAt": created_at}

    # Agent runs, events and protocol messages
    def create_run(
        self,
        session_id: str,
        scope: dict[str, Any],
        mode: str,
        provider: dict[str, Any],
        budget: dict[str, Any],
        parent_run_id: str | None = None,
    ) -> dict[str, Any]:
        run_id = new_id("run")
        timestamp = now_ms()
        batch_id = scope.get("batchId")
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO analysis_runs(
                    id, session_id, parent_run_id, batch_id, scope_json, mode,
                    provider_id, model, status, budget_json, created_at, started_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)
                """,
                (
                    run_id,
                    session_id,
                    parent_run_id,
                    batch_id,
                    _json(scope),
                    mode,
                    provider.get("id"),
                    provider.get("model"),
                    _json(budget),
                    timestamp,
                    timestamp,
                ),
            )
            for item in scope.get("requestVersions") or []:
                db.execute(
                    "INSERT OR REPLACE INTO analysis_scope_requests(run_id, request_id, request_version) VALUES (?, ?, ?)",
                    (run_id, str(item.get("id")), int(item.get("version") or 1)),
                )
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("""SELECT analysis_runs.*,
                (SELECT content FROM messages WHERE run_id=analysis_runs.id AND role='user' ORDER BY created_at,id LIMIT 1) AS task_text
                FROM analysis_runs WHERE id = ?""", (run_id,)).fetchone()
            if row is None:
                raise ValueError("分析记录不存在")
            events = db.execute(
                "SELECT * FROM run_events WHERE run_id = ? ORDER BY seq",
                (run_id,),
            ).fetchall()
            evidence = db.execute(
                "SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at",
                (run_id,),
            ).fetchall()
            value = self._history_title(db, row)
        return {
            **value,
            "events": [self._event_to_dict(item) for item in events],
            "evidence": [self._evidence_to_dict(item) for item in evidence],
        }

    def list_runs(self, session_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as db:
            return self._list_run_rows(db, session_id, limit)

    def run_history(self, session_id: str, offset: int = 0, limit: int = 12) -> dict[str, Any]:
        self.get_session(session_id)
        limit = max(1, min(limit, 50))
        with self.connect() as db:
            total = db.execute("SELECT count(*) FROM analysis_runs WHERE session_id=?", (session_id,)).fetchone()[0]
            offset = min(max(0, offset), max(0, ((total-1)//limit)*limit))
            rows = db.execute("""SELECT analysis_runs.*,
                (SELECT substr(content,1,160) FROM messages WHERE run_id=analysis_runs.id AND role='user' ORDER BY created_at,id LIMIT 1) AS task_text
                FROM analysis_runs WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?""", (session_id, limit, offset)).fetchall()
            items = [self._history_title(db, row) for row in rows]
        return {"items": items, "total": total, "offset": offset}

    @staticmethod
    def _list_run_rows(db: sqlite3.Connection, session_id: str, limit: int = 50) -> list[dict[str, Any]]:
        rows = db.execute(
            """SELECT analysis_runs.*,
                (SELECT substr(content,1,160) FROM messages WHERE run_id=analysis_runs.id AND role='user' ORDER BY created_at,id LIMIT 1) AS task_text
                FROM analysis_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?""",
            (session_id, max(1, min(limit, 200))),
        ).fetchall()
        return [Store._history_title(db, row) for row in rows]

    @staticmethod
    def _history_title(db: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        value = Store._run_to_dict(row)
        if not value.get("parentRunId"):
            return value
        chain = db.execute("""WITH RECURSIVE parents(id,parent_run_id,session_id,depth,path) AS (
            SELECT id,parent_run_id,session_id,0,'|'||id||'|' FROM analysis_runs WHERE id=?
            UNION ALL SELECT r.id,r.parent_run_id,r.session_id,p.depth+1,p.path||r.id||'|'
            FROM analysis_runs r JOIN parents p ON r.id=p.parent_run_id
            WHERE p.depth<64 AND r.session_id=p.session_id AND instr(p.path,'|'||r.id||'|')=0
        ) SELECT id,parent_run_id,depth FROM parents ORDER BY depth DESC LIMIT 1""", (row["id"],)).fetchone()
        if chain and not chain["parent_run_id"]:
            text = db.execute("SELECT substr(content,1,160) FROM messages WHERE run_id=? AND role='user' ORDER BY created_at,id LIMIT 1", (chain["id"],)).fetchone()
            if text and text[0]:
                value.update(taskText=text[0], continuationDepth=chain["depth"], rootTaskMissing=False)
                return value
        value.update(rootTaskMissing=True, continuationDepth=chain["depth"] if chain else 0)
        return value

    @staticmethod
    def _run_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "sessionId": row["session_id"],
            "parentRunId": row["parent_run_id"],
            "batchId": row["batch_id"],
            "scope": _load_json(row["scope_json"], {}),
            "mode": row["mode"],
            "providerId": row["provider_id"],
            "model": row["model"],
            "status": row["status"],
            "statusDetail": row["status_detail"],
            "taskText": row["task_text"] if "task_text" in row.keys() else None,
            "budget": _load_json(row["budget_json"], {}),
            "usage": _load_json(row["usage_json"], {}),
            "summary": row["summary"],
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
        }

    def update_run(self, run_id: str, **updates: Any) -> dict[str, Any]:
        mapping = {
            "status": "status",
            "status_detail": "status_detail",
            "usage": "usage_json",
            "summary": "summary",
            "finished_at": "finished_at",
            "scope": "scope_json",
        }
        values: dict[str, Any] = {}
        for key, value in updates.items():
            column = mapping.get(key)
            if column:
                values[column] = _json(value) if key in ("usage", "scope") else value
        if values:
            with self.connect() as db:
                assignments = ", ".join(f"{key} = ?" for key in values)
                db.execute(f"UPDATE analysis_runs SET {assignments} WHERE id = ?", (*values.values(), run_id))
        return self.get_run(run_id)

    def append_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        step_id: str | None = None,
        tool_call_id: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        event_id = new_id("event")
        created_at = now_ms()
        with self.transaction() as db:
            row = db.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            seq = int(row["seq"])
            db.execute(
                """
                INSERT INTO run_events(
                    run_id, seq, id, event_type, step_id, tool_call_id, status, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    seq,
                    event_id,
                    event_type,
                    step_id,
                    tool_call_id,
                    status,
                    _json(payload),
                    created_at,
                ),
            )
        return {
            "runId": run_id,
            "seq": seq,
            "id": event_id,
            "eventType": event_type,
            "stepId": step_id,
            "toolCallId": tool_call_id,
            "status": status,
            "payload": payload,
            "createdAt": created_at,
        }

    @staticmethod
    def _event_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "runId": row["run_id"],
            "seq": row["seq"],
            "id": row["id"],
            "eventType": row["event_type"],
            "stepId": row["step_id"],
            "toolCallId": row["tool_call_id"],
            "status": row["status"],
            "payload": _load_json(row["payload_json"], {}),
            "createdAt": row["created_at"],
        }

    def list_events(self, run_id: str, after_seq: int = 0, limit: int = 500) -> dict[str, Any]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                (run_id, max(0, after_seq), max(1, min(limit, 2000))),
            ).fetchall()
        return {
            "items": [self._event_to_dict(row) for row in rows],
            "lastSeq": rows[-1]["seq"] if rows else after_seq,
        }

    def save_run_messages(self, run_id: str, session_id: str, messages: list[Any], sdk_version: str) -> None:
        sequence_row = self.get_run(run_id)
        with self.connect() as db:
            seq = db.execute("SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_messages WHERE session_id = ?", (session_id,)).fetchone()[0]
            db.execute(
                """
                INSERT INTO run_messages(run_id, session_id, sequence, sdk_version, messages_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET messages_json=excluded.messages_json, created_at=excluded.created_at
                """,
                (run_id, session_id, seq, sdk_version, _json(messages), now_ms()),
            )
        if sequence_row["status"] == "preparing":
            self.update_run(run_id, status="running")

    def load_run_messages(self, session_id: str) -> tuple[list[Any], str | None]:
        with self.connect() as db:
            row = db.execute(
                "SELECT messages_json, sdk_version, run_id FROM run_messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        if row is None:
            return [], None
        return _load_json(row["messages_json"], []), row["run_id"]

    def mark_interrupted_runs(self) -> int:
        with self.connect() as db:
            rows = db.execute(
                "SELECT id FROM analysis_runs WHERE status IN ('preparing', 'running', 'waiting_approval', 'executing_tool')"
            ).fetchall()
            db.execute(
                "UPDATE analysis_runs SET status = 'interrupted', status_detail = '应用退出时运行未完成', "
                "finished_at = ? WHERE status IN ('preparing', 'running', 'waiting_approval', 'executing_tool')",
                (now_ms(),),
            )
        for row in rows:
            self.append_event(
                row["id"],
                "run_interrupted",
                {"message": "应用退出时运行未完成，已有事件和证据仍可查看。"},
                status="interrupted",
            )
        return len(rows)

    def recover_inflight_actions(self) -> None:
        timestamp = now_ms()
        with self.connect() as db:
            db.execute(
                """
                UPDATE replay_actions
                SET status = 'unknown',
                    response_json = ?,
                    finished_at = ?
                WHERE status = 'sending'
                """,
                (
                    _json(
                        {
                            "error": "应用退出时重放尚未确认结果，禁止自动重试。",
                            "resultUnknown": True,
                        }
                    ),
                    timestamp,
                ),
            )
            db.execute(
                """
                UPDATE tickets
                SET status = 'unknown',
                    result_json = ?,
                    updated_at = ?
                WHERE status = 'sending'
                """,
                (
                    _json(
                        {
                            "error": "应用退出时工单创建尚未确认结果，请先在外部平台核对。",
                            "resultUnknown": True,
                        }
                    ),
                    timestamp,
                ),
            )
            db.execute(
                """
                UPDATE debug_actions
                SET status = 'failed',
                    result_json = ?
                WHERE status IN ('applying', 'restoring')
                """,
                (
                    _json(
                        {
                            "error": "应用退出时调试操作尚未确认完成，请核对当前配置后重新预览。",
                            "resultUnknown": True,
                        }
                    ),
                ),
            )

    # Evidence and reports
    def add_evidence(
        self,
        run_id: str,
        request_id: str,
        request_version: int,
        direction: str,
        summary: str,
        *,
        locator: str | None = None,
        redacted_value: Any = None,
    ) -> dict[str, Any]:
        evidence_id = new_id("evidence")
        created_at = now_ms()
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO evidence(
                    id, run_id, request_id, request_version, direction, locator,
                    summary, redacted_value_json, state, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)
                """,
                (
                    evidence_id,
                    run_id,
                    request_id,
                    request_version,
                    direction,
                    locator,
                    summary,
                    _json(redacted_value),
                    created_at,
                ),
            )
        return self.get_evidence(evidence_id)

    def get_evidence(self, evidence_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM evidence WHERE id = ?", (evidence_id,)).fetchone()
            if row is None:
                raise ValueError("证据不存在")
            request = db.execute("SELECT * FROM requests WHERE id = ?", (row["request_id"],)).fetchone()
        value = self._evidence_to_dict(row)
        if request is None:
            value["state"] = "deleted"
        elif request["version"] != row["request_version"]:
            value["state"] = "stale"
            value["currentVersion"] = request["version"]
        comparison = value.get("redactedValue")
        if isinstance(comparison, dict) and comparison.get("requestIdB"):
            current = self.request_versions([comparison["requestIdB"]])
            if not current or current[0]["version"] != comparison.get("versionB"):
                value["state"] = "stale-comparison"
        return value

    @staticmethod
    def _evidence_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "runId": row["run_id"],
            "requestId": row["request_id"],
            "requestVersion": row["request_version"],
            "direction": row["direction"],
            "locator": row["locator"],
            "summary": row["summary"],
            "redactedValue": _load_json(row["redacted_value_json"], None),
            "state": row["state"],
            "createdAt": row["created_at"],
        }

    def list_evidence(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT id FROM evidence WHERE run_id = ? ORDER BY created_at", (run_id,)).fetchall()
        return [self.get_evidence(row["id"]) for row in rows]

    def save_report(self, data: dict[str, Any]) -> dict[str, Any]:
        report_id = data.get("id") or new_id("report")
        timestamp = now_ms()
        with self.connect() as db:
            existing = db.execute("SELECT id FROM reports WHERE id = ?", (report_id,)).fetchone()
            if existing:
                db.execute(
                    "UPDATE reports SET title=?, content=?, scope_json=?, status=?, updated_at=? WHERE id=?",
                    (
                        data["title"],
                        data["content"],
                        _json(data.get("scope") or {}),
                        data.get("status", "draft"),
                        timestamp,
                        report_id,
                    ),
                )
            else:
                db.execute(
                    """
                    INSERT INTO reports(id, session_id, run_id, title, content, scope_json, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        report_id,
                        data["sessionId"],
                        data.get("runId"),
                        data["title"],
                        data["content"],
                        _json(data.get("scope") or {}),
                        data.get("status", "draft"),
                        timestamp,
                        timestamp,
                    ),
                )
        return self.get_report(report_id)

    def get_report(self, report_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
        if row is None:
            raise ValueError("报告不存在")
        return self._report_to_dict(row)

    @staticmethod
    def _report_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "sessionId": row["session_id"],
            "runId": row["run_id"],
            "title": row["title"],
            "content": row["content"],
            "scope": _load_json(row["scope_json"], {}),
            "status": row["status"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def list_reports(self, session_id: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as db:
            if session_id:
                rows = db.execute(
                    "SELECT * FROM reports WHERE session_id = ? ORDER BY updated_at DESC", (session_id,)
                ).fetchall()
            else:
                rows = db.execute("SELECT * FROM reports ORDER BY updated_at DESC").fetchall()
        return [self._report_to_dict(row) for row in rows]

    def report_summaries(self) -> list[dict[str, Any]]:
        # Compatibility catalogue/selectors need titles, never full report bodies.
        with self.connect() as db:
            rows = db.execute("SELECT id,session_id,title FROM reports ORDER BY updated_at DESC,id DESC").fetchall()
        return [{"id": row["id"], "sessionId": row["session_id"], "title": row["title"]} for row in rows]

    def report_history(self, session_id: str, offset: int = 0, limit: int = 8) -> dict[str, Any]:
        limit = max(1, min(limit, 50))
        with self.connect() as db:
            total = db.execute("SELECT count(*) FROM reports WHERE session_id=?", (session_id,)).fetchone()[0]
            offset = min(max(0, offset), max(0, ((total-1)//limit)*limit))
            rows = db.execute("SELECT id,session_id,run_id,title,status,created_at,updated_at FROM reports WHERE session_id=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?", (session_id,limit,offset)).fetchall()
        return {"items": [{"id": row["id"], "sessionId": row["session_id"], "runId": row["run_id"], "title": row["title"], "status": row["status"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]} for row in rows], "total": total, "offset": offset}

    def delete_report(self, report_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM reports WHERE id = ?", (report_id,))

    # Scenarios and relations
    def start_scenario(self, batch_id: str, name: str, device: str | None = None) -> dict[str, Any]:
        scenario_id = new_id("scenario")
        timestamp = now_ms()
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO scenarios(id, batch_id, name, device, status, started_at, created_at)
                VALUES (?, ?, ?, ?, 'active', ?, ?)
                """,
                (scenario_id, batch_id, name, device, timestamp, timestamp),
            )
        return self.get_scenario(scenario_id)

    def end_scenario(self, scenario_id: str, include_ids: list[str] | None = None) -> dict[str, Any]:
        timestamp = now_ms()
        with self.connect() as db:
            row = db.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
            if row is None:
                raise ValueError("场景不存在")
            db.execute(
                "UPDATE scenarios SET status = 'ended', ended_at = ? WHERE id = ?",
                (timestamp, scenario_id),
            )
            if include_ids is None:
                include_ids = [
                    item["id"]
                    for item in db.execute(
                        "SELECT id FROM requests WHERE batch_id = ? AND started_at >= ? AND started_at <= ?"
                        + (" AND source_ip = ?" if row["device"] else ""),
                        (
                            row["batch_id"],
                            row["started_at"],
                            timestamp,
                            *([row["device"]] if row["device"] else []),
                        ),
                    ).fetchall()
                ]
            for request_id in include_ids:
                db.execute(
                    "INSERT OR IGNORE INTO scenario_requests(scenario_id, request_id, membership, created_at) VALUES (?, ?, 'include', ?)",
                    (scenario_id, request_id, timestamp),
                )
        return self.get_scenario(scenario_id)

    def set_scenario_request(self, scenario_id: str, request_id: str, membership: str, note: str = "") -> None:
        if membership not in ("include", "exclude"):
            raise ValueError("场景请求关系必须是 include 或 exclude")
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO scenario_requests(scenario_id, request_id, membership, note, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(scenario_id, request_id) DO UPDATE SET membership=excluded.membership, note=excluded.note
                """,
                (scenario_id, request_id, membership, note, now_ms()),
            )

    def get_scenario(self, scenario_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
            if row is None:
                raise ValueError("场景不存在")
            members = db.execute(
                """
                SELECT r.*, sr.membership, sr.note
                FROM scenario_requests sr JOIN requests r ON r.id = sr.request_id
                WHERE sr.scenario_id = ? ORDER BY r.started_at
                """,
                (scenario_id,),
            ).fetchall()
        include = [self._request_row_to_summary(item) for item in members if item["membership"] == "include"]
        exclude = [self._request_row_to_summary(item) for item in members if item["membership"] == "exclude"]
        return {
            "id": row["id"],
            "batchId": row["batch_id"],
            "name": row["name"],
            "device": row["device"],
            "status": row["status"],
            "startedAt": row["started_at"],
            "endedAt": row["ended_at"],
            "createdAt": row["created_at"],
            "requests": include,
            "excluded": exclude,
            "requestCount": len(include),
        }

    def list_scenarios(self, batch_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT s.*, COUNT(sr.request_id) AS request_count
                FROM scenarios s LEFT JOIN scenario_requests sr
                    ON sr.scenario_id = s.id AND sr.membership = 'include'
                WHERE s.batch_id = ? GROUP BY s.id ORDER BY s.created_at DESC
                """,
                (batch_id,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "batchId": row["batch_id"],
                "name": row["name"],
                "device": row["device"],
                "status": row["status"],
                "startedAt": row["started_at"],
                "endedAt": row["ended_at"],
                "createdAt": row["created_at"],
                "requestCount": row["request_count"] or 0,
            }
            for row in rows
        ]

    def add_relation(
        self,
        batch_id: str,
        source_id: str,
        target_id: str,
        relation_type: str,
        basis: dict[str, Any],
        manual: bool = False,
    ) -> dict[str, Any]:
        relation_id = new_id("relation")
        with self.connect() as db:
            existing = db.execute(
                "SELECT id FROM relations WHERE batch_id = ? AND source_id = ? AND target_id = ? AND relation_type = ?",
                (batch_id, source_id, target_id, relation_type),
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE relations SET basis_json = ?, manual = ? WHERE id = ?",
                    (_json(basis), int(manual), existing["id"]),
                )
                relation_id = existing["id"]
            else:
                db.execute(
                    """
                    INSERT INTO relations(id, batch_id, source_id, target_id, relation_type, basis_json, manual, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (relation_id, batch_id, source_id, target_id, relation_type, _json(basis), int(manual), now_ms()),
                )
        return self.get_relation(relation_id)

    def get_relation(self, relation_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM relations WHERE id = ?", (relation_id,)).fetchone()
        if row is None:
            raise ValueError("关联不存在")
        return self._relation_to_dict(row)

    @staticmethod
    def _relation_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "batchId": row["batch_id"],
            "sourceId": row["source_id"],
            "targetId": row["target_id"],
            "type": row["relation_type"],
            "basis": _load_json(row["basis_json"], {}),
            "manual": bool(row["manual"]),
            "createdAt": row["created_at"],
        }

    def list_relations(self, batch_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM relations WHERE batch_id = ? ORDER BY created_at", (batch_id,)
            ).fetchall()
        return [self._relation_to_dict(row) for row in rows]

    # Generic project configuration
    def list_configs(self, kind: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as db:
            if kind:
                rows = db.execute(
                    "SELECT * FROM configs WHERE kind = ? ORDER BY updated_at DESC", (kind,)
                ).fetchall()
            else:
                rows = db.execute("SELECT * FROM configs ORDER BY updated_at DESC").fetchall()
        return [self._config_to_dict(row) for row in rows]

    def save_config(self, data: dict[str, Any]) -> dict[str, Any]:
        config_id = data.get("id") or new_id("config")
        timestamp = now_ms()
        with self.connect() as db:
            existing = db.execute("SELECT id FROM configs WHERE id = ?", (config_id,)).fetchone()
            if existing:
                db.execute(
                    "UPDATE configs SET name=?, config_json=?, enabled=?, updated_at=? WHERE id=?",
                    (
                        data["name"],
                        _json(data.get("config") or {}),
                        int(bool(data.get("enabled", True))),
                        timestamp,
                        config_id,
                    ),
                )
            else:
                db.execute(
                    """
                    INSERT INTO configs(id, kind, name, config_json, enabled, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        config_id,
                        data["kind"],
                        data["name"],
                        _json(data.get("config") or {}),
                        int(bool(data.get("enabled", True))),
                        timestamp,
                        timestamp,
                    ),
                )
        return next(item for item in self.list_configs(data["kind"]) if item["id"] == config_id)

    def delete_config(self, config_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM configs WHERE id = ?", (config_id,))

    @staticmethod
    def _config_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "kind": row["kind"],
            "name": row["name"],
            "config": _load_json(row["config_json"], {}),
            "enabled": bool(row["enabled"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    # Debug actions, imports, external spans, MCP, replay, tickets
    def save_debug_action(self, data: dict[str, Any]) -> dict[str, Any]:
        action_id = data.get("id") or new_id("action")
        timestamp = now_ms()
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO debug_actions(
                    id, type, preview_json, before_json, after_json, status,
                    config_version, idempotency_key, result_json, created_at, applied_at, restored_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status, result_json=excluded.result_json,
                    applied_at=excluded.applied_at, restored_at=excluded.restored_at
                """,
                (
                    action_id,
                    data["type"],
                    _json(data.get("preview") or {}),
                    _json(data.get("before") or {}),
                    _json(data.get("after") or {}),
                    data.get("status", "preview"),
                    data.get("configVersion"),
                    data.get("idempotencyKey"),
                    _json(data.get("result") or {}),
                    timestamp,
                    data.get("appliedAt"),
                    data.get("restoredAt"),
                ),
            )
        return self.get_debug_action(action_id)

    def get_debug_action(self, action_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM debug_actions WHERE id = ?", (action_id,)).fetchone()
        if row is None:
            raise ValueError("调试操作不存在")
        return {
            "id": row["id"],
            "type": row["type"],
            "preview": _load_json(row["preview_json"], {}),
            "before": _load_json(row["before_json"], {}),
            "after": _load_json(row["after_json"], {}),
            "status": row["status"],
            "configVersion": row["config_version"],
            "idempotencyKey": row["idempotency_key"],
            "result": _load_json(row["result_json"], {}),
            "createdAt": row["created_at"],
            "appliedAt": row["applied_at"],
            "restoredAt": row["restored_at"],
        }

    def list_debug_actions(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT id FROM debug_actions ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 500)),)
            ).fetchall()
        return [self.get_debug_action(row["id"]) for row in rows]

    def save_import(self, kind: str, source: str | None, summary: dict[str, Any]) -> dict[str, Any]:
        import_id = new_id("import")
        created_at = now_ms()
        with self.connect() as db:
            db.execute(
                "INSERT INTO imports(id, kind, source, summary_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (import_id, kind, source, _json(summary), created_at),
            )
        return {"id": import_id, "kind": kind, "source": source, "summary": summary, "createdAt": created_at}

    def list_imports(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM imports ORDER BY created_at DESC").fetchall()
        return [
            {
                "id": row["id"],
                "kind": row["kind"],
                "source": row["source"],
                "summary": _load_json(row["summary_json"], {}),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def save_spans(self, import_id: str | None, spans: list[dict[str, Any]]) -> int:
        with self.connect() as db:
            for span in spans:
                db.execute(
                    """
                    INSERT OR REPLACE INTO external_spans(
                        id, import_id, trace_id, span_id, parent_span_id, service_name, name,
                        start_ns, end_ns, links_json, attributes_json, sampled, raw_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_id("span"),
                        import_id,
                        span["traceId"],
                        span["spanId"],
                        span.get("parentSpanId"),
                        span.get("serviceName"),
                        span.get("name"),
                        span.get("startNs"),
                        span.get("endNs"),
                        _json(span.get("links") or []),
                        _json(span.get("attributes") or {}),
                        int(bool(span.get("sampled", True))),
                        _json(span.get("raw") or {}),
                        now_ms(),
                    ),
                )
        return len(spans)

    def list_spans(self, trace_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM external_spans WHERE trace_id = ? ORDER BY start_ns", (trace_id,)
            ).fetchall()
        return [
            {
                "id": row["id"],
                "traceId": row["trace_id"],
                "spanId": row["span_id"],
                "parentSpanId": row["parent_span_id"],
                "serviceName": row["service_name"],
                "name": row["name"],
                "startNs": row["start_ns"],
                "endNs": row["end_ns"],
                "links": _load_json(row["links_json"], []),
                "attributes": _load_json(row["attributes_json"], {}),
                "sampled": bool(row["sampled"]),
                "spanKind": _load_json(row["raw_json"], {}).get("kind"),
            }
            for row in rows
        ]

    def save_mcp_server(self, data: dict[str, Any]) -> dict[str, Any]:
        server_id = data.get("id") or new_id("mcp")
        timestamp = now_ms()
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO mcp_servers(id, name, endpoint, allowed_tools_json, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, endpoint=excluded.endpoint,
                    allowed_tools_json=excluded.allowed_tools_json, enabled=excluded.enabled, updated_at=excluded.updated_at
                """,
                (
                    server_id,
                    data["name"],
                    data["endpoint"],
                    _json(data.get("allowedTools") or []),
                    int(bool(data.get("enabled", True))),
                    timestamp,
                    timestamp,
                ),
            )
        return next(item for item in self.list_mcp_servers() if item["id"] == server_id)

    def list_mcp_servers(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM mcp_servers ORDER BY created_at").fetchall()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "endpoint": row["endpoint"],
                "allowedTools": _load_json(row["allowed_tools_json"], []),
                "enabled": bool(row["enabled"]),
            }
            for row in rows
        ]

    def save_replay_action(self, request_id: str, batch_id: str | None, data: dict[str, Any]) -> dict[str, Any]:
        action_id = data.get("id") or new_id("replay")
        timestamp = now_ms()
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO replay_actions(
                    id, request_id, batch_id, status, request_json, response_json,
                    idempotency_key, created_at, finished_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status=excluded.status,
                    response_json=excluded.response_json, finished_at=excluded.finished_at
                """,
                (
                    action_id,
                    request_id,
                    batch_id,
                    data.get("status", "preview"),
                    _json(data.get("request") or {}),
                    _json(data.get("response") or {}),
                    data.get("idempotencyKey"),
                    timestamp,
                    data.get("finishedAt"),
                ),
            )
        return self.get_replay_action(action_id)

    def get_replay_action(self, action_id: str, *, internal: bool = False) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM replay_actions WHERE id = ?", (action_id,)).fetchone()
        if row is None:
            raise ValueError("重放记录不存在")
        request = _load_json(row["request_json"], {})
        if not internal:
            request = {key: value for key, value in request.items() if not key.startswith("_")}
        return {
            "id": row["id"],
            "requestId": row["request_id"],
            "batchId": row["batch_id"],
            "status": row["status"],
            "request": request,
            "response": _load_json(row["response_json"], {}),
            "idempotencyKey": row["idempotency_key"],
            "createdAt": row["created_at"],
            "finishedAt": row["finished_at"],
        }

    def claim_replay_action(self, action_id: str) -> bool:
        with self.connect() as db:
            cursor = db.execute(
                "UPDATE replay_actions SET status = 'sending' WHERE id = ? AND status = 'preview'",
                (action_id,),
            )
            return cursor.rowcount == 1

    def claim_debug_action(self, action_id: str, expected_status: str, claimed_status: str) -> bool:
        if expected_status not in ("preview", "applied") or claimed_status not in ("applying", "restoring"):
            raise ValueError("无效的调试操作状态转换")
        with self.connect() as db:
            cursor = db.execute(
                "UPDATE debug_actions SET status = ? WHERE id = ? AND status = ?",
                (claimed_status, action_id, expected_status),
            )
            return cursor.rowcount == 1

    def save_ticket(self, data: dict[str, Any]) -> dict[str, Any]:
        ticket_id = data.get("id") or new_id("ticket")
        timestamp = now_ms()
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO tickets(id, report_id, provider, status, payload_json, result_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status=excluded.status, result_json=excluded.result_json, updated_at=excluded.updated_at
                """,
                (
                    ticket_id,
                    data.get("reportId"),
                    data.get("provider", "webhook"),
                    data.get("status", "preview"),
                    _json(data.get("payload") or {}),
                    _json(data.get("result") or {}),
                    timestamp,
                    timestamp,
                ),
            )
        with self.connect() as db:
            row = db.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        return {
            "id": row["id"],
            "reportId": row["report_id"],
            "provider": row["provider"],
            "status": row["status"],
            "payload": _load_json(row["payload_json"], {}),
            "result": _load_json(row["result_json"], {}),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def get_ticket(self, ticket_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if row is None:
            raise ValueError("工单记录不存在")
        return {
            "id": row["id"],
            "reportId": row["report_id"],
            "provider": row["provider"],
            "status": row["status"],
            "payload": _load_json(row["payload_json"], {}),
            "result": _load_json(row["result_json"], {}),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def claim_ticket(self, ticket_id: str) -> bool:
        with self.connect() as db:
            cursor = db.execute(
                "UPDATE tickets SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'preview'",
                (now_ms(), ticket_id),
            )
            return cursor.rowcount == 1

    def clear_all(self, scope: str = "analysis") -> None:
        if scope not in ("analysis", "project"):
            raise ValueError("清理范围必须为 analysis/project")
        for batch in self.list_batches():
            self.clear_batch(batch["id"], delete_reports=True)
        with self.connect() as db:
            for table in (
                "run_events",
                "analysis_scope_requests",
                "evidence",
                "run_messages",
                "analysis_runs",
                "messages",
                "reports",
                "scenario_requests",
                "scenarios",
                "relations",
                "imports",
                "external_spans",
                "replay_actions",
                "compose_jobs",
                "tickets",
                "debug_actions",
                "batches",
                "session_files",
                "sessions",
            ):
                db.execute(f"DELETE FROM {table}")
            db.execute("DELETE FROM settings WHERE key LIKE 'file-grant:%'")
            db.execute("DELETE FROM settings WHERE key LIKE 'agent-submission:%'")
            db.execute("DELETE FROM settings WHERE key LIKE 'agent-context:%'")
            db.execute("DELETE FROM settings WHERE key LIKE 'replay-job:%'")
            db.execute("DELETE FROM configs WHERE kind LIKE 'qa_%' OR kind = 'evidence_package'")
            if scope == "project":
                db.execute("DELETE FROM configs")
                db.execute("DELETE FROM mcp_servers")
                db.execute("DELETE FROM rules")
                db.execute("DELETE FROM settings WHERE key NOT IN ('redaction_salt', 'listen_port') AND key NOT LIKE 'provider-cache:%'")
        for path in (self.data_dir / "generated-mocks").glob("*"):
            if path.is_file():
                path.unlink()
        self.create_batch("首次抓包")
        if not self.list_sessions():
            self.create_session("开始调试")

    # Providers and settings
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
                "cachePolicy": self.get_setting(f"provider-cache:{row['id']}", "auto"),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]

    def save_provider(self, data: dict[str, Any]) -> dict[str, Any]:
        provider_id = data.get("id") or new_id("provider")
        policy = data.get("cachePolicy", "auto")
        if policy not in {"auto", "enabled", "off"}:
            raise ValueError("缓存策略必须为 auto/enabled/off")
        if data.get("protocol") not in {"openai-responses", "openai-chat", "anthropic"}:
            raise ValueError("不支持的供应商协议")
        from urllib.parse import urlsplit
        parsed = urlsplit(str(data.get("baseUrl", "")))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Base URL 需要有效的 http(s) 地址，不能包含用户名或密钥")
        if not str(data.get("name", "")).strip() or not str(data.get("model", "")).strip():
            raise ValueError("请填写供应商名称和模型ID")
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
            db.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (f"provider-cache:{provider_id}", policy))
        return next(item for item in self.list_providers() if item["id"] == provider_id)

    def delete_provider(self, provider_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
            db.execute("DELETE FROM settings WHERE key = ?", (f"provider-cache:{provider_id}",))

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
        with self.connect() as db:
            request_count = db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
            report_count = db.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
            run_count = db.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0]
        return {
            "dataDir": str(self.data_dir),
            "size": total,
            "requestCount": request_count,
            "reportCount": report_count,
            "runCount": run_count,
            "schemaVersion": int(self.get_setting("schema_version", str(SCHEMA_VERSION)) or SCHEMA_VERSION),
        }
