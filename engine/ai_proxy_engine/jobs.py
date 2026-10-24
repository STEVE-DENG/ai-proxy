from __future__ import annotations

from contextvars import ContextVar
from threading import Event


CANCEL_EVENT: ContextVar[Event | None] = ContextVar("ai_proxy_cancel_event", default=None)


def check_cancelled() -> None:
    event = CANCEL_EVENT.get()
    if event is not None and event.is_set():
        raise RuntimeError("后台只读作业已取消")
