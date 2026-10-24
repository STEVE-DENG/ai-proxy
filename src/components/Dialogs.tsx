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
  deleteSecret,
  enableLocalProxy,
  getSecret,
  localProxyStatus,
  pickLocalFile,
  restoreLocalProxy,
  saveSecret,
} from "../lib/api";
import { formatBytes, ruleLabel } from "../lib/format";

interface DialogProps {
  open: boolean;
  title: string;
  kicker?: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function Dialog({ open, title, kicker, wide, onClose, children }: DialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]') || []).filter(element => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); }
      if (event.key === "Tab") {
        const targets = focusable();
        const first = targets[0], last = targets.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", listener);
    return () => { window.removeEventListener("keydown", listener); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div>
            {kicker && <span className="eyebrow">{kicker}</span>}
            <h2>{title}</h2>
          </div>
          <button className="icon-action" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
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
    <Dialog open={open} title="规则工作台" kicker="MAP & REWRITE" wide onClose={onClose}>
      <div className="rules-layout">
        <aside className="rules-list-pane">
          <div className="segmented">
            {(["local", "remote", "rewrite"] as RuleType[]).map((type) => (
              <button key={type} className={tab === type ? "active" : ""} onClick={() => { setTab(type); setEditId(null); setForm({ ...emptyForm, source: draft?.source ?? "" }); }}>
                {type === "local" ? "Local" : type === "remote" ? "Remote" : "Rewrite"}
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
              <span className="eyebrow">{editId ? "EDIT RULE" : "NEW RULE"}</span>
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
                <label className="field"><span>阶段</span><select value={form.phase} onChange={(event) => setForm({ ...form, phase: event.target.value as RulePhase })}><option value="request">请求</option><option value="response">响应</option></select></label>
                <label className="field"><span>位置</span><select value={form.part} onChange={(event) => setForm({ ...form, part: event.target.value as RulePart })}><option value="header">Header</option><option value="body">Body</option></select></label>
              </div>
              {form.part === "header" ? (
                <>
                  <div className="form-grid two">
                    <label className="field"><span>Header 名称</span><input value={form.headerName} onChange={(event) => setForm({ ...form, headerName: event.target.value })} placeholder="Authorization" /></label>
                    <label className="field"><span>操作</span><select value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value as RuleAction })}><option value="set">设置</option><option value="delete">删除</option></select></label>
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
    <Dialog open={open} title="代理弱网" kicker="NETWORK SHAPING" onClose={onClose}>
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

export function PhoneDialog({ open, capture, certificate, onClose, onLan, onHttps, onEnable }: PhoneDialogProps) {
  const [qr, setQr] = useState<string>("");
  const [enabling, setEnabling] = useState(false);
  const directTarget = capture.lan && capture.running ? capture.certDirectUrl : null;
  const target = directTarget || certificate.url;
  const decryptAll = capture.decryptHosts.includes("*");
  const ready = Boolean(directTarget) && decryptAll && certificate.exists;
  useEffect(() => {
    if (open) void QRCode.toDataURL(target, { width: 240, margin: 1, color: { dark: "#17251f", light: "#f7f3e9" } }).then(setQr);
  }, [open, target]);
  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const enable = async () => {
    setEnabling(true);
    try {
      await onEnable();
    } finally {
      setEnabling(false);
    }
  };
  return (
    <Dialog open={open} title="连接手机" kicker="LAN CAPTURE" wide onClose={onClose}>
      <div className="phone-layout">
        <div className="phone-visual">
          <div className="phone-status-line"><span className={`live-dot ${capture.running && capture.lan ? "on" : ""}`} /> {capture.running ? capture.lan ? "代理正在监听局域网" : "代理仅监听本机" : "代理尚未启动"}</div>
          <div className="address-card">
            <span>Wi-Fi 代理服务器</span>
            <strong>{capture.localIp}</strong>
            <span>端口</span>
            <strong>{capture.port}</strong>
          </div>
          <label className="switch-row compact"><div><b>允许局域网连接</b><span>仅在你信任的 Wi-Fi 下开启。</span></div><input type="checkbox" checked={capture.lan} onChange={(event) => void onLan(event.target.checked)} /></label>
          <label className="switch-row compact"><div><b>解密 HTTPS</b><span>设备信任 CA 后开启；只影响新连接。</span></div><input type="checkbox" checked={decryptAll} onChange={(event) => void onHttps(event.target.checked)} /></label>
          {!ready && <button className="button primary" onClick={() => void enable()} disabled={enabling}>{enabling ? <LoaderCircle className="spin" size={14} /> : <Wifi size={14} />} 开启手机 HTTPS 抓包</button>}
          {ready && <div className="phone-ready"><Check size={14} /><span>Mac 已准备好，下一步只需在手机安装并信任 CA。</span></div>}
        </div>
        <div className="phone-guide">
          <div className="qr-wrap">
            {qr ? <img src={qr} alt="根证书下载二维码" /> : <LoaderCircle className="spin" />}
            <div><b>{ready ? "安装手机根证书" : "先开启手机抓包"}</b><span>{ready ? "用手机浏览器扫码，iOS 选择描述文件，Android 下载 CA 证书。" : "点击左侧「开启手机 HTTPS 抓包」，再扫码打开证书页。"}</span><code>{target}</code><button className="link-button" onClick={() => copy(target)}><Copy size={12} /> 复制地址</button></div>
          </div>
          <div className="cert-warning"><ShieldCheck size={15} /><span>证书只用于本机调试。抓到的内容可能包含账号和隐私数据，请在可信网络使用。</span></div>
          <div className="platform-tabs">
            <div><span className="platform-badge">iOS</span><p>扫码 → 安装 AI Proxy 描述文件 → 到「设置 → 通用 → 关于本机 → 证书信任设置」开启完全信任。</p></div>
            <div><span className="platform-badge android">Android</span><p>扫码 → 下载 CA 证书 → 在系统设置的「安装证书」中安装。Android 7+ 的正式 App 可能不信任用户 CA。</p></div>
            <div><span className="platform-badge mac">代理</span><p>手机 Wi-Fi 的 HTTP 代理填写 {capture.localIp}:{capture.port}。抓包结束后关闭手机代理。</p></div>
          </div>
          <p className="phone-note">只看到 CONNECT 而没有请求明细时，通常是手机尚未信任 CA。重新检查证书信任设置，然后关闭并重新打开目标 App。</p>
        </div>
      </div>
    </Dialog>
  );
}

interface SettingsDialogProps {
  open: boolean;
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

type ProviderForm = Pick<Provider, "name" | "protocol" | "baseUrl" | "model"> & { id?: string; apiKey: string };

export function SettingsDialog({
  open,
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

  useEffect(() => {
    if (!open) return;
    setPort(listenPort);
    setMessage(null);
    setTab("providers");
    void localProxyStatus().then(setHostProxy).catch(() => setHostProxy(null));
  }, [open, listenPort]);

  const beginNew = () => {
    setEditing(true);
    setForm({ name: "", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "", apiKey: "" });
    setTestState("idle");
    setMessage(null);
  };

  const beginEdit = async (provider: Provider) => {
    setEditing(true);
    setTestState("idle");
    setMessage(null);
    const key = await getSecret(provider.id).catch(() => null);
    setForm({ ...provider, apiKey: key || "" });
  };

  const officialBase = (protocol: ProviderForm["protocol"]) => {
    if (protocol === "anthropic") return "https://api.anthropic.com";
    return "https://api.openai.com/v1";
  };

  const saveProvider = async () => {
    if (!form.name || !form.model || !form.baseUrl) return;
    setBusy(true);
    setMessage(null);
    try {
      const provider = await call<Provider>("providers.save", {
        id: form.id,
        name: form.name,
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        model: form.model,
      });
      if (form.apiKey) await saveSecret(provider.id, form.apiKey);
      else if (!form.id) await saveSecret(provider.id, "");
      onProvider(provider.id);
      setEditing(false);
      await onProvidersChanged();
      setMessage("供应商已保存。API Key 存放于 macOS 钥匙串。");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const testProvider = async () => {
    if (!form.id) {
      setMessage("请先保存供应商，再检查连接。");
      return;
    }
    setTestState("running");
    setMessage(null);
    try {
      const key = form.apiKey || (await getSecret(form.id)) || "";
      await call("providers.test", { providerId: form.id, apiKey: key });
      setTestState("ok");
      setMessage("连接成功。检查请求可能产生少量模型费用。");
    } catch (reason) {
      setTestState("error");
      setMessage(String(reason));
    }
  };

  const removeProvider = async (provider: { id: string }) => {
    await call("providers.delete", { providerId: provider.id });
    await deleteSecret(provider.id).catch(() => undefined);
    setEditing(false);
    await onProvidersChanged();
  };

  const toggleProxy = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = hostProxy?.active ? await restoreLocalProxy() : await enableLocalProxy(capture.port);
      setHostProxy(result);
    } catch (reason) {
      setMessage(String(reason));
      setHostProxy(await localProxyStatus().catch(() => null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="设置" kicker="AI PROXY CONFIGURATION" wide onClose={onClose}>
      <div className="settings-layout">
        <nav className="settings-nav">
          <button className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}><KeyRound size={15} /> 供应商</button>
          <button className={tab === "capture" ? "active" : ""} onClick={() => setTab("capture")}><Router size={15} /> 抓包与代理</button>
          <button className={tab === "cert" ? "active" : ""} onClick={() => setTab("cert")}><ShieldCheck size={15} /> 证书</button>
          <button className={tab === "storage" ? "active" : ""} onClick={() => setTab("storage")}><Database size={15} /> 存储</button>
        </nav>

        <div className="settings-content">
          {tab === "providers" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">MODEL PROVIDERS</span><h3>供应商</h3></div><button className="button primary compact" onClick={beginNew}><Plus size={14} /> 添加</button></div>
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
              {editing && (
                <div className="provider-editor">
                  <div className="form-grid two">
                    <label className="field"><span>显示名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="OpenAI" /></label>
                    <label className="field"><span>协议</span><select value={form.protocol} onChange={(event) => { const protocol = event.target.value as ProviderForm["protocol"]; setForm({ ...form, protocol, baseUrl: officialBase(protocol) }); }}><option value="openai-responses">OpenAI Responses</option><option value="openai-chat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>
                  </div>
                  <label className="field"><span>Base URL</span><input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder={officialBase(form.protocol)} /></label>
                  <div className="form-grid two">
                    <label className="field"><span>模型 ID</span><input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="手动填写供应商模型名" /></label>
                    <label className="field"><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={form.id ? "留空则保持钥匙串中的 Key" : "本机服务可留空"} /></label>
                  </div>
                  <div className="settings-actions">
                    {form.id && <button className="button ghost danger-hover" onClick={() => void removeProvider({ id: form.id! })}><Trash2 size={13} /> 删除</button>}
                    <span className="spacer" />
                    <button className="button ghost" onClick={() => void testProvider()} disabled={testState === "running"}>{testState === "running" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} 检查连接</button>
                    <button className="button primary" onClick={() => void saveProvider()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} 保存</button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "capture" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">PROXY LISTENER</span><h3>抓包与代理</h3></div></div>
              <div className="settings-card">
                <div className="settings-card-row"><div><b>监听端口</b><span>{capture.running ? "请先停止代理，再修改监听端口。" : "修改后会在下次启动抓包时生效。"}</span></div><div className="inline-edit"><input type="number" disabled={capture.running} value={port} onChange={(event) => setPort(Number(event.target.value))} /><button className="button ghost compact" disabled={capture.running} onClick={async () => { await call("app.set-port", { port }); await onPortSaved(); setMessage("监听端口已保存。"); }}>保存</button></div></div>
                <div className="settings-card-row"><div><b>本机系统代理</b><span>{hostProxy?.service ? `${hostProxy.service} · ${hostProxy.active ? "已指向本应用" : "当前未启用"}` : "读取网络服务失败"}</span></div><button className="button ghost compact" disabled={busy || !capture.running} onClick={() => void toggleProxy()}>{hostProxy?.active ? <X size={13} /> : <ShieldCheck size={13} />} {hostProxy?.active ? "恢复原代理" : "挂到本机"}</button></div>
                <div className="settings-card-row"><div><b>局域网访问</b><span>{capture.lan ? `已开启 · ${capture.localIp}:${capture.port}` : "关闭时仅监听 127.0.0.1"}</span></div><span className={`status-pill ${capture.lan ? "active" : ""}`}>{capture.lan ? "LAN ON" : "LOCAL ONLY"}</span></div>
              </div>
              <div className="settings-note"><WifiOff size={14} /><span>暂停记录不会断开代理。系统代理需要管理员授权，拒绝授权不会改变本机设置。</span></div>
            </>
          )}

          {tab === "cert" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">CERTIFICATE AUTHORITY</span><h3>证书</h3></div></div>
              <div className="cert-card"><ShieldCheck size={24} /><div><b>{certificate.exists ? "本机 CA 已生成" : "启动代理后生成 CA"}</b><code>{certificate.path}</code><span>手机访问 {certificate.url} 安装。HTTPS 可由抓包页或连接手机页一键开启；设备必须信任 CA。</span></div></div>
              <div className="settings-note"><Smartphone size={14} /><span>iOS 安装后还需要在证书信任设置中手动开启完全信任。不要把 CA 私钥发给其他人。</span></div>
            </>
          )}

          {tab === "storage" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">LOCAL DATA</span><h3>存储</h3></div></div>
              <div className="settings-card">
                <div className="settings-card-row"><div><b>数据目录</b><span className="path-line">{storage.dataDir}</span></div><b className="mono">{formatBytes(storage.size)}</b></div>
                <div className="settings-card-row"><div><b>清理分析数据</b><span>停止采集与 Agent，删除抓包、会话、文件授权、报告、QA 记录及导入；保留规则、环境和账户配置。</span></div><button className="button ghost danger-hover" onClick={async () => { if (!await confirmAction("确认清理当前项目分析数据？会停止采集和 Agent，已有报告也会删除。")) return; await clearProjectData("analysis"); window.location.reload(); }}><Trash2 size={13} /> 清理</button></div>
                <div className="settings-card-row"><div><b>重置当前项目</b><span>另删除规则、环境、契约和连接配置。供应商账户与系统钥匙串保留；其他项目不受影响。</span></div><button className="button ghost danger-hover" onClick={async () => { if (!await confirmAction("确认重置当前项目全部业务数据与配置？其他项目和钥匙串不受影响。")) return; await clearProjectData("project"); window.location.reload(); }}>重置项目</button></div>
              </div>
            </>
          )}
          {message && <div className={`settings-message ${/失败|错误|请先/.test(message) ? "error" : ""}`}>{message}</div>}
        </div>
      </div>
    </Dialog>
  );
}
