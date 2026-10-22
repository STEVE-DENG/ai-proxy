from __future__ import annotations

import asyncio
import time


class RateGate:
    def __init__(self, direction: str) -> None:
        self.direction = direction
        self.enabled = False
        self.rate = 0
        self._tokens = 0.0
        self._last = time.monotonic()
        self._lock = asyncio.Lock()
        self._limit_wait = 0.25

    def configure(self, *, enabled: bool, kb_per_second: int) -> None:
        self.enabled = enabled
        self.rate = max(0, kb_per_second) * 1000
        self._tokens = min(self._tokens, self.rate * self._limit_wait if self.rate else 0)
        self._last = time.monotonic()

    async def consume(self, size: int) -> None:
        remaining = max(0, size)
        while remaining:
            async with self._lock:
                if not self.enabled or self.rate <= 0:
                    return
                now = time.monotonic()
                capacity = self.rate * self._limit_wait
                self._tokens = min(capacity, self._tokens + (now - self._last) * self.rate)
                self._last = now
                take = min(remaining, int(self._tokens))
                if take > 0:
                    self._tokens -= take
                    remaining -= take
                    continue
                wait = min(self._limit_wait, max(0.001, (1 - self._tokens) / self.rate))
            await asyncio.sleep(wait)


class Throttle:
    def __init__(self) -> None:
        self.enabled = False
        self.up_kb = 0
        self.down_kb = 0
        self.latency_ms = 0
        self.up = RateGate("up")
        self.down = RateGate("down")

    def update(self, enabled: bool, up_kb: int, down_kb: int, latency_ms: int) -> dict:
        self.enabled = enabled
        self.up_kb = max(0, int(up_kb))
        self.down_kb = max(0, int(down_kb))
        self.latency_ms = max(0, min(30000, int(latency_ms)))
        self.up.configure(enabled=enabled, kb_per_second=self.up_kb)
        self.down.configure(enabled=enabled, kb_per_second=self.down_kb)
        return self.status()

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "upKbPerSecond": self.up_kb,
            "downKbPerSecond": self.down_kb,
            "latencyMs": self.latency_ms,
        }
