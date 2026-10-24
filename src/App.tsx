import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AIWorkspace, type LiveRun, type ScopeChoice } from "./components/AIWorkspace";
import { CaptureWorkspace } from "./components/CaptureWorkspace";
import {
  PhoneDialog,
  RulesDialog,
  SettingsDialog,
  ThrottleDialog,
  type RuleDraft,
} from "./components/Dialogs";
import {
  AggregateDialog,
  ChecklistDialog,
  ComparisonDialog,
  DuplicateDialog,
  ScenarioCompareDialog,
  WaterfallDialog,
} from "./components/InspectionDialogs";
import { TopBar } from "./components/TopBar";
import { WorkbenchDialog } from "./components/WorkbenchDialog";
import {
  confirmAction,
  call,
  enableLocalProxy,
  getSecret,
  localProxyStatus,
  onEngine,
  pickLocalFile,
  restoreLocalProxy,
  saveTextFile,
  type HostProxyStatus,
} from "./lib/api";
import type {
  AggregateResult,
  AnalysisRun,
  AnalysisScope,
  Approval,
  Batch,
  BootstrapData,
  CaptureFilters,
  CaptureStatus,
  CaptureUiState,
  CertificateInfo,
  ChecklistResult,
  ConfigItem,
  DebugAction,
  DuplicateResult,
  Evidence,
  EvidenceTarget,
  FilterOptions,
  ImportRecord,
  LocalProxyStatus,
  McpServer,
  Message,
  Provider,
  Report,
  RequestComparison,
  RequestDetail,
  RequestPage,
  RequestRef,
  RequestSummary,
  Rule,
  RuleType,
  RunBudget,
  RunEvent,
  RunEventPage,
  RunUsage,
  Scenario,
  ScenarioComparison,
  Session,
  SessionSummary,
  ThrottleStatus,
  ToolCard,
  ToolStatus,
  View,
  WaterfallResult,
} from "./types";

interface Toast {
  id: number;
  message: string;
  tone: "error" | "info";
}

interface BatchSelectResult {
  batch: Batch;
  requests: RequestSummary[];
  requestPage: RequestPage;
  scenarios: Scenario[];
  filterOptions: FilterOptions;
}

interface AgentStatus {
  running: boolean;
  sessionId: string | null;
  runId: string | null;
  status: string;
  scope: AnalysisScope | null;
  budget: RunBudget;
  usage: RunUsage;
}

interface RelationPayload {
  edges: Array<{
    sourceId: string;
    targetId: string;
    type: string;
    confidence: string;
    basis: Record<string, unknown>;
    boundary: string;
  }>;
  traceGroups: Array<{ traceId: string; requestIds: string[] }>;
  approximateGroups: Array<{ key: string; requestIds: string[]; type: string; boundary: string }>;
  coverage: Record<string, unknown>;
}

const EMPTY_CAPTURE: CaptureStatus = {
  running: false,
  paused: false,
  port: 8080,
  lan: false,
  startedAt: null,
  requestCount: 0,
  captureLoss: 0,
  localIp: "127.0.0.1",
  decryptHosts: [],
  certUrl: "http://mitm.it/",
  lastTlsError: null,
};

const DEFAULT_FILTERS: CaptureFilters = {
  query: "",
  method: "",
  status: "",
  sourceIp: "",
  host: "",
  environment: "",
  traceId: "",
  errorsOnly: false,
  startedAfter: null,
  startedBefore: null,
};

const EMPTY_PAGE: RequestPage = {
  items: [],
  matchCount: 0,
  batchCount: 0,
  loadedCount: 0,
  nextCursor: null,
  newSinceScope: 0,
  sort: "asc",
};

const DEFAULT_UI_STATE: CaptureUiState = {
  view: "structure",
  openNodes: {},
  selectedId: null,
  scrollTop: 0,
  focusHosts: [],
  detailTab: "overview",
};

function mergeMessage(session: Session, message: Message): Session {
  if (session.messages.some((item) => item.id === message.id)) return session;
  return { ...session, messages: [...session.messages, message], updatedAt: message.createdAt };
}

function mergeTool(tools: ToolCard[], incoming: ToolCard): ToolCard[] {
  const index = tools.findIndex((item) => item.id === incoming.id || (incoming.callId && item.callId === incoming.callId));
  if (index < 0) return [...tools, incoming];
  return tools.map((item, itemIndex) => itemIndex === index ? { ...item, ...incoming } : item);
}

function normalizeToolStatus(value: unknown): ToolStatus {
  if (value === "done" || value === "success") return "done";
  if (value === "denied" || value === "interrupted" || value === "failed" || value === "running" || value === "timeout" || value === "cancelled" || value === "business-error") {
    return value;
  }
  return "error";
}

function mergeEvidence(current: Evidence[], incoming: Evidence[]): Evidence[] {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) values.set(item.id, item);
  return [...values.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function liveFromEvents(run: AnalysisRun, events: RunEvent[]): LiveRun {
  let content = "";
  let tools: ToolCard[] = [];
  for (const event of events) {
    if (event.eventType === "text_delta") {
      content += String(event.payload.delta || "");
    } else if (event.eventType === "tool_call") {
      tools = mergeTool(tools, {
        id: event.toolCallId || event.id,
        callId: event.toolCallId || undefined,
        name: String(event.payload.toolName || "tool"),
        status: "running",
        args: event.payload.args || {},
        startedAt: event.createdAt,
      });
    } else if (event.eventType === "tool_result") {
      tools = mergeTool(tools, {
        id: event.toolCallId || event.id,
        callId: event.toolCallId || undefined,
        name: String(event.payload.toolName || "tool"),
        status: normalizeToolStatus(event.status),
        result: String(event.payload.result || ""),
        outcome: String(event.payload.outcome || event.status || ""),
        finishedAt: event.createdAt,
      });
    }
  }
  const status: LiveRun["status"] = run.status === "running" || run.status === "waiting_approval" || run.status === "executing_tool"
    ? "running"
    : run.status === "stopped" || run.status === "interrupted" || run.status === "budget_exhausted"
      ? "stopped"
      : run.status === "failed"
        ? "failed"
        : "completed";
  return { content, tools, status, runId: run.id };
}

function evidenceReturnKey(): string { return `ai-proxy-evidence-return:${localStorage.getItem("ai-proxy-active-project") || "default"}`; }

function uiStorageKey(batchId: string): string {
  return `ai-proxy-capture-ui:${batchId}`;
}

function readFilters(batchId: string): CaptureFilters {
  try { return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(`${uiStorageKey(batchId)}:filters`) || "{}") }; } catch { return { ...DEFAULT_FILTERS }; }
}

function readUiState(batchId: string): CaptureUiState {
  try {
    const raw = localStorage.getItem(uiStorageKey(batchId));
    if (!raw) return { ...DEFAULT_UI_STATE };
    return { ...DEFAULT_UI_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

async function loadAllRunEvents(runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let afterSeq = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = await call<RunEventPage>("agent.events", {
      runId,
      afterSeq,
      limit: 500,
    });
    events.push(...result.items);
    if (result.lastSeq <= afterSeq || result.items.length === 0) break;
    afterSeq = result.lastSeq;
  }
  return events;
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() =>
    localStorage.getItem("ai-proxy-view") === "ai" ? "ai" : "capture",
  );
  const [capture, setCapture] = useState<CaptureStatus>(EMPTY_CAPTURE);
  const [throttle, setThrottle] = useState<ThrottleStatus>({ enabled: false, upKbPerSecond: 0, downKbPerSecond: 0, latencyMs: 0 });
  const [batches, setBatches] = useState<Batch[]>([]);
  const [currentBatch, setCurrentBatch] = useState<Batch>({ id: "", label: "", createdAt: 0 });
  const [requestPage, setRequestPage] = useState<RequestPage>(EMPTY_PAGE);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ devices: [], hosts: [], environments: [] });
  const [filters, setFilters] = useState<CaptureFilters>(DEFAULT_FILTERS);
  const [rules, setRules] = useState<Rule[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [certificate, setCertificate] = useState<CertificateInfo>({ path: "", exists: false, url: "http://mitm.it/", directory: "" });
  const [storage, setStorage] = useState({ dataDir: "", size: 0 });
  const [listenPort, setListenPort] = useState(8080);
  const [hostProxy, setHostProxy] = useState<LocalProxyStatus | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [debugActions, setDebugActions] = useState<DebugAction[]>([]);
  const [configVersion, setConfigVersion] = useState("");
  const [projectName, setProjectName] = useState("默认项目");

  const [selected, setSelected] = useState<RequestSummary | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const [uiState, setUiState] = useState<CaptureUiState>(DEFAULT_UI_STATE);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [relations, setRelations] = useState<RelationPayload | null>(null);

  const [liveRuns, setLiveRuns] = useState<Record<string, LiveRun>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [composerRefs, setComposerRefs] = useState<RequestRef[]>([]);
  const [autoApply, setAutoApply] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(() => localStorage.getItem("ai-proxy-provider") || "");
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [scope, setScope] = useState<AnalysisScope | null>(null);
  const [budget, setBudget] = useState<RunBudget | null>(null);
  const [usage, setUsage] = useState<RunUsage | null>(null);
  const [mode, setMode] = useState<"analysis" | "debug">("analysis");
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("filter");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [comparison, setComparison] = useState<RequestComparison | null>(null);
  const [scenarioCompareOpen, setScenarioCompareOpen] = useState(false);
  const [scenarioCompareBusy, setScenarioCompareBusy] = useState(false);
  const [scenarioComparison, setScenarioComparison] = useState<ScenarioComparison | null>(null);
  const [aggregateOpen, setAggregateOpen] = useState(false);
  const [aggregateBusy, setAggregateBusy] = useState(false);
  const [aggregate, setAggregate] = useState<AggregateResult | null>(null);
  const [aggregateGroupBy, setAggregateGroupBy] = useState("endpoint");
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateResult | null>(null);
  const [waterfallOpen, setWaterfallOpen] = useState(false);
  const [waterfallLoading, setWaterfallLoading] = useState(false);
  const [waterfallTraceId, setWaterfallTraceId] = useState("");
  const [waterfall, setWaterfall] = useState<WaterfallResult | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistResult | null>(null);

  const [ruleDialog, setRuleDialog] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [phoneDialog, setPhoneDialog] = useState(false);
  const [throttleDialog, setThrottleDialog] = useState(false);
  const [settingsDialog, setSettingsDialog] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchTab, setWorkbenchTab] = useState("environments");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const batchRef = useRef(currentBatch.id);
  const evidenceNonceRef = useRef(0);
  const filtersRef = useRef(filters);
  const requestPageRef = useRef(requestPage);
  const selectedRef = useRef(selected);
  const sessionIdRef = useRef<string | null>(null);
  const scopeRef = useRef<AnalysisScope | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const requestReloadTimer = useRef<number | null>(null);
  const uiSaveTimer = useRef<number | null>(null);
  const flushUiSave = useRef<(() => void) | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => { batchRef.current = currentBatch.id; }, [currentBatch.id]);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  useEffect(() => { requestPageRef.current = requestPage; }, [requestPage]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { sessionIdRef.current = session?.id ?? null; }, [session?.id]);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  useEffect(() => { activeRunIdRef.current = activeRunId; }, [activeRunId]);
  useEffect(() => { localStorage.setItem("ai-proxy-view", view); }, [view]);

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
  useEffect(() => {
    if (!booted || !currentBatch.id) return;
    if (uiSaveTimer.current) window.clearTimeout(uiSaveTimer.current);
    const save = () => {
      localStorage.setItem(uiStorageKey(currentBatch.id), JSON.stringify(uiState));
      localStorage.setItem(`${uiStorageKey(currentBatch.id)}:filters`, JSON.stringify(filters));
      localStorage.setItem(`${uiStorageKey(currentBatch.id)}:selection`, JSON.stringify(multiSelected));
    };
    flushUiSave.current = save;
    uiSaveTimer.current = window.setTimeout(save, 180);
    return () => {
      if (uiSaveTimer.current) window.clearTimeout(uiSaveTimer.current);
      if (batchRef.current !== currentBatch.id && flushUiSave.current === save) save();
      if (flushUiSave.current === save) flushUiSave.current = null;
    };
  }, [booted, currentBatch.id, uiState, filters, multiSelected]);
  useEffect(() => {
    const flush = () => flushUiSave.current?.();
    const clear = () => {
      if (uiSaveTimer.current) window.clearTimeout(uiSaveTimer.current);
      flushUiSave.current = null;
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("ai-proxy-project-cleared", clear);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("ai-proxy-project-cleared", clear);
    };
  }, []);

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
    setProviders(await call<Provider[]>("providers.list"));
  }, []);

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

  const refreshFilterOptions = useCallback(async (batchId?: string) => {
    const id = batchId || batchRef.current;
    if (!id) return;
    setFilterOptions(await call<FilterOptions>("requests.filter-options", { batchId: id }));
  }, []);

  const hydrateRun = useCallback(async (runId: string) => {
    const [run, events, runEvidence] = await Promise.all([
      call<AnalysisRun>("agent.run", { runId }),
      loadAllRunEvents(runId),
      call<Evidence[]>("agent.evidence", { runId }),
    ]);
    setActiveRunId(run.id);
    localStorage.setItem(`ai-proxy-active-run:${run.sessionId}`, run.id);
    activeRunIdRef.current = run.id;
    setRunEvents(events);
    setEvidence(runEvidence);
    setScope(run.scope);
    scopeRef.current = run.scope;
    setBudget(run.budget);
    setUsage(run.usage);
    setMode(run.mode);
    const live = liveFromEvents(run, events);
    setLiveRuns((current) => {
      if (live.status === "running") return { ...current, [run.sessionId]: live };
      const next = { ...current };
      if (next[run.sessionId]?.runId === run.id && run.status === "completed") delete next[run.sessionId];
      return next;
    });
    return run;
  }, []);

  const refreshArtifacts = useCallback(async (sessionId?: string, preferredRunId?: string | null) => {
    const id = sessionId || sessionIdRef.current;
    if (!id) return;
    const [items, reportItems] = await Promise.all([
      call<AnalysisRun[]>("agent.runs", { sessionId: id }),
      call<Report[]>("reports.list", { sessionId: id }),
    ]);
    if (id !== sessionIdRef.current) return;
    setRuns(items);
    setReports(reportItems);
    const preferred = preferredRunId || activeRunIdRef.current || localStorage.getItem(`ai-proxy-active-run:${id}`);
    const run = items.find((item) => item.id === preferred) || items[0];
    if (run) {
      await hydrateRun(run.id);
    } else {
      setActiveRunId(null);
      setRunEvents([]);
      setEvidence([]);
      setScope(null);
      setUsage(null);
    }
  }, [hydrateRun]);

  const refreshRequestPage = useCallback(async (batchId?: string) => {
    const id = batchId || batchRef.current;
    if (!id) return;
    const generation = ++requestGeneration.current;
    const result = await call<RequestPage>("requests.query", {
      batchId: id,
      ...filtersRef.current,
      limit: 200,
      sort: "asc",
      sinceStartedAt: scopeRef.current?.snapshotAt ?? null,
    });
    if (generation !== requestGeneration.current) return;
    setRequestPage(result);
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = requestPageRef.current.nextCursor;
    if (!cursor || !batchRef.current) return;
    const result = await call<RequestPage>("requests.query", {
      batchId: batchRef.current,
      ...filtersRef.current,
      cursor,
      limit: 200,
      sort: "asc",
      sinceStartedAt: scopeRef.current?.snapshotAt ?? null,
    });
    setRequestPage((current) => {
      const ids = new Set(current.items.map((item) => item.id));
      const appended = result.items.filter((item) => !ids.has(item.id));
      const items = [...current.items, ...appended];
      return { ...result, items, loadedCount: items.length };
    });
  }, []);

  const scheduleRequestReload = useCallback(() => {
    if (requestReloadTimer.current) window.clearTimeout(requestReloadTimer.current);
    requestReloadTimer.current = window.setTimeout(() => {
      void refreshRequestPage().catch((reason) => setCaptureError(String(reason)));
    }, 220);
  }, [refreshRequestPage]);

  const refreshSelectedDetail = useCallback(async (requestId: string) => {
    try {
      const result = await call<RequestDetail>("requests.detail", { requestId });
      if (selectedRef.current?.id === requestId) {
        setSelected(result);
        setDetail(result);
      }
    } catch {
      // The selected row may have been removed by a concurrent batch cleanup.
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const initialize = async () => {
      try {
        const data = await call<BootstrapData>("app.bootstrap");
        if (!mounted) return;
        setCapture(data.capture);
        setThrottle(data.throttle);
        setBatches(data.batches);
        setCurrentBatch(data.currentBatch);
        batchRef.current = data.currentBatch.id;
        setRequestPage({ ...data.requestPage, sort: "asc" });
        setFilterOptions(data.filterOptions);
        setRules(data.rules);
        setProviders(data.providers);
        setSessions(data.sessions);
        setSession(data.currentSession);
        sessionIdRef.current = data.currentSession.id;
        setCertificate(data.certificate);
        setStorage(data.storage);
        setListenPort(data.listenPort);
        setScenarios(data.scenarios);
        setConfigs(data.configs);
        setImports(data.imports);
        setMcpServers(data.mcpServers);
        setDebugActions(data.debugActions);
        setConfigVersion(data.configVersion);
        setProjectName(data.projects?.items.find(item => item.id === data.projects?.active)?.name || "默认项目");
        localStorage.setItem("ai-proxy-active-project", data.projects?.active || "default");
        setBudget(data.agent.budget);
        setUsage(data.agent.usage);
        setScope(data.agent.scope);
        scopeRef.current = data.agent.scope;
        setAgentRunning(data.agent.running);
        setUiState(readUiState(data.currentBatch.id));
        const restoredFilters = readFilters(data.currentBatch.id);
        filtersRef.current = restoredFilters;
        setFilters(restoredFilters);
        try { setMultiSelected(JSON.parse(localStorage.getItem(`${uiStorageKey(data.currentBatch.id)}:selection`) || "[]")); } catch { setMultiSelected([]); }
        await refreshHostProxy();
        setBooted(true);
        await refreshArtifacts(data.currentSession.id, data.agent.runId);
        await refreshRequestPage(data.currentBatch.id);
      } catch (reason) {
        if (mounted) setBootError(String(reason));
      }
    };
    void initialize();
    return () => { mounted = false; };
  }, [refreshArtifacts, refreshHostProxy, refreshRequestPage]);

  useEffect(() => {
    if (!booted) return;
    const cleanup: Array<() => void> = [];
    const register = async () => {
      cleanup.push(await onEngine<CaptureStatus>("capture:status", (value) => setCapture(value)));
      cleanup.push(await onEngine<RequestSummary>("capture:request", (request) => {
        if (request.batchId !== batchRef.current) return;
        scheduleRequestReload();
        if (selectedRef.current?.id === request.id) void refreshSelectedDetail(request.id);
      }));
      cleanup.push(await onEngine<{ host: string; message: string }>("capture:tls-error", (value) => {
        notify(`HTTPS 握手失败：${value.host}。请检查证书信任或固定证书。`, "error");
      }));
      cleanup.push(await onEngine<{ reason: string; total: number; requestId?: string }>("capture:record-loss", (value) => {
        setCapture((current) => ({ ...current, captureLoss: value.total, lastRecordLossReason: value.reason }));
        notify(`采集中途发生背压丢失（${value.reason}），累计 ${value.total} 条。`, "error");
      }));
      cleanup.push(await onEngine<ThrottleStatus>("proxy:throttle", (value) => setThrottle(value)));
      cleanup.push(await onEngine<Rule[]>("rules:changed", (value) => setRules(value)));
      cleanup.push(await onEngine<Provider[]>("providers:changed", (value) => setProviders(value)));
      cleanup.push(await onEngine<{ sessionId: string }>("session:updated", async (value) => {
        await refreshSessions();
        if (value.sessionId === sessionIdRef.current) await refreshSession(value.sessionId);
      }));
      cleanup.push(await onEngine<{ report: Report }>("report:created", () => {
        void refreshArtifacts();
      }));
      cleanup.push(await onEngine<ConfigItem[]>("configs:changed", (value) => {
        setConfigs(value);
        scheduleRequestReload();
      }));
      cleanup.push(await onEngine<{ version: string }>("config:changed", (value) => setConfigVersion(value.version)));
      cleanup.push(await onEngine<{ action: DebugAction }>("debug:action", (value) => {
        setDebugActions((current) => [value.action, ...current.filter((item) => item.id !== value.action.id)]);
      }));
      cleanup.push(await onEngine<{ sessionId: string; message: Message }>("agent:user-message", async (value) => {
        if (value.sessionId === sessionIdRef.current) {
          setSession((current) => current ? mergeMessage(current, value.message) : current);
        }
        await refreshSessions();
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string; scope?: AnalysisScope; mode?: "analysis" | "debug" }>("agent:started", (value) => {
        setAgentRunning(true);
        setAgentError(null);
        setActiveRunId(value.runId);
        activeRunIdRef.current = value.runId;
        if (value.scope) {
          setScope(value.scope);
          scopeRef.current = value.scope;
        }
        if (value.mode) setMode(value.mode);
        setLiveRuns((current) => ({ ...current, [value.sessionId]: { content: "", tools: [], status: "running", runId: value.runId } }));
      }));
      cleanup.push(await onEngine<RunEvent>("agent:event", (event) => {
        if (event.runId !== activeRunIdRef.current) return;
        setRunEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
        if (event.eventType === "text_delta" || event.eventType === "tool_call" || event.eventType === "tool_result") {
          const sessionId = sessionIdRef.current;
          if (sessionId) {
            setLiveRuns((current) => {
              const existing = current[sessionId] || { content: "", tools: [], status: "running" as const, runId: event.runId };
              if (event.eventType === "text_delta") {
                return { ...current, [sessionId]: { ...existing, content: existing.content + String(event.payload.delta || ""), status: "running" } };
              }
              const tool: ToolCard = event.eventType === "tool_call"
                ? {
                    id: event.toolCallId || event.id,
                    callId: event.toolCallId || undefined,
                    name: String(event.payload.toolName || "tool"),
                    status: "running",
                    args: event.payload.args || {},
                    startedAt: event.createdAt,
                  }
                : {
                    id: event.toolCallId || event.id,
                    callId: event.toolCallId || undefined,
                    name: String(event.payload.toolName || "tool"),
                    status: normalizeToolStatus(event.status),
                    result: String(event.payload.result || ""),
                    outcome: String(event.payload.outcome || event.status || ""),
                    finishedAt: event.createdAt,
                  };
              return { ...current, [sessionId]: { ...existing, tools: mergeTool(existing.tools, tool), status: "running" } };
            });
          }
        }
        if (event.eventType === "evidence") {
          void call<Evidence[]>("agent.evidence", { runId: event.runId }).then((items) => {
            setEvidence((current) => mergeEvidence(current, items));
          });
        }
        if (["run_completed", "run_failed", "run_stopped", "budget_exhausted"].includes(event.eventType)) {
          void refreshArtifacts(sessionIdRef.current || undefined, event.runId);
        }
      }));
      cleanup.push(await onEngine<Approval>("agent:approval", (value) => {
        setApprovals((current) => [...current.filter((item) => item.approvalId !== value.approvalId), value]);
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string; message: Message; evidence?: Evidence[]; usage?: RunUsage }>("agent:done", async (value) => {
        setAgentRunning(false);
        setApprovals((current) => current.filter((item) => item.sessionId !== value.sessionId));
        if (value.sessionId === sessionIdRef.current) {
          setSession((current) => current ? mergeMessage(current, value.message) : current);
          if (value.evidence && value.runId === activeRunIdRef.current) setEvidence((current) => mergeEvidence(current, value.evidence || []));
          if (value.usage && value.runId === activeRunIdRef.current) setUsage(value.usage);
        }
        setLiveRuns((current) => {
          const next = { ...current };
          delete next[value.sessionId];
          return next;
        });
        await refreshSessions();
        await refreshArtifacts(value.sessionId, activeRunIdRef.current || value.runId);
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string }>("agent:stopped", async (value) => {
        setAgentRunning(false);
        setApprovals((current) => current.filter((item) => item.sessionId !== value.sessionId));
        notify("Agent 已停止。已经生效的配置不会被自动撤销。");
        await refreshArtifacts(value.sessionId, activeRunIdRef.current || value.runId);
      }));
      cleanup.push(await onEngine<{ sessionId: string; runId: string; message: Message; error: string }>("agent:error", async (value) => {
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
        await refreshArtifacts(value.sessionId, activeRunIdRef.current || value.runId);
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
  }, [booted, notify, refreshArtifacts, refreshRequestPage, refreshSelectedDetail, refreshSession, refreshSessions, scheduleRequestReload]);

  useEffect(() => {
    if (!booted || !currentBatch.id) return;
    const timer = window.setTimeout(() => {
      setRelations(null);
      void refreshRequestPage().catch((reason) => setCaptureError(String(reason)));
      void refreshFilterOptions().catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [booted, filters, currentBatch.id, refreshFilterOptions, refreshRequestPage]);

  const selectRequest = async (request: RequestSummary) => {
    setEvidenceTarget(null);
    setSelected(request);
    selectedRef.current = request;
    setDetail(null);
    setDetailLoading(true);
    setUiState((current) => ({ ...current, selectedId: request.id }));
    try {
      const result = await call<RequestDetail>("requests.detail", { requestId: request.id });
      setDetail(result);
    } catch (reason) {
      setCaptureError(String(reason));
    } finally {
      setDetailLoading(false);
    }
  };

  const selectRequestById = useCallback(async (requestId: string) => {
    if (!requestId) return;
    setView("capture");
    setDetailLoading(true);
    try {
      const result = await call<RequestDetail>("requests.detail", { requestId });
      let baseOpenNodes = uiState.openNodes;
      if (result.batchId !== batchRef.current) {
        const selectedBatch = await call<BatchSelectResult>("batches.select", { batchId: result.batchId });
        batchRef.current = selectedBatch.batch.id;
        setCurrentBatch(selectedBatch.batch);
        setScenarios(selectedBatch.scenarios);
        setFilterOptions(selectedBatch.filterOptions);
        setRequestPage({ ...selectedBatch.requestPage, sort: "asc", items: selectedBatch.requests });
        const restored = readUiState(result.batchId);
        baseOpenNodes = restored.openNodes;
        setUiState(restored);
      }
      const hasActiveFilter = Boolean(
        filtersRef.current.query
        || filtersRef.current.method
        || filtersRef.current.status
        || filtersRef.current.sourceIp
        || filtersRef.current.host
        || filtersRef.current.environment
        || filtersRef.current.traceId
        || filtersRef.current.errorsOnly
        || filtersRef.current.startedAfter
        || filtersRef.current.startedBefore,
      );
      const inCurrentPage = requestPageRef.current.items.some((item) => item.id === result.id);
      if (hasActiveFilter && !inCurrentPage) {
        sessionStorage.setItem(evidenceReturnKey(), JSON.stringify({ batchId: batchRef.current, filters: filtersRef.current, ui: uiState }));
        filtersRef.current = { ...DEFAULT_FILTERS };
        setFilters({ ...DEFAULT_FILTERS });
      }
      const pathname = result.path.split("?")[0] || "/";
      const segments = pathname.split("/").filter(Boolean);
      const defaultPort = result.scheme === "https" ? 443 : 80;
      const root = `${result.scheme}://${result.host}${result.port === defaultPort ? "" : `:${result.port}`}`;
      const openNodes = { ...baseOpenNodes, [root]: true };
      let accumulated = "";
      for (const segment of segments) {
        accumulated += `/${segment}`;
        openNodes[`dir:${root}:${accumulated}`] = true;
      }
      openNodes[`group:${root}|${result.method}|${pathname}`] = true;
      setUiState((current) => ({
        ...current,
        selectedId: result.id,
        openNodes: { ...current.openNodes, ...openNodes },
      }));
      setSelected(result);
      selectedRef.current = result;
      setDetail(result);
      setRequestPage((current) => {
        if (current.items.some((item) => item.id === result.id)) return current;
        return {
          ...current,
          items: [result, ...current.items],
          loadedCount: current.loadedCount + 1,
        };
      });
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setDetailLoading(false);
    }
  }, [notify, uiState.openNodes]);

  useEffect(() => {
    if (!booted || !currentBatch.id || !uiState.selectedId) return;
    if (selectedRef.current?.id === uiState.selectedId) return;
    void selectRequestById(uiState.selectedId);
  }, [booted, currentBatch.id, selectRequestById, uiState.selectedId]);

  const openEvidence = useCallback(async (
    requestId: string,
    direction: string,
    locator: string | null,
    expectedVersion?: number,
  ) => {
    const source = evidence.find(item => item.requestId === requestId && item.locator === locator);
    if (source?.state === "deleted") { notify("证据来源已删除，无法打开原始样本。", "error"); return; }
    const actualDirection = locator?.match(/^(request|response)[/#]/)?.[1] || direction;
    const tab: CaptureUiState["detailTab"] = locator?.startsWith("url/query/") || locator?.endsWith("/status")
      ? "overview"
      : actualDirection === "request"
        ? "request"
        : actualDirection === "response"
          ? "response"
          : "overview";
    setInlineOpen(false);
    setView("capture");
    setEvidenceTarget({
      requestId,
      direction,
      locator,
      nonce: ++evidenceNonceRef.current,
      expectedVersion: expectedVersion || source?.requestVersion,
    });
    await selectRequestById(requestId);
    setUiState((current) => ({ ...current, detailTab: tab }));
  }, [selectRequestById, evidence, notify]);

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
      if (!status.lan) status = await call<CaptureStatus>("capture.set-lan", { lan: true });
      if (!status.running) status = await call<CaptureStatus>("capture.start", { port: listenPort, lan: true });
      if (!status.decryptHosts.includes("*")) status = await call<CaptureStatus>("decrypt.set", { host: "*", enabled: true });
      setCapture(status);
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
    setEvidenceTarget(null);
    const result = await call<BatchSelectResult>("batches.select", { batchId: id });
    batchRef.current = result.batch.id;
    setCurrentBatch(result.batch);
    setScenarios(result.scenarios);
    setFilterOptions(result.filterOptions);
    setRequestPage({ ...result.requestPage, sort: "asc", items: result.requests });
    setSelected(null);
    setDetail(null);
    setMultiSelected([]);
    setRelations(null);
    setUiState(readUiState(id));
    filtersRef.current = readFilters(id);
    setFilters(filtersRef.current);
    try { setMultiSelected(JSON.parse(localStorage.getItem(`${uiStorageKey(id)}:selection`) || "[]")); } catch { setMultiSelected([]); }
    await refreshRequestPage(id);
  };

  const newBatch = async () => {
    setEvidenceTarget(null);
    const batch = await call<Batch>("batches.create");
    setBatches((current) => [batch, ...current]);
    batchRef.current = batch.id;
    setCurrentBatch(batch);
    setRequestPage(EMPTY_PAGE);
    setScenarios([]);
    setFilterOptions({ devices: [], hosts: [], environments: [] });
    setSelected(null);
    setDetail(null);
    setMultiSelected([]);
    setUiState({ ...DEFAULT_UI_STATE });
  };

  const clearBatch = async (deleteReports: boolean) => {
    if (!currentBatch.id) return;
    if (!await confirmAction(`清空批次「${currentBatch.label}」的抓包记录？${deleteReports ? "关联报告也会一起删除。" : "报告会保留，但引用的请求证据会失效。"}`)) return;
    await call("batches.clear", { batchId: currentBatch.id, deleteReports });
    setEvidenceTarget(null);
    setBatches(await call("batches.list"));
    setScenarios([]);
    setRequestPage(EMPTY_PAGE);
    setSelected(null);
    setDetail(null);
    setMultiSelected([]);
    setRelations(null);
    setEvidence([]);
    setUiState(current => ({ ...current, selectedId: null, openNodes: {}, scrollTop: 0, listPositions: {}, treePageOffsets: {} }));
    await Promise.all([refreshStorage(), refreshArtifacts(), refreshFilterOptions()]);
  };

  const sendToAI = (request: RequestSummary) => {
    setComposerRefs((current) => current.some((item) => item.id === request.id)
      ? current
      : [...current, { id: request.id, method: request.method, url: request.url, status: request.status }]);
    setView("ai");
    setScopeChoice("selection");
    notify("请求已附加到 Agent 输入框。");
  };

  const openRule = (type: RuleType, source: string) => {
    setRuleDraft({ type, source });
    setRuleDialog(true);
  };

  const setDecrypt = async (host: string, enabled: boolean) => {
    try {
      setCapture(await call<CaptureStatus>("decrypt.set", { host, enabled }));
      notify(
        host === "*"
          ? `${enabled ? "已开启全部 HTTPS 解密。请确保设备已信任 CA，新连接生效。" : "已关闭全部 HTTPS 解密。"}`
          : `${enabled ? "已开启" : "已关闭"} ${host} 的 HTTPS 解密。只影响新连接。`,
        enabled && host === "*" && !certificate.exists ? "error" : "info",
      );
      if (selected?.host === host) await refreshSelectedDetail(selected.id);
    } catch (reason) {
      notify(String(reason), "error");
    }
  };

  const newSession = async () => {
    const created = await call<Session>("sessions.create");
    setSession(created);
    sessionIdRef.current = created.id;
    setComposerRefs([]);
    setRuns([]);
    setReports([]);
    setRunEvents([]);
    setEvidence([]);
    setScope(null);
    setActiveRunId(null);
    await refreshSessions();
  };

  const selectSession = async (id: string) => {
    setAgentError(null);
    const result = await call<Session>("sessions.get", { sessionId: id });
    setSession(result);
    sessionIdRef.current = id;
    setComposerRefs([]);
    await refreshArtifacts(id);
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

  const buildScope = useCallback(async (
    selectedIds: string[],
    scenarioId: string | null,
    filtersOverride?: CaptureFilters,
  ): Promise<AnalysisScope> => {
    const result = await call<AnalysisScope>("scope.create", {
      batchId: batchRef.current,
      filters: filtersOverride || filtersRef.current,
      selectedIds: selectedIds.length ? selectedIds : null,
      scenarioId,
      mode: "snapshot",
    });
    setScope(result);
    scopeRef.current = result;
    return result;
  }, []);

  const dispatchAgent = useCallback(async (
    text: string,
    analysisScope: AnalysisScope,
    refs: RequestRef[],
    parentRunId?: string,
  ) => {
    if (!sessionIdRef.current) return;
    if (!selectedProviderId) {
      setSettingsDialog(true);
      setAgentError("请先配置供应商");
      return;
    }
    setAgentError(null);
    setScope(analysisScope);
    scopeRef.current = analysisScope;
    try {
      const apiKey = await getSecret(selectedProviderId).catch(() => null);
      const result = parentRunId
        ? await call<{ runId: string; sessionId: string }>("agent.continue", {
            runId: parentRunId,
            text,
            providerId: selectedProviderId,
            apiKey: apiKey || "",
            autoApply: mode === "debug" && autoApply,
            budget,
          })
        : await call<{ runId: string; sessionId: string }>("agent.send", {
            sessionId: sessionIdRef.current,
            text,
            refs,
            scope: analysisScope,
            providerId: selectedProviderId,
            apiKey: apiKey || "",
            autoApply: mode === "debug" && autoApply,
            mode,
            budget,
          });
      setComposerRefs([]);
      setAgentRunning(true);
      setActiveRunId(result.runId);
      activeRunIdRef.current = result.runId;
      setLiveRuns((current) => ({ ...current, [result.sessionId]: { content: "", tools: [], status: "running", runId: result.runId } }));
      await refreshSessions();
      window.setTimeout(() => { void refreshArtifacts(result.sessionId, result.runId); }, 120);
    } catch (reason) {
      setAgentError(String(reason));
    }
  }, [autoApply, budget, mode, refreshArtifacts, refreshSessions, selectedProviderId]);

  const scopeInputs = () => {
    const ids = scopeChoice === "selection"
      ? (multiSelected.length ? multiSelected : composerRefs.map((item) => item.id))
      : [];
    const scenarioId = scopeChoice === "scenario"
      ? scenarios.find((item) => item.status === "active")?.id ?? null
      : null;
    if (scopeChoice === "selection" && !ids.length) throw new Error("请先选择请求，再分析选择范围");
    if (scopeChoice === "scenario" && !scenarioId) throw new Error("当前没有活动场景，请先开始场景");
    return { ids, scenarioId };
  };

  const sendAgent = async (text: string) => {
    try {
      const { ids, scenarioId } = scopeInputs();
      const analysisScope = await buildScope(ids, scenarioId);
      const refs = composerRefs.length
        ? composerRefs
        : requestPage.items.filter((item) => ids.includes(item.id)).map((item) => ({
            id: item.id,
            method: item.method,
            url: item.url,
            status: item.status,
          }));
      await dispatchAgent(text, analysisScope, refs);
    } catch (reason) {
      setAgentError(String(reason));
    }
  };

  const analyzeFromCapture = async (
    text: string,
    request: { filters: CaptureFilters; selectedIds: string[]; scenarioId?: string | null },
  ) => {
    if (isAgentBusy) return;
    try {
      const analysisScope = await buildScope(request.selectedIds, request.scenarioId ?? null, request.filters);
      const refs = request.selectedIds
        .map((id) => requestPage.items.find((item) => item.id === id) || (selected?.id === id ? selected : null))
        .filter((item): item is RequestSummary => Boolean(item))
        .map((item) => ({ id: item.id, method: item.method, url: item.url, status: item.status }));
      await dispatchAgent(text, analysisScope, refs);
    } catch (reason) {
      setAgentError(String(reason));
    }
  };

  const continueRun = async (run: AnalysisRun) => {
    await dispatchAgent(
      "继续上次未完成的分析，保留已有证据并先说明剩余待验证项。",
      run.scope,
      [],
      run.id,
    );
  };

  const stopAgent = async () => {
    await call("agent.stop");
  };

  const resolveApproval = async (approvalId: string, approved: boolean) => {
    await call("agent.approval", { approvalId, approved });
    setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
  };

  const generateReport = async (run: AnalysisRun) => {
    try {
      const report = await call<Report>("reports.generate", { runId: run.id });
      setReports((current) => [report, ...current.filter((item) => item.id !== report.id)]);
      notify("已从本轮执行生成报告草稿。");
    } catch (reason) {
      notify(String(reason), "error");
    }
  };

  const saveReport = async (report: Report) => {
    const saved = await call<Report>("reports.save", { ...report });
    setReports((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    notify("报告已保存。");
  };

  const deleteReport = async (report: Report) => {
    await call("reports.delete", { reportId: report.id });
    setReports((current) => current.filter((item) => item.id !== report.id));
  };

  const exportReport = async (report: Report, format: "markdown" | "json") => {
    const result = await call<{ fileName: string; content: string }>("reports.export", { reportId: report.id, format });
    const saved = await saveTextFile(result.fileName, result.content);
    if (saved) notify(`报告已保存到 ${saved}`);
  };

  const startChecklist = async (requestIds: string[]) => {
    setChecklistOpen(true);
    setChecklistLoading(true);
    try {
      setChecklist(await call<ChecklistResult>("checklist.generate", { requestIds }));
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setChecklistLoading(false);
    }
  };

  const compareSelected = async () => {
    if (multiSelected.length !== 2) return;
    setDiffOpen(true);
    setDiffLoading(true);
    setComparison(null);
    try {
      setComparison(await call<RequestComparison>("requests.compare", {
        requestIdA: multiSelected[0],
        requestIdB: multiSelected[1],
      }));
    } catch (reason) {
      notify(String(reason), "error");
      setDiffOpen(false);
    } finally {
      setDiffLoading(false);
    }
  };

  const compareScenarios = async (a: string, b: string) => {
    setScenarioCompareBusy(true);
    try {
      setScenarioComparison(await call<ScenarioComparison>("scenarios.compare", { scenarioIdA: a, scenarioIdB: b }));
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setScenarioCompareBusy(false);
    }
  };

  const loadAggregate = useCallback(async (groupBy = aggregateGroupBy) => {
    setAggregateBusy(true);
    try {
      setAggregate(await call<AggregateResult>("requests.aggregate", {
        batchId: batchRef.current,
        ...filtersRef.current,
        groupBy,
      }));
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setAggregateBusy(false);
    }
  }, [aggregateGroupBy, notify]);

  const loadDuplicates = async () => {
    setDuplicateBusy(true);
    try {
      setDuplicates(await call<DuplicateResult>("requests.duplicates", {
        batchId: batchRef.current,
        ...filtersRef.current,
      }));
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setDuplicateBusy(false);
    }
  };

  const loadWaterfall = async (traceId: string) => {
    if (!traceId.trim()) return;
    setWaterfallTraceId(traceId.trim());
    setWaterfallLoading(true);
    try {
      setWaterfall(await call<WaterfallResult>("requests.waterfall", { traceId: traceId.trim() }));
    } catch (reason) {
      notify(String(reason), "error");
    } finally {
      setWaterfallLoading(false);
    }
  };

  const openWaterfall = (traceId?: string) => {
    setWaterfallTraceId(traceId || "");
    setWaterfall(null);
    setWaterfallOpen(true);
    if (traceId) void loadWaterfall(traceId);
  };

  const loadRelations = async () => {
    try {
      setRelations(await call<RelationPayload>("requests.relations", {
        batchId: batchRef.current,
        ...filtersRef.current,
      }));
    } catch (reason) {
      notify(String(reason), "error");
    }
  };

  const startScenario = async (name: string, device: string) => {
    const created = await call<Scenario>("scenarios.start", { batchId: batchRef.current, name, device: device || null });
    setScenarios((current) => [created, ...current]);
    notify(`场景「${name}」已开始记录。`);
  };

  const endScenario = async (scenarioId: string) => {
    const updated = await call<Scenario>("scenarios.end", { scenarioId });
    setScenarios((current) => current.map((item) => item.id === updated.id ? updated : item));
    notify(`场景「${updated.name}」已结束。`);
  };

  const addScenarioRequest = async (scenarioId: string, requestId: string, membership: "include" | "exclude") => {
    const updated = await call<Scenario>("scenarios.set-request", { scenarioId, requestId, membership });
    setScenarios((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  const refreshWorkbench = async () => {
    const [nextConfigs, nextImports, nextMcp, nextDebug, nextBatches] = await Promise.all([
      call<ConfigItem[]>("configs.list"),
      call<ImportRecord[]>("imports.list"),
      call<McpServer[]>("mcp.servers"),
      call<DebugAction[]>("debug.actions", { limit: 100 }),
      call<Batch[]>("batches.list"),
    ]);
    setConfigs(nextConfigs);
    setImports(nextImports);
    setMcpServers(nextMcp);
    setDebugActions(nextDebug);
    setBatches(nextBatches);
    await Promise.all([refreshStorage(), refreshRequestPage(), refreshArtifacts()]);
  };

  const openWorkbench = (tab = "environments") => {
    setWorkbenchTab(tab);
    setWorkbenchOpen(true);
  };

  const saveThrottle = async (value: ThrottleStatus) => {
    setThrottle(await call<ThrottleStatus>("throttle.set", { ...value }));
  };

  const saveBudget = async (value: RunBudget) => {
    const saved = await call<RunBudget>("agent.budget.set", { budget: value });
    setBudget(saved);
    notify("Agent 预算已保存，将在下一轮 Run 生效。");
    return saved;
  };

  const toggleLan = async (enabled: boolean) => {
    try {
      setCapture(await call<CaptureStatus>("capture.set-lan", { lan: enabled }));
    } catch (reason) {
      notify(String(reason), "error");
    }
  };

  const sessionLive = session ? liveRuns[session.id] ?? null : null;
  const currentLive = sessionLive && (!activeRunId || sessionLive.runId === activeRunId) ? sessionLive : null;
  const isAgentBusy = agentRunning || sessionLive?.status === "running";
  const hostProxyStatus = useMemo<HostProxyStatus | null>(() => hostProxy, [hostProxy]);
  const activeRun = runs.find((item) => item.id === activeRunId) || runs[0] || null;
  const savedFilters = configs.filter((item) => item.kind === "saved_filter" && item.enabled);

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

  if (!booted || !session) {
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
        projectName={projectName}
        onProject={() => openWorkbench("projects")}
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
            runs={runs}
            activeRunId={activeRunId}
            reports={reports}
            events={runEvents}
            evidence={evidence}
            scope={activeRun?.scope || scope || null}
            budget={activeRun?.budget || budget}
            usage={activeRun?.usage || usage}
            mode={mode}
            onMode={(value) => {
              setMode(value);
              if (value === "analysis") setAutoApply(false);
            }}
            scopeChoice={scopeChoice}
            onScopeChoice={setScopeChoice}
            onRunSelect={async (run) => {
              await hydrateRun(run.id);
            }}
            onContinue={continueRun}
            onGenerateReport={generateReport}
            onSaveReport={saveReport}
            onDeleteReport={deleteReport}
            onExportReport={exportReport}
            onEvidence={(requestId, direction, locator) => {
              void openEvidence(requestId, direction, locator);
            }}
            onOpenWorkbench={openWorkbench}
            onStartChecklist={startChecklist}
          />
        ) : (
          <CaptureWorkspace
            capture={capture}
            throttle={throttle}
            currentBatch={currentBatch}
            batches={batches}
            requestPage={requestPage}
            selected={selected}
            detail={detail}
            detailLoading={detailLoading}
            evidenceTarget={evidenceTarget}
            filters={filters}
            filterOptions={filterOptions}
            scenarios={scenarios}
            multiSelected={multiSelected}
            uiState={uiState}
            inlineOpen={inlineOpen}
            live={currentLive}
            events={runEvents}
            evidence={evidence}
            scope={activeRun?.scope || scope || null}
            relations={relations}
            agentBusy={Boolean(isAgentBusy)}
            busy={captureBusy}
            error={captureError}
            onFilters={next => {
              setUiState(current => ({ ...current, scrollTop: 0, treePageOffsets: {}, listPositions: {} }));
              setFilters(next);
            }}
            onLoadMore={loadMore}
            onStart={() => void startCapture()}
            onPause={() => void pauseCapture()}
            onStop={() => void stopCapture()}
            onBatchSelect={selectBatch}
            onNewBatch={newBatch}
            onClearBatch={clearBatch}
            onSelect={(request) => void selectRequest(request)}
            onMultiSelected={setMultiSelected}
            onAddRelation={async (sourceId, targetId) => {
              await call("requests.add-relation", {
                sourceId,
                targetId,
                type: "manual-scenario",
                basis: { source: "user" },
              });
              await loadRelations();
              notify("已人工归组；该关系不会被视为调用因果。");
            }}
            onUiState={setUiState}
            onAddToAI={sendToAI}
            onRule={openRule}
            onDecrypt={setDecrypt}
            onRules={() => { setRuleDraft(null); setRuleDialog(true); }}
            onPhone={() => setPhoneDialog(true)}
            onThrottle={() => setThrottleDialog(true)}
            onScenarioStart={startScenario}
            onScenarioEnd={endScenario}
            onAddScenarioRequest={addScenarioRequest}
            onCompare={compareSelected}
            onScenarioCompare={() => {
              setScenarioComparison(null);
              setScenarioCompareOpen(true);
            }}
            onExportHar={async () => {
              const data = await call<Record<string, any>>("exports.har", { batchId: batchRef.current, ...filtersRef.current });
              const saved = await saveTextFile("ai-proxy-export.har", JSON.stringify(data, null, 2));
              if (saved) notify(`HAR 已保存到 ${saved}`);
            }}
            onOpenWorkbench={openWorkbench}
            onLoadRelations={loadRelations}
            onAggregate={() => {
              setAggregateOpen(true);
              void loadAggregate(aggregateGroupBy);
            }}
            onDuplicates={() => {
              setDuplicateOpen(true);
              void loadDuplicates();
            }}
            onWaterfall={openWaterfall}
            onInlineOpen={() => setInlineOpen(true)}
            onInlineClose={() => setInlineOpen(false)}
            savedFilters={savedFilters}
            onSaveFilter={async (name) => {
              await call("configs.save", {
                kind: "saved_filter",
                name,
                config: { filters: filtersRef.current },
                enabled: true,
              });
              setConfigs(await call<ConfigItem[]>("configs.list"));
              notify(`筛选「${name}」已保存。`);
            }}
            onDeleteFilter={async (configId) => {
              await call("configs.delete", { configId });
              setConfigs(await call<ConfigItem[]>("configs.list"));
              notify("已删除保存的筛选。");
            }}
            onFullAI={() => {
              setInlineOpen(false);
              setView("ai");
            }}
            onAnalyze={analyzeFromCapture}
            onEvidenceSelect={(requestId, direction, locator) => {
              void openEvidence(requestId, direction, locator);
            }}
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
      <WorkbenchDialog
        open={workbenchOpen}
        initialTab={workbenchTab}
        onClose={() => setWorkbenchOpen(false)}
        configs={configs}
        imports={imports}
        mcpServers={mcpServers}
        debugActions={debugActions}
        runs={runs}
        reports={reports}
        selectedRequest={selected}
        throttle={throttle}
        budget={activeRun?.budget || budget}
        onBudgetSave={saveBudget}
        onChanged={refreshWorkbench}
        onSelectRequest={(requestId) => {
          setWorkbenchOpen(false);
          void selectRequestById(requestId);
        }}
      />
      <ComparisonDialog open={diffOpen} comparison={comparison} loading={diffLoading} onEvidence={(id, direction, locator, version) => { setDiffOpen(false); void openEvidence(id, direction, locator, version); }} onClose={() => setDiffOpen(false)} />
      <ScenarioCompareDialog
        open={scenarioCompareOpen}
        scenarios={scenarios}
        result={scenarioComparison}
        busy={scenarioCompareBusy}
        onCompare={compareScenarios}
        onSelectRequest={(requestId) => {
          setScenarioCompareOpen(false);
          void selectRequestById(requestId);
        }}
        onClose={() => setScenarioCompareOpen(false)}
      />
      <AggregateDialog
        open={aggregateOpen}
        result={aggregate}
        busy={aggregateBusy}
        groupBy={aggregateGroupBy}
        onGroupBy={(value) => {
          setAggregateGroupBy(value);
          void loadAggregate(value);
        }}
        onLoad={() => loadAggregate()}
        onSelectRequest={(requestId) => {
          setAggregateOpen(false);
          void selectRequestById(requestId);
        }}
        onClose={() => setAggregateOpen(false)}
      />
      <DuplicateDialog
        open={duplicateOpen}
        result={duplicates}
        busy={duplicateBusy}
        onLoad={loadDuplicates}
        onSelectRequest={(requestId) => {
          setDuplicateOpen(false);
          void selectRequestById(requestId);
        }}
        onClose={() => setDuplicateOpen(false)}
      />
      <WaterfallDialog
        open={waterfallOpen}
        initialTraceId={waterfallTraceId}
        result={waterfall}
        loading={waterfallLoading}
        onLoad={loadWaterfall}
        onSelectRequest={(requestId) => {
          setWaterfallOpen(false);
          void selectRequestById(requestId);
        }}
        onClose={() => setWaterfallOpen(false)}
      />
      <ChecklistDialog open={checklistOpen} result={checklist} loading={checklistLoading} onClose={() => setChecklistOpen(false)} />

      <div className="runtime-facts">
        <span>配置版本 {configVersion ? configVersion.slice(0, 10) : "—"}</span>
        {sessionStorage.getItem(evidenceReturnKey()) && <button className="button ghost compact" onClick={async () => { try { const saved = JSON.parse(sessionStorage.getItem(evidenceReturnKey()) || "null"); if (!saved) return; if (saved.batchId !== currentBatch.id) await selectBatch(saved.batchId); filtersRef.current = saved.filters; setFilters(saved.filters); setUiState(saved.ui); setEvidenceTarget(null); setView("capture"); sessionStorage.removeItem(evidenceReturnKey()); } catch (reason) { notify(String(reason), "error"); } }}>返回证据跳转前的筛选</button>}
        <span>{activeRun ? `Run ${activeRun.status}` : "无活动 Run"}</span>
        <span>{configs.filter((item) => item.enabled).length} 项启用配置</span>
      </div>

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
