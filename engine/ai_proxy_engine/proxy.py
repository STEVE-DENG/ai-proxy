from __future__ import annotations

import asyncio
import contextlib
import hashlib
import html
import logging
import mimetypes
import plistlib
import socket
import ssl
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from mitmproxy import http, options
from mitmproxy.addons import proxyserver
from mitmproxy.tools import dump

from .rules import apply_map_local, apply_map_remote, apply_rewrite, first_rule
from .store import Store, new_id, now_ms
from .throttle import Throttle

logger = logging.getLogger(__name__)


class ProxyAddon:
    def __init__(
        self,
        store: Store,
        throttle: Throttle,
        emit: Callable[[str, dict[str, Any]], None],
    ) -> None:
        self.store = store
        self.throttle = throttle
        self.emit = emit
        self.recording = True
        self.rules: list[dict[str, Any]] = store.list_rules()
        self.decrypt_hosts: set[str] = set()
        self.client_ports: dict[int, str] = {}
        self.request_count = 0
        self.last_tls_error: str | None = None

    def refresh_rules(self) -> None:
        self.rules = self.store.list_rules()

    def add_decrypt_host(self, host: str) -> None:
        self.decrypt_hosts.add(host.lower().lstrip("."))

    def remove_decrypt_host(self, host: str) -> None:
        self.decrypt_hosts.discard(host.lower().lstrip("."))

    def _should_decrypt(self, host: str | None) -> bool:
        if not host:
            return False
        host = host.lower()
        if "*" in self.decrypt_hosts:
            return True
        if host in self.decrypt_hosts:
            return True
        return any(
            pattern.startswith("*.")
            and host.endswith(pattern[1:])
            and host.count(".") == pattern.count(".")
            for pattern in self.decrypt_hosts
        )

    def tls_clienthello(self, data) -> None:
        host = (data.client_hello.sni or "").lower()
        if not self._should_decrypt(host):
            data.ignore_connection = True

    def _prepare_flow(self, flow: http.HTTPFlow) -> None:
        if "ai_proxy_id" in flow.metadata:
            return
        request = flow.request
        flow.metadata["ai_proxy_id"] = new_id("req")
        flow.metadata["ai_proxy_started"] = now_ms()
        if request.method == "CONNECT":
            port = request.port or 443
            authority = request.host if port == 443 else f"{request.host}:{port}"
            flow.metadata["ai_proxy_original_url"] = f"https://{authority}/"
        else:
            flow.metadata["ai_proxy_original_url"] = request.pretty_url

    def http_connect(self, flow: http.HTTPFlow) -> None:
        if self._should_decrypt(flow.request.host):
            return
        self._prepare_flow(flow)
        self._record(flow)

    async def request(self, flow: http.HTTPFlow) -> None:
        self._prepare_flow(flow)
        host = (flow.request.host or "").lower()
        if self.throttle.enabled and self.throttle.latency_ms:
            await asyncio.sleep(self.throttle.latency_ms / 1000)
        if flow.request.method == "CONNECT":
            return
        try:
            applied = apply_rewrite(
                self.rules,
                flow.metadata["ai_proxy_original_url"],
                "request",
                flow.request,
            )
            matched_local = apply_map_local(flow, self.rules)
            if matched_local:
                flow.metadata["ai_proxy_matched_rule"] = matched_local
            else:
                matched_remote = apply_map_remote(flow, self.rules)
                if matched_remote:
                    flow.metadata["ai_proxy_matched_rule"] = matched_remote
                    flow.metadata["ai_proxy_actual_url"] = flow.request.pretty_url
            if applied:
                flow.metadata["ai_proxy_rewrites"] = applied
        except Exception as error:
            flow.metadata["ai_proxy_rule_error"] = str(error)
            logger.warning("Rule error for %s: %s", flow.request.pretty_url, error)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        if not flow.response:
            return
        content_type = flow.response.headers.get("content-type", "").lower()
        length = flow.response.headers.get("content-length")
        too_large = False
        if length:
            try:
                too_large = int(length) > 5 * 1024 * 1024
            except ValueError:
                too_large = False
        if "text/event-stream" in content_type or too_large:
            flow.response.stream = True
            flow.metadata["ai_proxy_streamed"] = True

    def response(self, flow: http.HTTPFlow) -> None:
        if not flow.response:
            return
        try:
            applied = apply_rewrite(
                self.rules,
                flow.metadata.get("ai_proxy_original_url", flow.request.pretty_url),
                "response",
                flow.response,
            )
            if applied:
                flow.metadata.setdefault("ai_proxy_rewrites", []).extend(applied)
        except Exception as error:
            flow.metadata["ai_proxy_rule_error"] = str(error)
            logger.warning("Response rewrite error: %s", error)
        self._record(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        if flow.error:
            flow.metadata["ai_proxy_error"] = f"{flow.error.msg}: {flow.error.detail or ''}".strip()
            if "tls" in flow.metadata["ai_proxy_error"].lower() or "certificate" in flow.metadata["ai_proxy_error"].lower():
                self.last_tls_error = flow.metadata["ai_proxy_error"]
                flow.metadata["ai_proxy_tls_error"] = self.last_tls_error
                self.emit(
                    "capture:tls-error",
                    {
                        "host": flow.request.host,
                        "message": self.last_tls_error,
                        "url": flow.request.pretty_url,
                    },
                )
        self._prepare_flow(flow)
        self._record(flow)

    def _record(self, flow: http.HTTPFlow) -> None:
        if flow.metadata.get("ai_proxy_recorded") or not self.recording:
            return
        flow.metadata["ai_proxy_recorded"] = True
        batch = self.store.get_current_batch()
        started = flow.metadata.get("ai_proxy_started", now_ms())
        request = flow.request
        response = flow.response
        original_url = flow.metadata.get("ai_proxy_original_url", request.pretty_url)
        original_parts = urlsplit(original_url)
        original_host = (original_parts.hostname or request.host or "").lower()
        original_scheme = original_parts.scheme or request.scheme
        original_port = original_parts.port or (
            443 if original_scheme == "https" else 80
        )
        original_path = (original_parts.path or "/") + (
            f"?{original_parts.query}" if original_parts.query else ""
        )
        client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else "127.0.0.1"
        if client_ip in ("127.0.0.1", "::1") and flow.client_conn.peername:
            client_ip = self.client_ports.get(flow.client_conn.peername[1], client_ip)
        request_body = None
        response_body = None
        if not flow.metadata.get("ai_proxy_streamed"):
            request_body = request.get_content() if request.content else None
            response_body = response.get_content() if response and response.content else None
        self.request_count += 1
        request_id = flow.metadata["ai_proxy_id"]
        status = response.status_code if response else None
        content_type = (
            response.headers.get("content-type")
            if response
            else request.headers.get("content-type")
        )
        self.store.save_request(
            {
                "id": request_id,
                "batch_id": batch["id"],
                "sequence": self.request_count,
                "method": request.method,
                "scheme": original_scheme,
                "host": original_host,
                "port": original_port,
                "path": original_path,
                "url": original_url,
                "status": status,
                "content_type": content_type,
                "started_at": started,
                "duration_ms": max(0, now_ms() - started),
                "size": len(response.raw_content or b"") if response and response.raw_content else 0,
                "source_ip": client_ip,
                "encrypted": int(request.method == "CONNECT"),
                "tls_error": flow.metadata.get("ai_proxy_tls_error"),
                "matched_rule": flow.metadata.get("ai_proxy_matched_rule"),
                "actual_url": flow.metadata.get("ai_proxy_actual_url"),
                "rule_error": flow.metadata.get("ai_proxy_rule_error"),
                "request_headers": list(request.headers.items(multi=True)),
                "response_headers": list(response.headers.items(multi=True)) if response else [],
                "request_body": request_body,
                "response_body": response_body,
                "error": flow.metadata.get("ai_proxy_error"),
            }
        )
        summary = self.store.request_summary(request_id)
        self.emit("capture:request", summary)


class ProxyManager:
    def __init__(
        self,
        store: Store,
        throttle: Throttle,
        emit: Callable[[str, dict[str, Any]], None],
        cert_dir: Path,
    ) -> None:
        self.store = store
        self.throttle = throttle
        self.emit = emit
        self.cert_dir = cert_dir
        self.cert_dir.mkdir(parents=True, exist_ok=True)
        self.addon = ProxyAddon(store, throttle, emit)
        self.master: dump.DumpMaster | None = None
        self.master_task: asyncio.Task | None = None
        self.server: asyncio.AbstractServer | None = None
        self.cert_server: asyncio.AbstractServer | None = None
        self.cert_port = 0
        self.port = 8080
        self.lan = False
        self.internal_port = 0
        self.running = False
        self.paused = False
        self.started_at: int | None = None
        self._server_lock = asyncio.Lock()

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    async def start(self, port: int = 8080, lan: bool = False) -> dict[str, Any]:
        if self.running:
            return self.status()
        self.port = int(port)
        self.lan = bool(lan)
        self.internal_port = self._free_port()
        opts = options.Options(
            listen_host="127.0.0.1",
            listen_port=self.internal_port,
            confdir=str(self.cert_dir),
            mode=["regular"],
            http2=True,
        )
        try:
            self.master = dump.DumpMaster(
                opts,
                loop=asyncio.get_running_loop(),
                with_termlog=False,
                with_dumper=False,
            )
            # These options are registered by default addons during DumpMaster construction.
            opts.connection_strategy = "lazy"
            opts.stream_large_bodies = "5m"
            self.master.addons.add(self.addon)
            self.master_task = asyncio.create_task(self.master.run(), name="mitmproxy")
            await asyncio.sleep(0.25)
            if self.master_task.done():
                error = self.master_task.exception()
                raise RuntimeError(f"抓包内核启动失败: {error}")
            await self._start_server()
            await self._start_cert_server()
        except Exception:
            await self.stop()
            raise
        self.running = True
        self.started_at = now_ms()
        self.emit("capture:status", self.status())
        return self.status()

    async def _start_server(self) -> None:
        async with self._server_lock:
            if self.server:
                self.server.close()
                await self.server.wait_closed()
            host = "0.0.0.0" if self.lan else "127.0.0.1"
            self.server = await asyncio.start_server(
                self._handle_connection,
                host,
                self.port,
                reuse_address=True,
            )

    async def _start_cert_server(self) -> None:
        if self.cert_server:
            self.cert_server.close()
            await self.cert_server.wait_closed()
        self.cert_server = await asyncio.start_server(
            self._handle_cert_http,
            "0.0.0.0" if self.lan else "127.0.0.1",
            0,
        )
        sockets = self.cert_server.sockets or []
        self.cert_port = sockets[0].getsockname()[1] if sockets else 0

    async def _handle_cert_http(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5)
            target = (
                request_line.decode("latin1", errors="replace").split(" ")[1]
                if request_line
                else "/"
            )
            path = urlsplit(target).path
            cert_path = self.cert_dir / "mitmproxy-ca-cert.pem"
            cert_pem = cert_path.read_bytes() if cert_path.exists() else b""
            cert_der = (
                ssl.PEM_cert_to_DER_cert(cert_pem.decode("ascii")) if cert_pem else b""
            )
            if path == "/ai-proxy.mobileconfig" and cert_der:
                body = self._build_apple_profile(cert_der)
                headers = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/x-apple-aspen-config\r\n"
                    'Content-Disposition: attachment; filename="AI Proxy CA.mobileconfig"\r\n'
                    f"Content-Length: {len(body)}\r\n"
                    "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
                ).encode()
            elif path in ("/ca.crt", "/ca.cer") and cert_der:
                body = cert_der
                headers = (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/x-x509-ca-cert\r\n"
                    'Content-Disposition: attachment; filename="AI Proxy CA.crt"\r\n'
                    f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
            elif path == "/ca.pem" and cert_pem:
                body = cert_pem
                headers = (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/x-pem-file\r\n"
                    'Content-Disposition: attachment; filename="AI Proxy CA.pem"\r\n'
                    f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
            else:
                peer_name = writer.get_extra_info("sockname")
                proxy_host = peer_name[0] if peer_name else get_local_ip()
                guide = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Proxy 手机 HTTPS</title>
<style>body{{font:16px/1.65 -apple-system,BlinkMacSystemFont,sans-serif;max-width:38rem;margin:7vh auto;padding:0 22px;color:#17231e;background:#eee9dd}}h1{{font-size:30px;margin-bottom:6px}}h2{{font-size:17px;margin:26px 0 8px}}p,li{{color:#4e544f}}a{{display:inline-block;background:#315e4a;color:#fff;padding:11px 16px;border-radius:8px;text-decoration:none;margin:5px 5px 5px 0}}a.secondary{{background:#fff;color:#315e4a;border:1px solid #b9c7bd}}code{{background:#fff;padding:3px 6px;border-radius:4px}}.proxy{{padding:14px;background:#e2ddd0;border-radius:9px}}.note{{border-top:1px solid #ccc;margin-top:26px;padding-top:16px;color:#6f695e;font-size:14px}}</style>
<h1>AI Proxy 手机 HTTPS</h1><p>只在你信任的 Wi-Fi 下使用。抓包内容可能包含账号和隐私数据。</p>
<div class="proxy"><b>Wi-Fi 手动代理</b><br>服务器：<code>{html.escape(proxy_host)}</code>　端口：<code>{self.port}</code></div>
<h2>1. 安装根证书</h2>
<p><a href="/ai-proxy.mobileconfig">iPhone / iPad 安装描述文件</a><a class="secondary" href="/ca.crt">Android 下载 CA 证书</a></p>
<p><b>iOS / iPadOS</b>：安装后进入「设置 → 通用 → 关于本机 → 证书信任设置」，打开 AI Proxy 根证书的完全信任。</p>
<p><b>Android</b>：在系统设置中安装 CA 证书。Android 7+ 的正式 App 可能不信任用户 CA，启用证书固定的 App 无法抓取明文。</p>
<h2>2. 设置 Wi-Fi 代理</h2>
<p>在手机当前 Wi-Fi 的「配置代理」中选择「手动」，服务器和端口填写上方地址，然后重新打开要抓取的 App。</p>
<h2>3. 验证</h2>
<p>回到 AI Proxy 的抓包页，确认 HTTPS 解密处于开启状态。手机访问网页后应出现对应的 HTTPS Host 和请求明细。</p>
<div class="note">抓包完成后请关闭手机 Wi-Fi 代理，否则关闭电脑或 AI Proxy 后手机可能无法联网。</div></html>""".encode()
                headers = (
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    f"Content-Length: {len(guide)}\r\nCache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
                body = guide
            writer.write(headers + body)
            await writer.drain()
        except (TimeoutError, ConnectionError, OSError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    @staticmethod
    def _build_apple_profile(cert_der: bytes) -> bytes:
        fingerprint = hashlib.sha256(cert_der).hexdigest()
        ca_uuid = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"ai-proxy-root-ca:{fingerprint}")
        ).upper()
        profile_uuid = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"ai-proxy-mobile-profile:{fingerprint}")
        ).upper()
        profile = {
            "PayloadContent": [
                {
                    "PayloadCertificateFileName": "AI Proxy CA.cer",
                    "PayloadContent": cert_der,
                    "PayloadDescription": "用于 AI Proxy HTTPS 调试的本地根证书",
                    "PayloadDisplayName": "AI Proxy Root CA",
                    "PayloadIdentifier": "com.nekoya.ai-proxy.root-ca",
                    "PayloadType": "com.apple.security.root",
                    "PayloadUUID": ca_uuid,
                    "PayloadVersion": 1,
                }
            ],
            "PayloadDescription": "安装 CA 后还需在证书信任设置中开启完全信任",
            "PayloadDisplayName": "AI Proxy 手机 HTTPS",
            "PayloadIdentifier": "com.nekoya.ai-proxy.mobile-profile",
            "PayloadOrganization": "Nekoya",
            "PayloadRemovalDisallowed": False,
            "PayloadType": "Configuration",
            "PayloadUUID": profile_uuid,
            "PayloadVersion": 1,
        }
        return plistlib.dumps(profile, fmt=plistlib.FMT_XML, sort_keys=False)

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        upstream_writer: asyncio.StreamWriter | None = None
        upstream_port: int | None = None
        try:
            peer = writer.get_extra_info("peername")
            client_ip = peer[0] if peer else "127.0.0.1"
            upstream_reader, upstream_writer = await asyncio.open_connection(
                "127.0.0.1", self.internal_port
            )
            sockname = upstream_writer.get_extra_info("sockname")
            if sockname:
                upstream_port = sockname[1]
                self.addon.client_ports[upstream_port] = client_ip
            tasks = [
                asyncio.create_task(
                    self._pipe(reader, upstream_writer, self.throttle.up)
                ),
                asyncio.create_task(
                    self._pipe(upstream_reader, writer, self.throttle.down)
                ),
            ]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except (ConnectionError, OSError) as error:
            logger.debug("Forwarding connection closed: %s", error)
        finally:
            if upstream_port is not None:
                self.addon.client_ports.pop(upstream_port, None)
            if upstream_writer:
                upstream_writer.close()
                with contextlib.suppress(Exception):
                    await upstream_writer.wait_closed()
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    @staticmethod
    async def _pipe(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        gate,
    ) -> None:
        try:
            while data := await reader.read(16 * 1024):
                await gate.consume(len(data))
                writer.write(data)
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.write_eof()

    async def set_lan(self, lan: bool) -> dict[str, Any]:
        self.lan = bool(lan)
        if self.running:
            await self._start_server()
            await self._start_cert_server()
        self.emit("capture:status", self.status())
        return self.status()

    async def stop(self) -> dict[str, Any]:
        if self.master:
            self.master.shutdown()
        if self.master_task:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.master_task, timeout=3)
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        if self.cert_server:
            self.cert_server.close()
            await self.cert_server.wait_closed()
        self.server = None
        self.cert_server = None
        self.cert_port = 0
        self.master = None
        self.master_task = None
        self.running = False
        self.started_at = None
        self.emit("capture:status", self.status())
        return self.status()

    def set_paused(self, paused: bool) -> dict[str, Any]:
        self.paused = paused
        self.addon.recording = not paused
        self.emit("capture:status", self.status())
        return self.status()

    def refresh_rules(self) -> None:
        self.addon.refresh_rules()

    def add_decrypt_host(self, host: str) -> None:
        self.addon.add_decrypt_host(host)

    def remove_decrypt_host(self, host: str) -> None:
        self.addon.remove_decrypt_host(host)

    def status(self) -> dict[str, Any]:
        local_ip = get_local_ip()
        addresses = get_network_addresses()
        selected_ip = next(
            (item["address"] for item in addresses if item["name"] == "en0"),
            addresses[0]["address"] if addresses else local_ip,
        )
        return {
            "running": self.running,
            "paused": self.paused,
            "port": self.port,
            "lan": self.lan,
            "startedAt": self.started_at,
            "requestCount": self.addon.request_count,
            "localIp": selected_ip,
            "localIps": addresses,
            "decryptHosts": sorted(self.addon.decrypt_hosts),
            "certUrl": "http://mitm.it/",
            "certPort": self.cert_port or None,
            "certDirectUrl": f"http://{selected_ip}:{self.cert_port}/" if self.cert_port else None,
            "lastTlsError": self.addon.last_tls_error,
        }


def get_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def get_network_addresses() -> list[dict[str, str]]:
    try:
        output = subprocess.run(
            ["/sbin/ifconfig"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    addresses: list[dict[str, str]] = []
    current = ""
    for line in output.splitlines():
        if line and not line.startswith((" ", "\t")):
            current = line.split(":", 1)[0]
        stripped = line.strip()
        if stripped.startswith("inet ") and current and current != "lo0":
            address = stripped.split()[1]
            if not address.startswith("127."):
                addresses.append({"name": current, "address": address})
    return addresses
