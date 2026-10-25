import { useEffect, useRef, useState } from "react";
import { call } from "../lib/api";
import type { CaptureStatus } from "../types";
interface Device { address: string; permission: string; remembered: boolean; lastSeen: number; connections: number }
interface Proof { address: string; at: number }
interface ConnectionState { lifecycleNotice?: string; devices: Device[]; pairing?: {expiresAt: number; expired?: boolean; direct: Proof | null; http: Proof | null; https: Proof | null} | null }
export function DeviceStatusBar({ capture, onGuide }: { capture: CaptureStatus; onGuide: () => void }) {
  const [state, setState] = useState<ConnectionState>({devices: []});
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false), [now, setNow] = useState(Date.now());
  const guard = useRef(false), sequence = useRef(0), alive = useRef(true);
  const identity = `${capture.running}:${capture.lan}:${capture.port}:${capture.localIp}`;
  const current = useRef(identity); current.current = identity;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; };
  }, []);
  useEffect(() => {
    let live = true, loading = false, lastTick = Date.now();
    const refresh = async () => {
      const stamp = Date.now();
      if (stamp-lastTick > 15000 || stamp < lastTick) { sequence.current++; setState(value => ({...value, pairing: null})); setError("检测到睡眠或调度暂停，正在重新核对监听与证据"); }
      lastTick = stamp;
      if (loading || guard.current || document.hidden) return;
      loading = true; const version = ++sequence.current;
      try { const value = await call<ConnectionState>("connections.status"); if (live && sequence.current === version) { setState(value); setError(""); setNow(Date.now()); } }
      catch (reason) { if (live && sequence.current === version) setError(String(reason)); }
      finally { loading = false; }
    };
    setState({devices: []}); setError(""); sequence.current++;
    if (!capture.running || !capture.lan) return;
    void refresh(); const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 5000);
    const focus = () => void refresh(); document.addEventListener("visibilitychange", focus);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", focus); };
  }, [identity]);
  const grant = async (address: string, action: string) => {
    if (guard.current) return;
    guard.current = true; setWorking(true); const target = current.current, version = ++sequence.current;
    const valid = () => alive.current && current.current === target && sequence.current === version;
    try { const value = await call<ConnectionState>("connections.grant", { address, action }); if (valid()) { setState(value); setError(""); setNow(Date.now()); } }
    catch (reason) { if (valid()) setError(String(reason)); }
    finally { guard.current = false; if (alive.current) setWorking(false); }
  };
  const devices = state.devices;
  const pair = state.pairing && !state.pairing.expired && state.pairing.expiresAt > now && !error ? state.pairing : null;
  const proofLabel = (layer: "direct" | "http" | "https", address?: string) => {
    const proof = pair?.[layer];
    return proof && (!address || proof.address === address) ? "已验证" : "尚未验证";
  };
  const pending = devices.filter(device => device.permission === "pending").length;
  return <details className="device-status-bar">
    <summary>手机代理 · {capture.running && capture.lan ? `${capture.localIp}:${capture.port} · ${devices.length} 个来源 · ${pending} 待授权 · ${devices.filter(device => device.permission === "allowed").length} 允许 · HTTP ${proofLabel("http")} / HTTPS ${proofLabel("https")}${state.pairing && !pair ? "（证据已过期或不可用）" : ""}` : "局域网监听未开启"}{error ? " · 状态读取失败" : ""}</summary>
    <div className="device-status-content">
      <button className="button ghost compact" onClick={onGuide}>连接手机与分层诊断</button>
      <p>来源IP及许可每5秒刷新；最近活动不代表在线，IP不是设备身份。验证仅属于当前配对浏览器及其来源地址，不代表目标App通过。</p>
      {state.lifecycleNotice && <p role="status">{state.lifecycleNotice}</p>}
      {pair && <p>配对证据有效至 {new Date(pair.expiresAt).toLocaleTimeString()} · 直达 {proofLabel("direct")} · HTTP {proofLabel("http")} · HTTPS解密 {proofLabel("https")}</p>}
      {!devices.length && <p>暂无来源地址。开启局域网监听、配置手机Wi-Fi代理后发起请求。</p>}
      {devices.map(device => <div className="connection-device" key={device.address}>
        <b>{device.address}</b><span>{device.permission === "allowed" ? "允许" : device.permission === "denied" ? "已拒绝" : "等待授权"}{device.remembered ? "（记住）" : ""} · 最近活动 {new Date(device.lastSeen).toLocaleTimeString()} · 尝试 {device.connections} 次</span>
        <small>直达 {proofLabel("direct", device.address)} · HTTP {proofLabel("http", device.address)} · HTTPS解密 {proofLabel("https", device.address)}</small>
        <div className="qa-actions">{[["once", "本次允许"], ["remember", "记住地址"], ["deny", "拒绝 / 撤销"]].map(([action, label]) => <button disabled={working} className="button ghost compact" key={action} onClick={() => void grant(device.address, action)}>{label}</button>)}</div>
      </div>)}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
