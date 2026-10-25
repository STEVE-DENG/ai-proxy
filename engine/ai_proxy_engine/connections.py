from __future__ import annotations

import ipaddress
import secrets
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .store import now_ms


class Connections:
    """Local pairing evidence and IP-scoped access grants, never a device identity."""

    def __init__(self, store) -> None:
        self.store = store
        self.devices: dict[str, dict[str, Any]] = {}
        self.pairing: dict[str, Any] | None = None
        self.writers: dict[str, set] = {}
        self._last_tick = (time.time(), time.monotonic())
        self.lifecycle_notice = ""

    def check_lifecycle(self) -> None:
        wall, mono = time.time(), time.monotonic()
        last_wall, last_mono = self._last_tick
        self._last_tick = (wall, mono)
        if wall-last_wall > 15 or (wall-last_wall)-(mono-last_mono) > 2 or wall < last_wall:
            self.invalidate("检测到睡眠、时钟变化或长时间调度暂停，已关闭旧连接；许可保留，请重新配对验证。监听状态另行读取。")

    def invalidate(self, notice: str = "配对证据已失效，请重新验证") -> None:
        self.pairing = None
        self.lifecycle_notice = notice
        for writers in list(self.writers.values()):
            for writer in list(writers):
                writer.close()
        self.writers.clear()

    def reset(self) -> None:
        for writers in list(self.writers.values()):
            for writer in list(writers):
                writer.close()
        self.writers.clear()
        self.devices.clear()
        self.pairing = None

    def start_pairing(self) -> dict[str, Any]:
        self.check_lifecycle()
        self.lifecycle_notice = ""
        self.pairing = {"token": secrets.token_urlsafe(24), "expiresAt": now_ms() + 10 * 60_000,
                        "direct": None, "http": None, "https": None}
        return self.pairing

    def valid(self, token: str) -> bool:
        return bool(self.pairing and self.pairing["expiresAt"] > now_ms()
                    and secrets.compare_digest(token, self.pairing["token"]))

    def token_from(self, target: str) -> str:
        return parse_qs(urlsplit(target).query).get("pair", [""])[0]

    def observe(self, address: str) -> dict[str, Any]:
        if address not in self.devices:
            if len(self.devices) >= 64:
                stale = next((ip for ip, item in self.devices.items() if item["permission"] != "allowed"), None)
                if stale:
                    self.devices.pop(stale)
                else:
                    raise ValueError("设备地址已达64个，请先撤销不用的地址")
            remembered = self.store.get_setting("lan_grants", "[]") or "[]"
            import json
            self.devices[address] = {"address": address, "permission": "allowed" if address in json.loads(remembered) else "pending",
                                     "remembered": address in json.loads(remembered), "lastSeen": now_ms(), "connections": 0}
        device = self.devices[address]
        device["lastSeen"] = now_ms()
        return device

    def allowed(self, address: str) -> bool:
        if ipaddress.ip_address(address).is_loopback:
            return True
        device = self.observe(address)
        device["connections"] += 1
        return device["permission"] == "allowed"

    def grant(self, address: str, action: str) -> None:
        import json
        ipaddress.ip_address(address)
        if action not in {"once", "remember", "deny"}:
            raise ValueError("请选择允许一次、记住或拒绝")
        device = self.observe(address)
        device.update(permission="denied" if action == "deny" else "allowed", remembered=action == "remember")
        remembered = set(json.loads(self.store.get_setting("lan_grants", "[]") or "[]"))
        remembered.discard(address)
        if action == "remember":
            remembered.add(address)
        self.store.set_setting("lan_grants", json.dumps(sorted(remembered)))
        if action == "deny":
            if self.pairing and any((self.pairing.get(layer) or {}).get("address") == address for layer in ("direct", "http", "https")):
                self.pairing = None
            for writer in list(self.writers.get(address, set())):
                writer.close()

    def evidence(self, layer: str, target: str, address: str) -> bool:
        token = self.token_from(target)
        if not self.valid(token):
            return False
        assert self.pairing is not None
        direct = self.pairing.get("direct")
        if layer != "direct" and (not direct or direct["address"] != address):
            return False
        if layer == "direct" and direct and direct["address"] != address:
            return False
        self.observe(address)
        self.pairing[layer] = {"address": address, "at": now_ms()}
        return True

    def snapshot(self) -> dict[str, Any]:
        self.check_lifecycle()
        pairing = self.pairing
        if pairing and pairing["expiresAt"] <= now_ms():
            pairing = {**pairing, "expired": True}
        return {"pairing": pairing, "devices": list(self.devices.values()), "lifecycleNotice": self.lifecycle_notice}
