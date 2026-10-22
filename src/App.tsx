import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AIWorkspace, type LiveRun } from "./components/AIWorkspace";
import { CaptureWorkspace } from "./components/CaptureWorkspace";
import { PhoneDialog, RulesDialog, SettingsDialog, ThrottleDialog, type RuleDraft } from "./components/Dialogs";
import { TopBar } from "./components/TopBar";
import {
  call,
  enableLocalProxy,
  getSecret,
  localProxyStatus,
  onEngine,
  pickLocalFile,
  restoreLocalProxy,
  type HostProxyStatus,
} from "./lib/api";
import type {
  Approval,
  Batch,
  BootstrapData,
  CaptureStatus,
  CertificateInfo,
  LocalProxyStatus,
  Message,
  Provider,
  RequestDetail,
  RequestRef,
  RequestSummary,
  Rule,
  RuleType,
  Session,
  SessionSummary,
  ThrottleStatus,
  ToolCard,
  View,
} from "./types";

interface Filters {
  query: string;
  method: string;
  status: string;
  sourceIp: string;
}

interface Toast {
  id: number;
  message: string;
  tone: "error" | "info";
}

const EMPTY_CAPTURE: CaptureStatus = {
  running: false,
  paused: false,
  port: 8080,
  lan: false,
  startedAt: null,
  requestCount: 0,
  localIp: "127.0.0.1",
  decryptHosts: [],
  certUrl: "http://mitm.it/",
  lastTlsError: null,
};

function mergeMessage(session: Session, message: Message): Session {
  if (session.messages.some((item) => item.id === message.id)) return session;
  return { ...session, messages: [...session.messages, message], updatedAt: message.createdAt };
}

function mergeTool(tools: ToolCard[], incoming: ToolCard): ToolCard[] {
  const index = tools.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...tools, incoming];
  return tools.map((item) => (item.id === incoming.id ? { ...item, ...incoming } : item));
}

export default function App() {
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<View>("capture");
  const [capture, setCapture] = useState<CaptureStatus>(EMPTY_CAPTURE);
  const [throttle, setThrottle] = useState<ThrottleStatus>({ enabled: false, upKbPerSecond: 0, downKbPerSecond: 0, latencyMs: 0 });
  const [batches, setBatches] = useState<Batch[]>([]);
  const [currentBatch, setCurrentBatch] = useState<Batch>({ id: "", label: "", createdAt: 0 });
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [certificate, setCertificate] = useState<CertificateInfo>({ path: "", exists: false, url: "http://mitm.it/", directory: "" });
  const [storage, setStorage] = useState({ dataDir: "", size: 0 });
  const [listenPort, setListenPort] = useState(8080);
  const [hostProxy, setHostProxy] = useState<LocalProxyStatus | null>(null);

  const [filters, setFilters] = useState<Filters>({ query: "", method: "", status: "", sourceIp: "" });
  const [selected, setSelected] = useState<RequestSummary | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [liveRuns, setLiveRuns] = useState<Record<string, LiveRun>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [composerRefs, setComposerRefs] = useState<RequestRef[]>([]);
  const [autoApply, setAutoApply] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(() => localStorage.getItem("ai-proxy-provider") || "");

  const [ruleDialog, setRuleDialog] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [phoneDialog, setPhoneDialog] = useState(false);
  const [throttleDialog, setThrottleDialog] = useState(false);
  const [settingsDialog, setSettingsDialog] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const batchRef = useRef(currentBatch.id);
  const sessionIdRef = useRef<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => { batchRef.current = currentBatch.id; }, [currentBatch.id]);
  useEffect(() => { sessionIdRef.current = session?.id ?? null; }, [session?.id]);
  useEffect(() => {
    if (providers.length > 0 && !providers.some((item) => item.id === selectedProviderId)) {
      setSelectedProviderId(providers[0].id);
    }
  }, [providers, selectedProviderId]);
  useEffect(() => {
    if (selectedProviderId) localStorage.setItem("ai-proxy-provider", selectedProviderId);
  }, [selectedProviderId]);
  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
    return () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); };
  }, [toast]);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  const refreshSessions = useCallback(async () => {
    const items = await call<SessionSummary[]>("sessions.list");
    setSessions(items);
    return items;
  }, []);

  const refreshSession = useCallback(async (sessionId?: string) => {
    const id = sessionId || sessionIdRef.current;
    if (!id) return null;
    const result = await call<Session>("sessions.get", { sessionId: id });
    setSession(result);
    return result;
  }, []);

  const refreshRules = useCallback(async () => {
    setRules(await call<Rule[]>("rules.list"));
  }, []);

  const refreshProviders = useCallback(async () => {
    const result = await call<Provider[]>("providers.list");
    setProviders(result);
    if (result.length && !result.some((item) => item.id === selectedProviderId)) {
      setSelectedProviderId(result[0].id);
    }
  }, [selectedProviderId]);

  const refreshStorage = useCallback(async () => {
    setStorage(await call("storage.info"));
  }, []);

  const refreshHostProxy = useCallback(async () => {
    try {
      setHostProxy(await localProxyStatus());
    } catch {
      setHostProxy(null);
    }
  }, []);

  const loadRequests = useCallback(async (keepSelected = true) => {
    if (!batchRef.current) return;
    try {
      const result = await call<RequestSummary[]>("requests.list", {
        batchId: batchRef.current,
        ...filters,
        limit: 600,
      });
      setRequests(result);
      if (keepSelected && selected && !result.some((item) => item.id === selected.id)) {
        setSelected(null);
        setDetail(null);
      }
    } catch (reason) {
      setCaptureError(String(reason));
    }
  }, [filters, selected]);

  useEffect(() => {
    let mounted = true;
    const initialize = async () => {
      try {
        const data = await call<BootstrapData>("app.bootstrap");
        if (!mounted) return;
        setBoot(data);
        setCapture(data.capture);
        setThrottle(data.throttle);
        setBatches(data.batches);
        setCurrentBatch(data.currentBatch);
        setRequests(data.requests);
        setRules(data.rules);
        setProviders(data.providers);
        setSessions(data.sessions);
        setSession(data.currentSession);
        setCertificate(data.certificate);
        setStorage(data.storage);
        setListenPort(data.listenPort);
        setAgentRunning(data.agent.running);
        await refreshHostProxy();
      } catch (reason) {
        if (mounted) setBootError(String(reason));
      }
    };
    void initialize();
    return () => { mounted = false; };
  }, [refreshHostProxy]);

  useEffect(() => {
    if (!boot) return;
    const cleanup: Array<() => void> = [];
    const register = async () => {
      cleanup.push(await onEngine<CaptureStatus>("capture:status", (value) => setCapture(value)));
      cleanup.push(await onEngine<RequestSummary>("capture:request", (request) => {
        if (request.batchId !== batchRef.current) return;
        setRequests((current) => [...current.filter((item) => item.id !== request.id), request]);
        setCapture((current) => ({ ...current, requestCount: current.requestCount + 1 }));
      }));
      cleanup.push(await onEngine<{ host: string; message: string }>("capture:tls-error", (value) => {
        notify(`HTTPS 握手失败：${value.host}。请检查证书信任或固定证书。`, "error");
      }));
      cleanup.push(await onEngine<ThrottleStatus>("proxy:throttle", (value) => setThrottle(value)));
      cleanup.push(await onEngine<Rule[]>("rules:changed", (value) => setRules(value)));
      cleanup.push(await onEngine<Provider[]>("providers:changed", (value) => setProviders(value)));
      cleanup.push(await onEngine<{ sessionId: string }>("session:updated", () => { void refreshSessions(); }));
      cleanup.push(await onEngine<{ sessionId: string; message: Message }>("agent:user-message", async (value) => {
        if (value.sessionId === sessionIdRef.current) {
          setSession((current) => current ? mergeMessage(current, value.message) : current);
        }
        await refreshSessions();
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string }>("agent:started", (value) => {
        setAgentRunning(true);
        setAgentError(null);
        setLiveRuns((current) => ({ ...current, [value.sessionId]: { content: "", tools: [], status: "running", runId: value.runId } }));
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string; delta: string }>("agent:delta", (value) => {
        setLiveRuns((current) => {
          const existing = current[value.sessionId];
          return {
            ...current,
            [value.sessionId]: {
              content: (existing?.content || "") + value.delta,
              tools: existing?.tools || [],
              status: "running",
              runId: value.runId,
            },
          };
        });
      }));
      cleanup.push(await onEngine<ToolCard & { sessionId: string; runId: string }>("agent:tool", (value) => {
        setLiveRuns((current) => {
          const existing = current[value.sessionId];
          return {
            ...current,
            [value.sessionId]: {
              content: existing?.content || "",
              tools: mergeTool(existing?.tools || [], value),
              status: "running",
              runId: value.runId,
            },
          };
        });
      }));
      cleanup.push(await onEngine<Approval>("agent:approval", (value) => {
        setApprovals((current) => [...current.filter((item) => item.approvalId !== value.approvalId), value]);
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string; message: Message }>("agent:done", async (value) => {
        setAgentRunning(false);
        setApprovals((current) => current.filter((item) => item.sessionId !== value.sessionId));
        if (value.sessionId === sessionIdRef.current) {
          setSession((current) => current ? mergeMessage(current, value.message) : current);
        }
        setLiveRuns((current) => {
          const next = { ...current };
          delete next[value.sessionId];
          return next;
        });
        await refreshSessions();
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string }>("agent:stopped", (value) => {
        setAgentRunning(false);
        setApprovals((current) => current.filter((item) => item.sessionId !== value.sessionId));
        setLiveRuns((current) => {
          const existing = current[value.sessionId];
          if (!existing) return current;
          return { ...current, [value.sessionId]: { ...existing, status: "stopped" } };
        });
        notify("Agent 已停止。已经生效的配置不会被自动撤销。");
      }));
      cleanup.push(await onEngine<{ sessionId: string; message: Message; error: string }>("agent:error", async (value) => {
        setAgentRunning(false);
        setAgentError(value.error);
        setApprovals((current) => current.filter((item) => item.sessionId !== value.sessionId));
        if (value.sessionId === sessionIdRef.current) {
          setSession((current) => current ? mergeMessage(current, value.message) : current);
        }
        setLiveRuns((current) => {
          const next = { ...current };
          delete next[value.sessionId];
          return next;
        });
        await refreshSessions();
      }));
      cleanup.push(await onEngine<{ sessionId: string }>("agent:idle", () => setAgentRunning(false)));
      cleanup.push(await onEngine<{ requestId: string; action: string; payload: { port?: number } }>("agent:host-action", async (value) => {
        try {
          const result = value.action === "local_proxy_enable"
            ? await enableLocalProxy(Number(value.payload.port || 8080))
            : await restoreLocalProxy();
          setHostProxy(result);
          await call("agent.host-result", { requestId: value.requestId, ok: true, result });
        } catch (reason) {
          await call("agent.host-result", { requestId: value.requestId, ok: false, error: String(reason) });
          notify(`系统代理操作失败：${reason}`, "error");
        }
      }));
      cleanup.push(await onEngine<string>("engine-exit", () => notify("本地引擎已退出。", "error")));
      cleanup.push(await onEngine<string>("engine-boot-error", (value) => notify(`引擎启动失败：${value}`, "error")));
      cleanup.push(await onEngine<string>("engine-log", () => undefined));
    };
    void register();
    return () => cleanup.forEach((fn) => fn());
  }, [boot, notify, refreshSessions]);

  useEffect(() => {
    if (!boot) return;
    const timer = window.setTimeout(() => { void loadRequests(); }, 180);
    return () => window.clearTimeout(timer);
  }, [boot, filters, currentBatch.id]);

  const startCapture = async () => {
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const status = await call<CaptureStatus>("capture.start", { port: listenPort, lan: capture.lan });
      setCapture(status);
      setCertificate(await call<CertificateInfo>("certificate.info"));
      notify("抓包已启动。若需要本机流量，请在设置中挂载系统代理。");
    } catch (reason) {
      setCaptureError(String(reason));
      notify(`启动失败：${reason}`, "error");
    } finally {
      setCaptureBusy(false);
    }
  };

  const enablePhoneCapture = async () => {
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      let status = capture;
      if (!status.lan) {
        status = await call<CaptureStatus>("capture.set-lan", { lan: true });
        setCapture(status);
      }
      if (!status.running) {
        status = await call<CaptureStatus>("capture.start", { port: listenPort, lan: true });
        setCapture(status);
      }
      if (!status.decryptHosts.includes("*")) {
        status = await call<CaptureStatus>("decrypt.set", { host: "*", enabled: true });
        setCapture(status);
      }
      setCertificate(await call<CertificateInfo>("certificate.info"));
      notify(`手机接入已开启：${status.localIp}:${status.port}。请在手机安装并完全信任 CA。`);
    } catch (reason) {
      setCaptureError(String(reason));
      notify(`开启手机抓包失败：${reason}`, "error");
    } finally {
      setCaptureBusy(false);
    }
  };

  const pauseCapture = async () => {
    setCaptureBusy(true);
    try {
      setCapture(await call<CaptureStatus>("capture.pause", { paused: !capture.paused }));
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setCaptureBusy(false);
    }
  };

  const stopCapture = async () => {
    setCaptureBusy(true);
    try {
      if (hostProxy?.active) {
        try {
          setHostProxy(await restoreLocalProxy());
        } catch (reason) {
          notify(`系统代理恢复失败，抓包保持运行：${reason}`, "error");
          return;
        }
      }
      setCapture(await call<CaptureStatus>("capture.stop"));
      notify("代理已停止。手机若配置过 Wi-Fi 代理，请手动关闭。");
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setCaptureBusy(false);
    }
  };

  const selectBatch = async (id: string) => {
    const result = await call<{ batch: Batch; requests: RequestSummary[] }>("batches.select", { batchId: id });
    setCurrentBatch(result.batch);
    setRequests(result.requests);
    setSelected(null);
    setDetail(null);
  };

  const newBatch = async () => {
    const batch = await call<Batch>("batches.create");
    setBatches((current) => [batch, ...current]);
    setCurrentBatch(batch);
    setRequests([]);
    setSelected(null);
    setDetail(null);
  };

  const clearBatch = async () => {
    if (!currentBatch.id) return;
    await call("batches.clear", { batchId: currentBatch.id });
    setBatches(await call("batches.list"));
    setRequests([]);
    setSelected(null);
    setDetail(null);
    await refreshStorage();
  };

  const selectRequest = async (request: RequestSummary) => {
    setSelected(request);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await call<RequestDetail>("requests.detail", { requestId: request.id }));
    } catch (reason) {
      setCaptureError(String(reason));
    } finally {
      setDetailLoading(false);
    }
  };

  const sendToAI = (request: RequestSummary) => {
    setComposerRefs((current) => current.some((item) => item.id === request.id) ? current : [...current, { id: request.id, method: request.method, url: request.url, status: request.status }]);
    setView("ai");
    notify("请求已附加到 Agent 输入框。");
  };

  const openRule = (type: RuleType, source: string) => {
    setRuleDraft({ type, source });
    setRuleDialog(true);
  };

  const setDecrypt = async (host: string, enabled: boolean) => {
    try {
      const status = await call<CaptureStatus>("decrypt.set", { host, enabled });
      setCapture(status);
      notify(
        host === "*"
          ? `${enabled ? "已开启全部 HTTPS 解密。请确保设备已信任 CA，新连接生效。" : "已关闭全部 HTTPS 解密。"}`
          : `${enabled ? "已开启" : "已关闭"} ${host} 的 HTTPS 解密。只影响新连接。`,
        enabled && host === "*" && !certificate.exists ? "error" : "info",
      );
      if (selected?.host === host) {
        setDetail(null);
        setDetailLoading(true);
        setTimeout(() => void call<RequestDetail>("requests.detail", { requestId: selected.id }).then(setDetail).finally(() => setDetailLoading(false)), 120);
      }
    } catch (reason) {
      notify(String(reason), "error");
    }
  };

  const newSession = async () => {
    const created = await call<Session>("sessions.create");
    setSession(created);
    await refreshSessions();
  };

  const selectSession = async (id: string) => {
    setAgentError(null);
    setSession(await call<Session>("sessions.get", { sessionId: id }));
    setComposerRefs([]);
  };

  const deleteSession = async (id: string) => {
    await call("sessions.delete", { sessionId: id });
    const items = await refreshSessions();
    if (items.length) await selectSession(items[0].id);
    else await newSession();
  };

  const pickFileForSession = async () => {
    if (!session) return;
    const path = await pickLocalFile();
    if (!path) return;
    await call("sessions.add-file", { sessionId: session.id, path });
    await refreshSession(session.id);
    notify(`已共享 ${path.split("/").pop()}，Agent 现在可用它创建 Map Local。`);
  };

  const sendAgent = async (text: string) => {
    if (!session) return;
    if (!selectedProviderId) {
      setSettingsDialog(true);
      throw new Error("请先配置供应商");
    }
    setAgentError(null);
    try {
      const apiKey = await getSecret(selectedProviderId).catch(() => null);
      const result = await call<{ runId: string; sessionId: string }>("agent.send", {
        sessionId: session.id,
        text,
        refs: composerRefs,
        providerId: selectedProviderId,
        apiKey: apiKey || "",
        autoApply,
      });
      setComposerRefs([]);
      setAgentRunning(true);
      setLiveRuns((current) => ({ ...current, [session.id]: { content: "", tools: [], status: "running", runId: result.runId } }));
    } catch (reason) {
      setAgentError(String(reason));
      throw reason;
    }
  };

  const stopAgent = async () => {
    await call("agent.stop");
  };

  const resolveApproval = async (approvalId: string, approved: boolean) => {
    await call("agent.approval", { approvalId, approved });
    setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
  };

  const saveThrottle = async (value: ThrottleStatus) => {
    setThrottle(await call<ThrottleStatus>("throttle.set", { ...value }));
  };

  const toggleLan = async (enabled: boolean) => {
    try {
      const status = await call<CaptureStatus>("capture.set-lan", { lan: enabled });
      setCapture(status);
    } catch (reason) {
      notify(String(reason), "error");
    }
  };

  const currentLive = session ? liveRuns[session.id] ?? null : null;
  const isAgentBusy = agentRunning || currentLive?.status === "running";
  const hostProxyStatus = useMemo<HostProxyStatus | null>(() => hostProxy, [hostProxy]);

  if (bootError) {
    return (
      <div className="boot-screen">
        <div className="boot-mark"><AlertTriangle size={28} /></div>
        <span className="eyebrow">ENGINE UNAVAILABLE</span>
        <h1>本地引擎没有启动</h1>
        <p>{bootError}</p>
        <button className="button primary" onClick={() => window.location.reload()}>重新连接</button>
      </div>
    );
  }

  if (!boot || !session) {
    return (
      <div className="boot-screen">
        <div className="boot-mark"><LoaderCircle className="spin" size={28} /></div>
        <span className="eyebrow">STARTING LOCAL ENGINE</span>
        <h1>AI Proxy</h1>
        <p>正在打开本地抓包工作区…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        view={view}
        onView={setView}
        capture={capture}
        throttle={throttle}
        hostProxy={hostProxyStatus}
        onStart={() => void startCapture()}
        onPause={() => void pauseCapture()}
        onPhone={() => setPhoneDialog(true)}
        onThrottle={() => setThrottleDialog(true)}
        onRules={() => { setRuleDraft(null); setRuleDialog(true); }}
        onSettings={() => setSettingsDialog(true)}
        busy={captureBusy}
      />

      <div className="workspace">
        {view === "ai" ? (
          <AIWorkspace
            sessions={sessions}
            session={session}
            live={currentLive}
            approvals={approvals}
            providers={providers}
            selectedProviderId={selectedProviderId}
            onProvider={setSelectedProviderId}
            autoApply={autoApply}
            onAutoApply={setAutoApply}
            refs={composerRefs}
            onRefs={setComposerRefs}
            onSend={sendAgent}
            onStop={stopAgent}
            onNew={newSession}
            onSelect={selectSession}
            onDelete={deleteSession}
            onSettings={() => setSettingsDialog(true)}
            onPickFile={pickFileForSession}
            onApproval={resolveApproval}
            busy={Boolean(isAgentBusy)}
            error={agentError}
          />
        ) : (
          <CaptureWorkspace
            capture={capture}
            throttle={throttle}
            currentBatch={currentBatch}
            batches={batches}
            requests={requests}
            selected={selected}
            detail={detail}
            detailLoading={detailLoading}
            filters={filters}
            onFilters={setFilters}
            onStart={() => void startCapture()}
            onPause={() => void pauseCapture()}
            onStop={() => void stopCapture()}
            onBatchSelect={selectBatch}
            onNewBatch={newBatch}
            onClearBatch={clearBatch}
            onSelect={(request) => void selectRequest(request)}
            onAddToAI={sendToAI}
            onRule={openRule}
            onDecrypt={setDecrypt}
            onRules={() => { setRuleDraft(null); setRuleDialog(true); }}
            onPhone={() => setPhoneDialog(true)}
            onThrottle={() => setThrottleDialog(true)}
            busy={captureBusy}
            error={captureError}
          />
        )}
      </div>

      <RulesDialog open={ruleDialog} rules={rules} draft={ruleDraft} onClose={() => setRuleDialog(false)} onChanged={refreshRules} />
      <ThrottleDialog open={throttleDialog} value={throttle} onClose={() => setThrottleDialog(false)} onSave={saveThrottle} />
      <PhoneDialog open={phoneDialog} capture={capture} certificate={certificate} onClose={() => setPhoneDialog(false)} onLan={toggleLan} onHttps={(enabled) => setDecrypt("*", enabled)} onEnable={enablePhoneCapture} />
      <SettingsDialog
        open={settingsDialog}
        providers={providers}
        selectedProviderId={selectedProviderId}
        onProvider={setSelectedProviderId}
        onProvidersChanged={refreshProviders}
        listenPort={listenPort}
        onPortSaved={async () => {
          const status = await call<CaptureStatus>("capture.status");
          setCapture(status);
          setListenPort(status.port);
        }}
        capture={capture}
        certificate={certificate}
        storage={storage}
        onRefreshStorage={refreshStorage}
        onClose={() => { setSettingsDialog(false); void refreshHostProxy(); }}
      />

      {toast && (
        <div className={`toast ${toast.tone}`} key={toast.id}>
          {toast.tone === "error" ? <AlertTriangle size={16} /> : <span className="toast-dot" />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}
