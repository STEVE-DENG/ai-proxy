import { Select } from "./Select";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  Database,
  FileJson2,
  FolderOpen,
  KeyRound,
  Laptop,
  LoaderCircle,
  Plus,
  RefreshCw,
  Router,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Batch,
  CaptureStatus,
  CertificateInfo,
  LocalProxyStatus,
  Provider,
  Rule,
  RuleAction,
  RulePart,
  RulePhase,
  RuleType,
  ThrottleStatus,
} from "../types";
import {
  confirmAction,
  call,
  clearProjectData,
  enableLocalProxy,
  credentialStatus,
  revealCredential,
  localProxyStatus,
  pickLocalFile,
  restoreLocalProxy,
} from "../lib/api";
import { formatBytes, ruleLabel } from "../lib/format";
import { CaptureTimeoutPanel, StorageHealthPanel } from "./ExperiencePanels";
import { OperationCenter } from "./OperationFeedback";
import { attachFocusLayer } from "../lib/focus";

interface DialogProps {
  open: boolean;
  title: string;
  kicker?: string;
  wide?: boolean;
  keepMounted?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function Dialog({ open, title, kicker, wide, keepMounted, onClose, children }: DialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const element = dialogRef.current;
    if (!element) return;
    return attachFocusLayer(element, () => onCloseRef.current(), () => true, element.parentElement || undefined);
  }, [open]);
  if (!open && !keepMounted) return null;
  return (
    <div className="modal-backdrop" style={open ? undefined : {display: "none"}} aria-hidden={!open} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="modal-head">
          <div>
            {kicker && <span className="eyebrow">{kicker}</span>}
            <h2>{title}</h2>
          </div>
          <button className="icon-action" aria-label="关闭对话框" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
        <div className="modal-operations"><OperationCenter active={open} /></div>
      </section>
    </div>
  );
}

export interface RuleDraft {
  type: RuleType;
  source: string;
}

interface RulesDialogProps {
  open: boolean;
  rules: Rule[];
  draft: RuleDraft | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

const emptyForm = {
  source: "",
  target: "",
  filePath: "",
  phase: "request" as RulePhase,
  part: "header" as RulePart,
  action: "set" as RuleAction,
  headerName: "",
  headerValue: "",
  search: "",
  replace: "",
};

export function RulesDialog({ open, rules, draft, onClose, onChanged }: RulesDialogProps) {
  const [tab, setTab] = useState<RuleType>("local");
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const type = draft?.type ?? "local";
    setTab(type);
    setEditId(null);
    setForm({ ...emptyForm, source: draft?.source ?? "" });
    setError(null);
  }, [open, draft]);

  const visible = rules.filter((rule) => rule.type === tab);

  const edit = (rule: Rule) => {
    setEditId(rule.id);
    setTab(rule.type);
    setForm({
      source: rule.source,
      target: rule.target || "",
      filePath: rule.filePath || "",
      phase: rule.phase || "request",
      part: rule.part || "header",
      action: rule.action || "set",
      headerName: rule.headerName || "",
      headerValue: rule.headerValue || "",
      search: rule.search || "",
      replace: rule.replace || "",
    });
    setError(null);
  };

  const pickFile = async () => {
    const path = await pickLocalFile();
    if (path) setForm((value) => ({ ...value, filePath: path }));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("rules.save", {
        id: editId || undefined,
        type: tab,
        enabled: true,
        source: form.source,
        target: tab === "remote" ? form.target : undefined,
        filePath: tab === "local" ? form.filePath : undefined,
        phase: tab === "rewrite" ? form.phase : undefined,
        part: tab === "rewrite" ? form.part : undefined,
        action: tab === "rewrite" ? form.action : undefined,
        headerName: tab === "rewrite" && form.part === "header" ? form.headerName : undefined,
        headerValue: tab === "rewrite" && form.part === "header" ? form.headerValue : undefined,
        search: tab === "rewrite" && form.part === "body" ? form.search : undefined,
        replace: tab === "rewrite" && form.part === "body" ? form.replace : undefined,
      });
      setEditId(null);
      setForm({ ...emptyForm, source: draft?.source ?? "" });
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: Rule) => {
    await call("rules.save", { ...rule, id: rule.id, enabled: !rule.enabled });
    await onChanged();
  };

  const remove = async (rule: Rule) => {
    await call("rules.delete", { ruleId: rule.id });
    await onChanged();
  };

  const move = async (rule: Rule, direction: number) => {
    const index = rules.findIndex((item) => item.id === rule.id);
    const next = [...rules];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await call("rules.reorder", { ids: next.map((item) => item.id) });
    await onChanged();
  };

  return (
    <Dialog open={open} title="规则工作台" kicker="映射与改写" wide onClose={onClose}>
      <div className="rules-layout">
        <aside className="rules-list-pane">
          <div className="segmented">
            {(["local", "remote", "rewrite"] as RuleType[]).map((type) => (
              <button key={type} className={tab === type ? "active" : ""} onClick={() => { setTab(type); setEditId(null); setForm({ ...emptyForm, source: draft?.source ?? "" }); }}>
                {type === "local" ? "Local" : type === "remote" ? "Remote" : "内容改写"}
              </button>
            ))}
          </div>
          <div className="rule-list">
            {visible.length === 0 ? <div className="empty-detail">还没有 {ruleLabel(tab)} 规则</div> : visible.map((rule) => (
              <div className={`rule-row ${rule.enabled ? "" : "disabled"}`} key={rule.id}>
                <button className="rule-main" onClick={() => edit(rule)}>
                  <span className="rule-source">{rule.source}</span>
                  <span className="rule-target">
                    {rule.type === "local" && (rule.filePath?.split("/").pop() || "未选文件")}
                    {rule.type === "remote" && rule.target}
                    {rule.type === "rewrite" && `${rule.phase} · ${rule.part} · ${rule.action}`}
                  </span>
                </button>
                <button className="rule-toggle" title={rule.enabled ? "停用" : "启用"} onClick={() => void toggle(rule)}>{rule.enabled ? <Check size={13} /> : <X size={13} />}</button>
                <button className="rule-icon" title="上移" onClick={() => void move(rule, -1)}><ArrowUp size={12} /></button>
                <button className="rule-icon" title="下移" onClick={() => void move(rule, 1)}><ArrowDown size={12} /></button>
                <button className="rule-icon danger" title="删除" onClick={() => void remove(rule)}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </aside>

        <div className="rule-editor">
          <div className="editor-head">
            <div>
              <span className="eyebrow">{editId ? "编辑规则" : "新建规则"}</span>
              <h3>{ruleLabel(tab)}</h3>
            </div>
            {editId && <button className="button ghost compact" onClick={() => { setEditId(null); setForm({ ...emptyForm, source: draft?.source ?? "" }); }}><Plus size={13} /> 新建</button>}
          </div>
          <label className="field"><span>来源 URL</span><input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="https://api.example.com/v1/*" /><small>完整 URL 精确匹配；只在末尾使用 * 做前缀匹配。</small></label>
          {tab === "local" && (
            <div className="field"><span>本地文件</span><div className="input-with-button"><input value={form.filePath} onChange={(event) => setForm({ ...form, filePath: event.target.value })} placeholder="选择一个本地文件" /><button className="button ghost compact" onClick={() => void pickFile()}><FolderOpen size={14} /> 选择</button></div></div>
          )}
          {tab === "remote" && (
            <label className="field"><span>目标 URL</span><input value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} placeholder="http://127.0.0.1:3000/v1/" /></label>
          )}
          {tab === "rewrite" && (
            <>
              <div className="form-grid two">
                <label className="field"><span>阶段</span><Select value={form.phase} onChange={(event) => setForm({ ...form, phase: event.target.value as RulePhase })}><option value="request">请求</option><option value="response">响应</option></Select></label>
                <label className="field"><span>位置</span><Select value={form.part} onChange={(event) => setForm({ ...form, part: event.target.value as RulePart })}><option value="header">请求头</option><option value="body">正文</option></Select></label>
              </div>
              {form.part === "header" ? (
                <>
                  <div className="form-grid two">
                    <label className="field"><span>Header 名称</span><input value={form.headerName} onChange={(event) => setForm({ ...form, headerName: event.target.value })} placeholder="Authorization" /></label>
                    <label className="field"><span>操作</span><Select value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value as RuleAction })}><option value="set">设置</option><option value="delete">删除</option></Select></label>
                  </div>
                  {form.action === "set" && <label className="field"><span>Header 值</span><input value={form.headerValue} onChange={(event) => setForm({ ...form, headerValue: event.target.value })} placeholder="Bearer ..." /></label>}
                </>
              ) : (
                <div className="form-grid two">
                  <label className="field"><span>查找文本</span><textarea value={form.search} onChange={(event) => setForm({ ...form, search: event.target.value })} /></label>
                  <label className="field"><span>替换为</span><textarea value={form.replace} onChange={(event) => setForm({ ...form, replace: event.target.value })} /></label>
                </div>
              )}
            </>
          )}
          <div className="rule-order-note"><CircleHelp size={13} /> 规则按列表顺序执行。Map 同类只命中第一条；Rewrite 按顺序逐条执行。</div>
          {error && <div className="inline-error">{error}</div>}
          <div className="modal-footer">
            <button className="button ghost" onClick={onClose}>取消</button>
            <button className="button primary" disabled={busy || !form.source || (tab === "remote" && !form.target) || (tab === "local" && !form.filePath)} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} 保存规则</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

interface ThrottleDialogProps {
  open: boolean;
  value: ThrottleStatus;
  onClose: () => void;
  onSave: (value: ThrottleStatus) => Promise<void>;
}

const PRESETS = [
  { label: "不限速", up: 0, down: 0, latency: 0 },
  { label: "4G", up: 750, down: 4000, latency: 80 },
  { label: "3G", up: 200, down: 750, latency: 200 },
  { label: "弱 Wi-Fi", up: 80, down: 250, latency: 500 },
];

export function ThrottleDialog({ open, value, onClose, onSave }: ThrottleDialogProps) {
  const [state, setState] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setState(value); }, [open, value]);
  const save = async () => {
    setBusy(true);
    try {
      await onSave(state);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} title="代理弱网" kicker="网络条件模拟" onClose={onClose}>
      <div className="preset-row">{PRESETS.map((preset) => (
        <button
          className={`preset ${state.upKbPerSecond === preset.up && state.downKbPerSecond === preset.down && state.latencyMs === preset.latency ? "active" : ""}`}
          key={preset.label}
          onClick={() => setState({ ...state, enabled: preset.label !== "不限速", upKbPerSecond: preset.up, downKbPerSecond: preset.down, latencyMs: preset.latency })}
        >
          <span>{preset.label}</span><small>{preset.down ? `${preset.down} KB/s` : "原始速度"}</small>
        </button>
      ))}</div>
      <div className="form-grid three">
        <label className="field"><span>上行 KB/s</span><input type="number" min={0} value={state.upKbPerSecond} onChange={(event) => setState({ ...state, upKbPerSecond: Number(event.target.value) })} /><small>0 表示不限速</small></label>
        <label className="field"><span>下行 KB/s</span><input type="number" min={0} value={state.downKbPerSecond} onChange={(event) => setState({ ...state, downKbPerSecond: Number(event.target.value) })} /><small>所有连接共享</small></label>
        <label className="field"><span>额外延迟 ms</span><input type="number" min={0} value={state.latencyMs} onChange={(event) => setState({ ...state, latencyMs: Number(event.target.value) })} /><small>每个请求发送前</small></label>
      </div>
      <label className="switch-row"><div><b>启用代理弱网</b><span>仅影响经过本代理的流量，不是系统网卡限速。</span></div><input type="checkbox" checked={state.enabled} onChange={(event) => setState({ ...state, enabled: event.target.checked })} /></label>
      <div className="modal-footer"><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" onClick={() => void save()} disabled={busy}><WifiOff size={14} /> 应用</button></div>
    </Dialog>
  );
}

interface PhoneDialogProps {
  open: boolean;
  capture: CaptureStatus;
  certificate: CertificateInfo;
  onClose: () => void;
  onLan: (enabled: boolean) => Promise<void>;
  onHttps: (enabled: boolean) => Promise<void>;
  onEnable: () => Promise<void>;
}

interface ConnectionCheck {
  pairing: { token: string; expiresAt: number; expired?: boolean; direct: {address: string; at: number} | null; http: {address: string; at: number} | null; https: {address: string; at: number} | null } | null;
  devices: Array<{address: string; permission: string; remembered: boolean; lastSeen: number; connections: number}>;
  listener: CaptureStatus & {selectedAddressMissing?: boolean};
  checkedAt: number;
}

export function PhoneDialog({ open, capture, certificate, onClose, onLan, onHttps, onEnable }: PhoneDialogProps) {
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [platform, setPlatform] = useState("ios");
  const [polling, setPolling] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!open) return;
    let last = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now - last > 15_000) { setCheck(null); void call<ConnectionCheck>("connections.status").then(setCheck).catch(reason => setError(String(reason))); }
      last = now;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open]);
  const status = check?.listener ?? capture;
  const pairing = check?.pairing;
  const ready = status.running && status.lan && status.listenerReady !== false && status.engineReady !== false;
  const activePair = pairing && !pairing.expired && pairing.expiresAt > clock;
  const target = ready && status.certDirectUrl && activePair ? `${status.certDirectUrl}?pair=${encodeURIComponent(pairing.token)}` : "";
  const refresh = async () => setCheck(await call<ConnectionCheck>("connections.status"));
  useEffect(() => {
    if (!open) return;
    let live = true;
    void call<ConnectionCheck>("connections.status").then(value => { if (live) setCheck(value); }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [open, capture.running, capture.lan]);
  useEffect(() => {
    let live = true;
    setQr("");
    if (target) void QRCode.toDataURL(target, { width: 240, margin: 1 }).then(value => { if (live) setQr(value); }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [target]);
  useEffect(() => {
    if (!open || !polling) return;
    let live = true;
    let timer: number;
    const until = Math.min(Date.now() + 120_000, pairing?.expiresAt ?? Date.now() + 120_000);
    const poll = async () => {
      try { const value = await call<ConnectionCheck>("connections.status"); if (live) setCheck(value); }
      catch (reason) { if (live) setError(String(reason)); }
      if (live && Date.now() < until) timer = window.setTimeout(() => void poll(), 2000);
      else if (live) setPolling(false);
    };
    void poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [open, polling, pairing?.token]);
  const act = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await operation(); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const pair = () => act(async () => { await call("connections.pair"); setPolling(true); });
  const verified = (value: {at: number; address: string} | null | undefined) => activePair && value ? `已验证 · ${value.address} · ${new Date(value.at).toLocaleTimeString()}` : "尚未验证";
  return <Dialog open={open} title="连接手机与诊断" kicker="局域网抓包" wide onClose={onClose}>
    {error && <div className="error-banner" role="alert">{error}<button className="button ghost compact" onClick={() => void act(refresh)}>重新检查</button></div>}
    <div className="phone-layout">
      <div className="phone-visual">
        <h3>1. Mac 开启局域网代理</h3>
        <p>手机和 Mac 使用同一网络。此模式不会修改 Mac 系统代理；先验证 HTTP，再按需开启 HTTPS。</p>
        <label className="field"><span>Mac 网络地址</span><Select value={status.localIp} disabled={busy} onChange={event => void act(() => call("connections.address", {address: event.target.value}))}>
          {(status.localIps || []).map(item => <option key={`${item.name}:${item.address}`} value={item.address}>{item.name} · {item.address}</option>)}
        </Select></label>
        {status.selectedAddressMissing && <p role="alert">先前地址已失效，请重新选择网卡并生成二维码。</p>}
        <div className="address-card"><span>手机 Wi-Fi 手动代理</span><strong>{status.localIp}:{status.port}</strong><button className="button ghost compact" onClick={() => void navigator.clipboard.writeText(`${status.localIp}:${status.port}`).catch(reason => setError(String(reason)))}>复制地址与端口</button></div>
        <button className="button primary" disabled={busy} onClick={() => void act(onEnable)}>{busy ? "处理中…" : ready ? "重新检查本机" : "开启局域网 HTTP 代理"}</button>
        <label className="switch-row compact"><div><b>允许局域网连接</b><span>新地址需在下方允许后才能转发。</span></div><input type="checkbox" disabled={busy} checked={status.lan} onChange={event => void act(() => onLan(event.target.checked))} /></label>
        <label className="switch-row compact"><div><b>可选：解密 HTTPS</b><span>先安装并信任当前项目 CA；影响经过代理的新连接。</span></div><input type="checkbox" disabled={busy} checked={status.decryptHosts.includes("*")} onChange={event => void act(() => onHttps(event.target.checked))} /></label>
        <h3>分层诊断</h3>
        <ol className="connection-evidence">
          <li>Mac 监听：{!status.running ? "尚未启动" : status.listenerReady === false ? "端口未监听，请重新启动或检查端口占用" : status.engineReady === false ? "抓包内核未运行，请查看引擎错误" : !status.lan ? "仅监听本机，请开启局域网" : `本机已就绪 · ${new Date(check?.checkedAt || Date.now()).toLocaleTimeString()}`}</li>
          <li>手机直达引导页：{verified(pairing?.direct)}</li>
          <li>HTTP 确实经过代理：{verified(pairing?.http)}</li>
          <li>HTTPS 实际解密：{verified(pairing?.https)}</li>
          <li>目标 App：回抓包页操作目标 App，核对真实请求；浏览器通过不代表 App 通过。</li>
        </ol>
        <button className="button ghost compact" onClick={() => polling ? setPolling(false) : setPolling(true)}>{polling ? "暂停自动检查" : "检查连接（最多2分钟）"}</button>
        {status.lastTlsError && <p className="error-banner">已观察 TLS 错误：{status.lastTlsError}。可能与信任或证书固定有关，请核对目标 App。</p>}
      </div>
      <div className="phone-guide">
        <h3>2. 手机扫码并设置代理</h3>
        <p>在 Mac 允许手机地址后，在引导页点击 HTTP 验证。未出现访问证据时，检查 IP、Wi-Fi 与代理设置；VPN、访客网络隔离或防火墙需进一步核实。</p>
        <button className="button primary" disabled={!ready || busy} onClick={() => void pair()}>{activePair ? "重新生成配对二维码" : "生成10分钟配对二维码"}</button>
        {qr && <div className="qr-wrap"><img src={qr} alt="手机接入与连接验证二维码" /><div><code>{target}</code><p>二维码绑定首个访问地址；仅代表网络来源，不能识别物理设备。</p><button className="button ghost compact" onClick={() => void navigator.clipboard.writeText(target).catch(reason => setError(String(reason)))}>复制引导地址</button></div></div>}
        <h3>3. 按需安装与验证 HTTPS</h3>
        <label className="field"><span>设备系统</span><Select value={platform} onChange={event => setPlatform(event.target.value)}><option value="ios">iPhone / iPad</option><option value="android">Android</option></Select></label>
        <p>{platform === "ios" ? "引导页安装描述文件，再到 设置 → 通用 → 关于本机 → 证书信任设置 开启完全信任。" : "引导页下载 CA，在系统的安装证书入口安装。Android 7+ 正式 App 可能不信任用户 CA。"}</p>
        <p>开启解密后，点击手机引导页的 HTTPS 验证。下载证书不代表已信任；只有实际解密的挑战请求才标记通过。</p>
        <details><summary>当前项目 CA 与移除说明</summary><p>切换项目可能使用不同 CA；在设备证书管理中核对并手动移除不再使用的 CA。</p><code>{certificate.path}</code><p>SHA-256：{certificate.fingerprint || "CA 尚未生成"}</p></details>
        <h3>访问地址与授权</h3>
        {!check?.devices.length && <p>尚未收到手机访问。扫码或设置代理后发起 HTTP 请求，再查看待授权地址。</p>}
        {check?.devices.map(device => <div className="connection-device" key={device.address}>
          <b>{device.address}</b><span>{device.permission === "allowed" ? "允许" : device.permission === "denied" ? "已拒绝" : "等待授权"}{device.remembered ? "（记住地址）" : ""} · 最近活动 {new Date(device.lastSeen).toLocaleTimeString()} · 连接尝试 {device.connections}</span>
          <div className="qa-actions">{[["once", "本次允许"], ["remember", "记住地址"], ["deny", "拒绝 / 撤销"]].map(([action, label]) => <button key={action} className="button ghost compact" disabled={busy} onClick={() => void act(() => call("connections.grant", {address: device.address, action}))}>{label}</button>)}</div>
        </div>)}
        <p className="boundary-note">记住地址不等于设备当前在线；同一 IP 可能被其它设备复用。抓包结束后关闭手机 Wi-Fi 代理，否则手机可能无法联网。</p>
      </div>
    </div>
  </Dialog>;
}

interface SettingsDialogProps {
  open: boolean;
  initialTab?: "providers" | "capture" | "cert" | "storage";
  providers: Provider[];
  selectedProviderId: string;
  onProvider: (id: string) => void;
  onProvidersChanged: () => Promise<void>;
  listenPort: number;
  onPortSaved: () => Promise<void>;
  capture: CaptureStatus;
  certificate: CertificateInfo;
  storage: { dataDir: string; size: number };
  onRefreshStorage: () => Promise<void>;
  onClose: () => void;
}

type ProviderForm = Pick<Provider, "name" | "protocol" | "baseUrl" | "model" | "cachePolicy"> & { id?: string; apiKey: string; reuseFrom?: string };

export function SettingsDialog({
  open,
  initialTab = "providers",
  providers,
  selectedProviderId,
  onProvider,
  onProvidersChanged,
  listenPort,
  onPortSaved,
  capture,
  certificate,
  storage,
  onRefreshStorage,
  onClose,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<"providers" | "capture" | "cert" | "storage">("providers");
  const [form, setForm] = useState<ProviderForm>({ name: "", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "", apiKey: "" });
  const [editing, setEditing] = useState(false);
  const [testState, setTestState] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [port, setPort] = useState(listenPort);
  const [hostProxy, setHostProxy] = useState<LocalProxyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState("尚未检查");
  const [revealedKey, setRevealedKey] = useState("");
  const [showInputKey, setShowInputKey] = useState(false);
  const revealDetailsOpen = useRef(false), revealGeneration = useRef(0);
  const revealView = useRef({ open, id: form.id }); revealView.current = { open, id: form.id };
  useEffect(() => { revealGeneration.current++; setRevealedKey(""); setShowInputKey(false); }, [open, form.id, form.reuseFrom, editing, tab]);
  useEffect(() => {
    if (!open) return;
    const hide = () => { revealGeneration.current++; setRevealedKey(""); setShowInputKey(false); };
    const timer = window.setTimeout(hide, 30000);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearTimeout(timer); window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", hide); };
  }, [open, revealedKey, showInputKey]);
  const revealSavedKey = async () => {
    if (revealedKey) { setRevealedKey(""); return; }
    const id = form.id, version = revealGeneration.current;
    if (!id || !beginOperation()) return;
    const valid = () => revealDetailsOpen.current && revealGeneration.current === version && revealView.current.open && revealView.current.id === id && editingAccount.current === id && !document.hidden && document.hasFocus();
    try { const key = await revealCredential(id); if (valid()) setRevealedKey(key); }
    catch (reason) { if (valid()) { revealGeneration.current++; setMessage(String(reason)); } }
    finally { endOperation(); }
  };
  const [replaceKey, setReplaceKey] = useState(false);
  const [available, setAvailable] = useState<Array<Provider & {projectName: string}>>([]);
  const editingAccount = useRef<string | null>(null);
  const operationBusy = useRef(false);
  const beginOperation = () => {
    if (operationBusy.current) return false;
    operationBusy.current = true; setBusy(true); return true;
  };
  const endOperation = () => { operationBusy.current = false; setBusy(false); };
  const performSetting = async (operation: () => Promise<unknown>) => {
    if (!beginOperation()) return;
    setMessage(null);
    try { await operation(); }
    catch (reason) { setMessage(String(reason)); }
    finally { endOperation(); }
  };

  useEffect(() => {
    if (!open) return;
    setPort(listenPort);
    setMessage(null);
    setTab(initialTab);
    void localProxyStatus().then(setHostProxy).catch(() => setHostProxy(null));
  }, [open, listenPort, initialTab]);

  const beginNew = () => {
    editingAccount.current = null;
    setEditing(true);
    setReplaceKey(true);
    setForm({ name: "", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "", apiKey: "" });
    setTestState("idle");
    setCredential("新供应商；本机无密钥服务可留空");
    setMessage(null);
  };

  const beginEdit = async (provider: Provider) => {
    editingAccount.current = provider.id;
    setEditing(true);
    setTestState("idle");
    setMessage(null);
    setForm({ ...provider, apiKey: "" });
    setCredential("检查中…");
    setReplaceKey(false);
    try {
      const status = await credentialStatus(provider.id);
      if (editingAccount.current !== provider.id) return;
      setReplaceKey(!status.saved);
      setCredential(status.saved ? "已保存在本机，无需系统授权" : "未保存本地凭据，请重新录入一次（不会访问钥匙串）");
    } catch (reason) { if (editingAccount.current === provider.id) setCredential(String(reason)); }
  };

  const officialBase = (protocol: ProviderForm["protocol"]) => {
    if (protocol === "anthropic") return "https://api.anthropic.com";
    return "https://api.openai.com/v1";
  };

  const saveProvider = async () => {
    setRevealedKey("");
    if (!form.name.trim() || !form.model.trim() || !/^https?:\/\//.test(form.baseUrl)) { setMessage("请填写名称、模型 ID 和有效的 http(s) Base URL。"); return; }
    if (!beginOperation()) return;
    setMessage(null);
    try {
      const provider = await call<Provider>("providers.save", {
        id: form.id || crypto.randomUUID(),
        name: form.name,
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        model: form.model.trim(),
        cachePolicy: form.cachePolicy || "auto",
        ...(form.reuseFrom ? { reuseFrom: form.reuseFrom } : {}),
        ...((!form.reuseFrom && (!form.id || replaceKey)) || form.apiKey ? { apiKey: form.apiKey } : {}),
      });
      setForm({ ...provider, apiKey: "" });
      onProvider(provider.id);
      setEditing(false);
      await onProvidersChanged();
      setMessage("供应商已保存。密钥保存在本机凭据文件，重启无需重新输入。");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      endOperation();
    }
  };

  const testProvider = async (tools = false) => {
    if (!form.id) {
      setMessage("请先保存供应商，再检查连接。");
      return;
    }
    if (form.apiKey) { setMessage("请先保存更换后的密钥，再检查连接。"); return; }
    if (!await confirmAction(tools ? "检查模型是否能调用合成工具？会向供应商发送最多3次简短请求并可能收费，不发送抓包正文或执行业务动作。" : "向该供应商发送一次简短连接请求？可能产生少量模型费用；不会发送抓包正文。")) return;
    if (!beginOperation()) return;
    setTestState("running");
    setMessage(null);
    try {
      await call(tools ? "providers.capabilities" : "providers.test", { providerId: form.id });
      setTestState("ok");
      setMessage(tools ? "连接与合成工具调用通过；完整调查仍需真实样本验收。" : "基础连接通过；尚未验证工具调用。检查请求可能产生少量模型费用。");
    } catch (reason) {
      setTestState("error");
      setMessage(String(reason));
    } finally { endOperation(); }
  };

  const removeProvider = async (provider: { id: string }) => {
    if (!await confirmAction("删除此供应商配置及本地密钥？已有调查记录保留。")) return;
    if (!beginOperation()) return;
    try {
      await call("providers.delete", { providerId: provider.id });
      setEditing(false);
      await onProvidersChanged();
    } catch (reason) { setMessage(String(reason)); }
    finally { endOperation(); }
  };

  const toggleProxy = async () => {
    if (!beginOperation()) return;
    setMessage(null);
    try {
      const result = hostProxy?.active ? await restoreLocalProxy() : await enableLocalProxy(capture.port);
      setHostProxy(result);
    } catch (reason) {
      setMessage(String(reason));
      setHostProxy(await localProxyStatus().catch(() => null));
    } finally {
      endOperation();
    }
  };

  return (
    <Dialog open={open} title="设置" kicker="应用配置" wide onClose={onClose}>
      <div className="settings-layout">
        <nav className="settings-nav">
          <button className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}><KeyRound size={15} /> 供应商</button>
          <button className={tab === "capture" ? "active" : ""} onClick={() => setTab("capture")}><Router size={15} /> 抓包与代理</button>
          <button className={tab === "cert" ? "active" : ""} onClick={() => setTab("cert")}><ShieldCheck size={15} /> 证书</button>
          <button className={tab === "storage" ? "active" : ""} onClick={() => setTab("storage")}><Database size={15} /> 存储</button>
        </nav>

        <fieldset className="settings-content task-fields" disabled={busy}>
          {tab === "providers" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">模型供应商</span><h3>供应商</h3></div><button className="button primary compact" onClick={beginNew}><Plus size={14} /> 添加</button></div>
              <div className="provider-list">
                {providers.length === 0 ? <div className="empty-detail">尚未配置供应商。抓包功能不需要供应商即可使用。</div> : providers.map((provider) => (
                  <button className={`provider-row ${selectedProviderId === provider.id ? "active" : ""}`} key={provider.id} onClick={() => { onProvider(provider.id); void beginEdit(provider); }}>
                    <span className="provider-icon">{provider.protocol === "anthropic" ? "A" : "O"}</span>
                    <span className="provider-info"><b>{provider.name}</b><small>{provider.model} · {provider.protocol.replace("openai-", "")}</small></span>
                    {selectedProviderId === provider.id && <span className="current-pill">当前</span>}
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
              <button className="button ghost compact" disabled={busy} onClick={() => void call<Array<Provider & {projectName: string}>>("providers.available").then(items => { setAvailable(items); if (!items.length) setMessage("其它项目暂无可复用的供应商配置。"); }).catch(reason => setMessage(String(reason)))}>从其它项目复用已保存账户</button>
              {available.map(item => <button key={item.id} className="provider-row" disabled={busy} onClick={() => { editingAccount.current = null; setTestState("idle"); setMessage(null); setForm({ name: item.name, protocol: item.protocol, baseUrl: item.baseUrl, model: item.model, apiKey: "", reuseFrom: item.id }); setReplaceKey(false); setEditing(true); setCredential(`将从 ${item.projectName} 复制账户凭据；业务数据不共享，保存后可独立更换密钥`); }}>{item.projectName} · {item.name} · {item.model}</button>)}
              {editing && (
                <div className="provider-editor">
                  <div className="form-grid two">
                    <label className="field"><span>显示名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="OpenAI" /></label>
                    <label className="field"><span>协议</span><Select value={form.protocol} onChange={(event) => { const protocol = event.target.value as ProviderForm["protocol"]; setForm({ ...form, protocol, baseUrl: officialBase(protocol) }); }}><option value="openai-responses">OpenAI Responses</option><option value="openai-chat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></Select></label>
                  </div>
                  <label className="field"><span>服务基础地址</span><input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder={officialBase(form.protocol)} /></label>
                  <div className="form-grid two">
                    <label className="field"><span>模型 ID</span><input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="手动填写供应商模型名" /></label>
                    <label className="field"><span>接口密钥</span><input type={showInputKey ? "text" : "password"} value={form.apiKey} autoComplete="new-password" onChange={(event) => { setReplaceKey(true); setForm({ ...form, apiKey: event.target.value }); }} placeholder={form.id ? "留空保持已保存的 Key" : "本机服务可留空"} /><button type="button" className="button ghost compact" onClick={() => setShowInputKey(value => !value)}>{showInputKey ? "隐藏输入" : "显示输入"}</button></label>
                  </div>
                  {form.id && <label className="switch-row compact"><div><b>替换或清空已保存的密钥</b><span>开启后保存空值可用于本机无密钥服务；关闭且留空时保留原密钥。</span></div><input type="checkbox" checked={replaceKey} onChange={event => setReplaceKey(event.target.checked)} /></label>}
                  <label className="field"><span>供应商缓存策略</span><Select value={form.cachePolicy || "auto"} onChange={event => setForm({ ...form, cachePolicy: event.target.value as Provider["cachePolicy"] })}><option value="auto">自动（官方端点启用，兼容端点不发扩展）</option><option value="enabled">显式启用（确认兼容端点支持）</option><option value="off">不发送缓存扩展参数</option></Select><small>不支持缓存参数时选择关闭。不会在失败后自动重复请求模型。</small></label>
                  <p className="settings-note" role="status">{credential}。已存密钥仅在主动查看时临时显示，30秒或切出窗口后隐藏；文件未加密，同一用户进程可读取。</p>
                  {form.id && <details className="credential-details" onToggle={event => { revealDetailsOpen.current = event.currentTarget.open; if (!event.currentTarget.open) { revealGeneration.current++; setRevealedKey(""); } }}><summary>已保存账户与密钥详情</summary><p>{form.name} · {form.protocol} · {form.model}</p><code>{form.baseUrl}</code><p><button className="button ghost compact" disabled={busy} onClick={() => void revealSavedKey()}>{revealedKey ? "隐藏已保存密钥" : "显示已保存密钥"}</button></p>{revealedKey && <code className="credential-secret">{revealedKey}</code>}<small>只显示在当前页面，不复制到剪贴板、不写入表单或模型上下文。</small></details>}
                  <div className="settings-actions">
                    {form.id && <button className="button ghost danger-hover" onClick={() => void removeProvider({ id: form.id! })}><Trash2 size={13} /> 删除</button>}
                    <span className="spacer" />
                    <button className="button ghost" onClick={() => void testProvider()} disabled={busy || testState === "running"}>{testState === "running" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} 检查连接</button>
                    <button className="button ghost" disabled={busy || testState === "running"} onClick={() => void testProvider(true)}>检查工具调用</button>
                    <button className="button primary" onClick={() => void saveProvider()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} 保存</button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "capture" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">代理监听</span><h3>抓包与代理</h3></div></div>
              <CaptureTimeoutPanel capture={capture} onChanged={onPortSaved} />
              <div className="settings-card">
                <div className="settings-card-row"><div><b>监听端口</b><span>{capture.running ? "请先停止代理，再修改监听端口。" : "修改后会在下次启动抓包时生效。"}</span></div><div className="inline-edit"><input type="number" disabled={capture.running} value={port} onChange={(event) => setPort(Number(event.target.value))} /><button className="button ghost compact" disabled={capture.running} onClick={() => void performSetting(async () => { await call("app.set-port", { port }); setMessage("监听端口已有保存回执，正在刷新状态。"); await onPortSaved(); setMessage("监听端口已保存。"); })}>保存</button></div></div>
                <div className="settings-card-row"><div><b>本机系统代理</b><span>{hostProxy?.service ? `${hostProxy.service} · ${hostProxy.active ? "已指向本应用" : "当前未启用"}` : "读取网络服务失败"}</span></div><button className="button ghost compact" disabled={busy || !capture.running} onClick={() => void toggleProxy()}>{hostProxy?.active ? <X size={13} /> : <ShieldCheck size={13} />} {hostProxy?.active ? "恢复原代理" : "挂到本机"}</button></div>
                <div className="settings-card-row"><div><b>局域网访问</b><span>{capture.lan ? `已开启 · ${capture.localIp}:${capture.port}` : "关闭时仅监听 127.0.0.1"}</span></div><span className={`status-pill ${capture.lan ? "active" : ""}`}>{capture.lan ? "LAN ON" : "LOCAL ONLY"}</span></div>
              </div>
              <div className="settings-note"><WifiOff size={14} /><span>暂停记录不会断开代理。系统代理需要管理员授权，拒绝授权不会改变本机设置。</span></div>
            </>
          )}

          {tab === "cert" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">证书信任</span><h3>证书</h3></div></div>
              <div className="cert-card"><ShieldCheck size={24} /><div><b>{certificate.exists ? "本机 CA 已生成" : "启动代理后生成 CA"}</b><code>{certificate.path}</code><span>手机访问 {certificate.url} 安装。HTTPS 可由抓包页或连接手机页一键开启；设备必须信任 CA。</span></div></div>
              <div className="settings-note"><Smartphone size={14} /><span>iOS 安装后还需要在证书信任设置中手动开启完全信任。不要把 CA 私钥发给其他人。</span></div>
            </>
          )}

          {tab === "storage" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">本地数据</span><h3>存储</h3></div></div>
              <StorageHealthPanel />
              <div className="settings-card">
                <div className="settings-card-row"><div><b>数据目录</b><span className="path-line">{storage.dataDir}</span></div><b className="mono">{formatBytes(storage.size)}</b></div>
                <div className="settings-card-row"><div><b>清理分析数据</b><span>停止采集与 Agent，删除抓包、会话、文件授权、报告、QA 记录及导入；保留规则、环境和账户配置。</span></div><button className="button ghost danger-hover" onClick={async () => { if (!await confirmAction("确认清理当前项目分析数据？会停止采集和 Agent，已有报告也会删除。")) return; await performSetting(async () => { await clearProjectData("analysis"); window.location.reload(); }); }}><Trash2 size={13} /> 清理</button></div>
                <div className="settings-card-row"><div><b>重置当前项目</b><span>另删除规则、环境、契约和连接配置。供应商账户与本地凭据保留；其他项目不受影响。</span></div><button className="button ghost danger-hover" onClick={async () => { if (!await confirmAction("确认重置当前项目全部业务数据与配置？其他项目和本地凭据不受影响。")) return; await performSetting(async () => { await clearProjectData("project"); window.location.reload(); }); }}>重置项目</button></div>
              </div>
            </>
          )}
          {message && <div className={`settings-message ${/失败|错误|请先/.test(message) ? "error" : ""}`}>{message}</div>}
        </fieldset>
      </div>
    </Dialog>
  );
}
