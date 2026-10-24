import {
  Activity,
  Check,
  Database,
  Download,
  FileJson2,
  GitMerge,
  Globe2,
  LoaderCircle,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { QAWorkspace, ProjectWorkspace } from "./QAWorkspace";
import { Dialog } from "./Dialogs";
import type {
  AnalysisRun,
  ConfigItem,
  DebugAction,
  DebugVerification,
  ImportRecord,
  McpServer,
  Report,
  RequestSummary,
  RunBudget,
  ThrottleStatus,
} from "../types";
import {
  confirmAction,
  call,
  pickLocalFile,
  readTextFile,
  saveTextFile,
} from "../lib/api";

type WorkbenchTab =
  | "qa"
  | "projects"
  | "environments"
  | "business"
  | "associations"
  | "imports"
  | "integrations"
  | "debug"
  | "runs";

interface Props {
  open: boolean;
  initialTab?: string;
  onClose: () => void;
  configs: ConfigItem[];
  imports: ImportRecord[];
  mcpServers: McpServer[];
  debugActions: DebugAction[];
  runs: AnalysisRun[];
  reports: Report[];
  selectedRequest: RequestSummary | null;
  throttle: ThrottleStatus;
  budget: RunBudget | null;
  onBudgetSave: (budget: RunBudget) => Promise<RunBudget>;
  onChanged: () => Promise<void>;
  onSelectRequest: (requestId: string) => void;
}

const defaultEnvironment = {
  name: "",
  appVersion: "",
  buildNumber: "",
};

const defaultBusiness = {
  name: "",
  hostPattern: "",
  pathPattern: "",
  successStatuses: "200",
  errorPointer: "/code",
  successValues: "0,200",
};

function tabFrom(value?: string): WorkbenchTab {
  const allowed: WorkbenchTab[] = ["qa", "projects", "environments", "business", "associations", "imports", "integrations", "debug", "runs"];
  return allowed.includes(value as WorkbenchTab) ? value as WorkbenchTab : "environments";
}

export function WorkbenchDialog({
  open,
  initialTab,
  onClose,
  configs,
  imports,
  mcpServers,
  debugActions,
  runs,
  reports,
  selectedRequest,
  throttle,
  budget,
  onBudgetSave,
  onChanged,
  onSelectRequest,
}: Props) {
  const [sharedSessions, setSharedSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [sharedSessionId, setSharedSessionId] = useState("");
  useEffect(() => { if (open) void call<Array<{ id: string; title: string }>>("sessions.list").then(items => { setSharedSessions(items); setSharedSessionId(value => value || items[0]?.id || ""); }).catch(reason => setMessage(String(reason))); }, [open]);
  const [tab, setTab] = useState<WorkbenchTab>("environments");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [environment, setEnvironment] = useState(defaultEnvironment);
  const [business, setBusiness] = useState(defaultBusiness);
  const [association, setAssociation] = useState({ name: "", field: "orderId" });
  const [dynamicFields, setDynamicFields] = useState({ name: "动态字段", patterns: "timestamp,traceId,requestId,nonce" });
  const [debugType, setDebugType] = useState("map-remote");
  const [debugPayload, setDebugPayload] = useState('{\n  "source": "https://api.example.com/v1/*",\n  "target": "http://127.0.0.1:3000/v1/"\n}');
  const [debugAction, setDebugAction] = useState<DebugAction | null>(null);
  const [replay, setReplay] = useState<Record<string, any> | null>(null);
  const [mcp, setMcp] = useState({ name: "", endpoint: "", allowedTools: "search_knowledge" });
  const [mcpCall, setMcpCall] = useState({ serverId: "", toolName: "", arguments: "{}" });
  const [observability, setObservability] = useState({ endpoint: "", traceId: "" });
  const [observabilityResult, setObservabilityResult] = useState<Record<string, any> | null>(null);
  const [openApiTemplates, setOpenApiTemplates] = useState<Array<Record<string, any>>>([]);
  const [ticket, setTicket] = useState({ reportId: "", endpoint: "", preview: null as Record<string, any> | null });
  const [debugVerification, setDebugVerification] = useState<DebugVerification | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<RunBudget | null>(budget);

  const environments = configs.filter((item) => item.kind === "environment");
  const businessRules = configs.filter((item) => item.kind === "business_rule");
  const associations = configs.filter((item) => item.kind === "association");
  const dynamicConfigs = configs.filter((item) => item.kind === "dynamic_fields");
  const openApiConfigs = configs.filter((item) => item.kind === "openapi");

  useEffect(() => {
    if (open) {
      setTab(tabFrom(initialTab));
      setMessage(null);
      setDebugAction(null);
      setReplay(null);
      setObservabilityResult(null);
      setOpenApiTemplates([]);
      setMcpCall((value) => ({ ...value, serverId: value.serverId || mcpServers[0]?.id || "" }));
      setTicket((value) => ({ ...value, reportId: value.reportId || reports[0]?.id || "" }));
      setDebugVerification(null);
      setBudgetDraft(budget);
    }
  }, [open, initialTab]);

  const saveConfig = async (kind: string, name: string, config: Record<string, any>, activate = false) => {
    setBusy(true);
    setMessage(null);
    try {
      await call("configs.save", { kind, name, config, enabled: true, activate });
      await onChanged();
      setMessage("配置已保存。");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const importJson = async (kind: "har" | "openapi" | "otlp") => {
    const path = await pickLocalFile();
    if (!path) return;
    setBusy(true);
    setMessage(null);
    try {
      const raw = await readTextFile(path);
      const data = JSON.parse(raw);
      const method = kind === "har" ? "imports.har" : kind === "openapi" ? "imports.openapi" : "imports.otlp";
      const result = await call<Record<string, any>>(method, {
        data,
        name: path.split("/").pop()?.replace(/\.json$/i, "") || kind,
        source: path,
      });
      await onChanged();
      setMessage(
        kind === "har"
          ? `HAR 已导入到新批次：${result.imported} 条。`
          : kind === "openapi"
            ? `OpenAPI 已导入：${result.summary?.operations || 0} 个操作。`
            : `OTLP 已导入：${result.imported || 0} 个 Span。`,
      );
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportHar = async () => {
    if (!await confirmAction("导出原始 HAR 会保留 URL、Header 和正文中的敏感值。确认保存到本地？交接可使用 QA 工作台的脱敏证据包。")) return;
    setBusy(true);
    try {
      const data = await call<Record<string, any>>("exports.har", {});
      const saved = await saveTextFile("ai-proxy-export.har", JSON.stringify(data, null, 2));
      if (saved) setMessage(`HAR 已保存到 ${saved}；导出 ${data.log?._aiProxy?.exported ?? "—"} 条，未包含 ${data.log?._aiProxy?.omitted ?? "—"} 条。`);
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const previewDebug = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const payload = { ...JSON.parse(debugPayload), ...(debugType === "map-local" ? { ownerSessionId: sharedSessionId } : {}) };
      const action = await call<DebugAction>("debug.preview", { actionType: debugType, payload });
      setDebugAction(action);
      setMessage("预览已生成。只有点击应用后才会修改配置。");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const applyDebug = async () => {
    if (!debugAction) return;
    setBusy(true);
    try {
      const action = await call<DebugAction>("debug.apply", { actionId: debugAction.id });
      setDebugAction(action);
      await onChanged();
      setMessage(action.status === "applied" ? "调试变更已生效。" : `操作状态：${action.status} ${action.result?.error || ""}`);
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const restoreDebug = async (actionId: string) => {
    setBusy(true);
    try {
      const action = await call<DebugAction>("debug.restore", { actionId });
      setDebugAction(action);
      await onChanged();
      setMessage(action.status === "restored" ? "配置已恢复。" : `恢复状态：${action.status} ${action.result?.error || ""}`);
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const previewReplay = async () => {
    if (!selectedRequest) return;
    setBusy(true);
    try {
      setReplay(await call("replay.preview", { requestId: selectedRequest.id }));
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const executeReplay = async () => {
    if (!selectedRequest || !replay?.id) return;
    setBusy(true);
    try {
      setReplay(await call("replay.execute", { requestId: selectedRequest.id, actionId: replay.id }));
      setMessage("重放请求已发送。超时会被标记为结果未知，不会自动重试。");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const verifyDebug = async () => {
    if (!debugAction) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await call<DebugVerification>("debug.verify", {
        actionId: debugAction.id,
        sourceIp: selectedRequest?.sourceIp || "",
      });
      setDebugVerification(result);
      setMessage(`已核对应用后新增的 ${result.newRequestCount} 条请求。`);
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveBudget = async () => {
    if (!budgetDraft) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await onBudgetSave(budgetDraft);
      setBudgetDraft(saved);
      setMessage("Agent 默认预算已保存，将在下一轮 Run 生效。");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const activeDebug = useMemo(
    () => debugActions.filter((item) => item.status === "applied"),
    [debugActions],
  );

  return (
    <Dialog open={open} title="QA 工作台" kicker="ENVIRONMENT · IMPORTS · INTEGRATIONS · ACTIONS" wide onClose={onClose}>
      <div className="workbench-layout">
        <nav className="workbench-nav">
          <button className={tab === "qa" ? "active" : ""} onClick={() => setTab("qa")}><Check size={15} /> QA 场景</button>
          <button className={tab === "projects" ? "active" : ""} onClick={() => setTab("projects")}><Database size={15} /> 项目空间</button>
          <button className={tab === "environments" ? "active" : ""} onClick={() => setTab("environments")}><Globe2 size={15} /> 环境</button>
          <button className={tab === "business" ? "active" : ""} onClick={() => setTab("business")}><ShieldCheck size={15} /> 业务规则</button>
          <button className={tab === "associations" ? "active" : ""} onClick={() => setTab("associations")}><GitMerge size={15} /> 关联与动态字段</button>
          <button className={tab === "imports" ? "active" : ""} onClick={() => setTab("imports")}><FileJson2 size={15} /> 导入与互操作</button>
          <button className={tab === "integrations" ? "active" : ""} onClick={() => setTab("integrations")}><PlugZap size={15} /> MCP / 平台 / 工单</button>
          <button className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}><Wrench size={15} /> 调试与重放</button>
          <button className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}><Activity size={15} /> 执行记录</button>
        </nav>

        <div className="workbench-content">
          {tab === "qa" && <QAWorkspace selected={selectedRequest} onSelectRequest={onSelectRequest} onChanged={onChanged} />}
          {tab === "projects" && <ProjectWorkspace />}
          {tab === "environments" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">ENVIRONMENT PROFILE</span><h3>项目环境</h3></div></div>
              <div className="form-grid two">
                <label className="field"><span>环境名称</span><input value={environment.name} onChange={(event) => setEnvironment({ ...environment, name: event.target.value })} placeholder="测试环境 / iOS QA" /></label>
                <label className="field"><span>App 版本</span><input value={environment.appVersion} onChange={(event) => setEnvironment({ ...environment, appVersion: event.target.value })} placeholder="5.8.0" /></label>
              </div>
              <div className="form-grid two">
                <label className="field"><span>构建号</span><input value={environment.buildNumber} onChange={(event) => setEnvironment({ ...environment, buildNumber: event.target.value })} placeholder="5821" /></label>
                <label className="field"><span>提取 Header（可选）</span><input placeholder="x-app-version" /></label>
              </div>
              <button className="button primary compact" disabled={busy || !environment.name} onClick={() => void saveConfig("environment", environment.name, environment, true)}><Plus size={13} /> 保存并启用</button>
              <div className="config-list">
                {environments.map((item) => (
                  <div className="config-row" key={item.id}>
                    <div><b>{item.name}</b><span>{item.config.appVersion || "未填写版本"} · {item.config.buildNumber || "未填写构建号"}</span></div>
                    <button className="button ghost compact" onClick={async () => { await call("configs.activate-environment", { configId: item.id }); await onChanged(); }}>启用</button>
                    <button className="rule-icon danger" onClick={async () => { await call("configs.delete", { configId: item.id }); await onChanged(); }}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "business" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">BUSINESS SUCCESS SEMANTICS</span><h3>业务码与错误字段</h3></div></div>
              <div className="form-grid two">
                <label className="field"><span>规则名称</span><input value={business.name} onChange={(event) => setBusiness({ ...business, name: event.target.value })} /></label>
                <label className="field"><span>Host 正则</span><input value={business.hostPattern} onChange={(event) => setBusiness({ ...business, hostPattern: event.target.value })} placeholder="api\\.example\\.com" /></label>
              </div>
              <div className="form-grid two">
                <label className="field"><span>Path 正则</span><input value={business.pathPattern} onChange={(event) => setBusiness({ ...business, pathPattern: event.target.value })} placeholder="/api/order/" /></label>
                <label className="field"><span>HTTP 成功状态</span><input value={business.successStatuses} onChange={(event) => setBusiness({ ...business, successStatuses: event.target.value })} placeholder="200,201" /></label>
              </div>
              <div className="form-grid two">
                <label className="field"><span>业务字段 JSON Pointer</span><input value={business.errorPointer} onChange={(event) => setBusiness({ ...business, errorPointer: event.target.value })} placeholder="/code" /></label>
                <label className="field"><span>成功值</span><input value={business.successValues} onChange={(event) => setBusiness({ ...business, successValues: event.target.value })} placeholder="0,200" /></label>
              </div>
              <button className="button primary compact" disabled={busy || !business.name} onClick={() => void saveConfig("business_rule", business.name, {
                hostPattern: business.hostPattern,
                pathPattern: business.pathPattern,
                successStatuses: business.successStatuses.split(",").map(Number).filter(Boolean),
                errorPointer: business.errorPointer,
                successValues: business.successValues.split(",").map((item) => item.trim()),
              })}><Plus size={13} /> 保存业务规则</button>
              <div className="config-list">
                {businessRules.map((item) => (
                  <div className="config-row" key={item.id}>
                    <div><b>{item.name}</b><span>{item.config.hostPattern || "*"} {item.config.pathPattern || "*"} · {item.config.errorPointer}</span></div>
                    <button className="rule-icon danger" onClick={async () => { await call("configs.delete", { configId: item.id }); await onChanged(); }}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "associations" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">RELATION SEMANTICS</span><h3>关联与动态字段</h3></div></div>
              <div className="config-card">
                <label className="field"><span>业务关联规则名称</span><input value={association.name} onChange={(event) => setAssociation({ ...association, name: event.target.value })} placeholder="订单 ID 关联" /></label>
                <label className="field"><span>字段名</span><input value={association.field} onChange={(event) => setAssociation({ ...association, field: event.target.value })} /></label>
                <button className="button primary compact" disabled={!association.name} onClick={() => void saveConfig("association", association.name, association)}>保存关联规则</button>
              </div>
              <div className="config-card">
                <label className="field"><span>动态字段名称</span><input value={dynamicFields.name} onChange={(event) => setDynamicFields({ ...dynamicFields, name: event.target.value })} /></label>
                <label className="field"><span>忽略正则（逗号分隔）</span><textarea value={dynamicFields.patterns} onChange={(event) => setDynamicFields({ ...dynamicFields, patterns: event.target.value })} /></label>
                <button className="button primary compact" onClick={() => void saveConfig("dynamic_fields", dynamicFields.name, { patterns: dynamicFields.patterns.split(",").map((item) => item.trim()).filter(Boolean) })}>保存字段忽略规则</button>
              </div>
              <div className="config-list">
                {[...associations, ...dynamicConfigs].map((item) => (
                  <div className="config-row" key={item.id}>
                    <div><b>{item.name}</b><span>{item.kind} · {JSON.stringify(item.config)}</span></div>
                    <button className="rule-icon danger" onClick={async () => { await call("configs.delete", { configId: item.id }); await onChanged(); }}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "imports" && (
            <>
              <div className="settings-heading">
                <div><span className="eyebrow">INTEROPERABILITY</span><h3>导入与导出</h3></div>
                <button className="button ghost compact" onClick={async () => {
                  setBusy(true);
                  try {
                    setOpenApiTemplates(await call<Array<Record<string, any>>>("openapi.templates", {}));
                  } catch (reason) {
                    setMessage(String(reason));
                  } finally {
                    setBusy(false);
                  }
                }}><RefreshCw size={13} /> 按路径模板聚合</button>
              </div>
              <div className="import-grid">
                <button onClick={() => void importJson("har")}><Upload size={18} /><b>导入 HAR</b><span>新建批次，保留来源与正文缺失状态</span></button>
                <button onClick={() => void importJson("openapi")}><FileJson2 size={18} /><b>导入 OpenAPI</b><span>本地校验状态码、必填字段和类型</span></button>
                <button onClick={() => void importJson("otlp")}><Activity size={18} /><b>导入 OTLP JSON</b><span>补齐服务端 Span、Links 与采样信息</span></button>
                <button onClick={() => void exportHar()}><Download size={18} /><b>导出原始 HAR</b><span>保留原文；上限2万条/20MiB，附未导出数量</span></button>
              </div>
              <div className="config-list">
                {openApiConfigs.map((item) => (
                  <div className="config-row" key={item.id}>
                    <div><b>OpenAPI · {item.name}</b><span>{Object.keys(item.config.operations || {}).length} 个操作</span></div>
                    <button className="button ghost compact" onClick={async () => {
                      if (!selectedRequest) {
                        setMessage("先在抓包页选择一条请求。");
                        return;
                      }
                      const result = await call<Record<string, any>>("openapi.validate", { requestId: selectedRequest.id, configId: item.id });
                      setMessage(JSON.stringify(result, null, 2));
                    }}>校验选中请求</button>
                  </div>
                ))}
                {imports.map((item) => (
                  <div className="config-row" key={item.id}>
                    <div><b>{item.kind}</b><span>{item.source || "本地导入"} · {JSON.stringify(item.summary)}</span></div>
                    <span className="status-pill active">IMPORTED</span>
                  </div>
                ))}
              </div>
              {openApiTemplates.length > 0 && (
                <div className="template-list">
                  <div className="section-heading"><h3>Path Templates</h3><span>{openApiTemplates.filter((item) => item.openapi).length} matched</span></div>
                  {openApiTemplates.map((item) => (
                    <div className="template-row" key={String(item.endpoint)}>
                      <code>{String(item.endpoint)}</code>
                      <span className={item.openapi ? "status-pill active" : "status-pill"}>
                        {item.openapi?.template || "NO CONTRACT"}
                      </span>
                      {item.openapi?.operationId && <small>{item.openapi.operationId}</small>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === "integrations" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">CONTROLLED INTEGRATIONS</span><h3>MCP、观测平台与工单</h3></div></div>
              <div className="config-card">
                <b>MCP 白名单</b>
                <div className="form-grid three">
                  <label className="field"><span>名称</span><input value={mcp.name} onChange={(event) => setMcp({ ...mcp, name: event.target.value })} /></label>
                  <label className="field"><span>Endpoint</span><input value={mcp.endpoint} onChange={(event) => setMcp({ ...mcp, endpoint: event.target.value })} placeholder="https://…/mcp" /></label>
                  <label className="field"><span>允许工具（逗号）</span><input value={mcp.allowedTools} onChange={(event) => setMcp({ ...mcp, allowedTools: event.target.value })} /></label>
                </div>
                <button className="button primary compact" disabled={!mcp.name || !mcp.endpoint} onClick={async () => {
                  await call("mcp.save", { name: mcp.name, endpoint: mcp.endpoint, allowedTools: mcp.allowedTools.split(",").map((item) => item.trim()).filter(Boolean), enabled: true });
                  await onChanged();
                  setMessage("MCP 服务已保存。");
                }}>保存 MCP 服务</button>
                <div className="config-list">
                  {mcpServers.map((server) => (
                    <button className="config-row selectable" key={server.id} onClick={() => setMcpCall({ ...mcpCall, serverId: server.id, toolName: server.allowedTools[0] || "" })}>
                      <div><b>{server.name}</b><span>{server.endpoint} · {server.allowedTools.join(", ")}</span></div>
                    </button>
                  ))}
                </div>
                <div className="form-grid three">
                  <label className="field"><span>MCP 服务</span><select value={mcpCall.serverId} onChange={(event) => setMcpCall({ ...mcpCall, serverId: event.target.value })}>{mcpServers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  <label className="field"><span>工具名</span><input value={mcpCall.toolName} onChange={(event) => setMcpCall({ ...mcpCall, toolName: event.target.value })} /></label>
                  {debugType === "map-local" && <div className="form-grid two"><label className="field"><span>文件授权会话</span><select value={sharedSessionId} onChange={event => setSharedSessionId(event.target.value)}>{sharedSessions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button className="button ghost compact" disabled={!sharedSessionId || busy} onClick={async () => { try { const path = await pickLocalFile(); if (!path) return; await call("sessions.add-file", { sessionId: sharedSessionId, path }); setDebugPayload(JSON.stringify({ ...JSON.parse(debugPayload), filePath: path }, null, 2)); setMessage("已授权此文件，应用前仍会核对内容摘要。"); } catch (reason) { setMessage(String(reason)); } }}>选择并共享 Mock 文件</button></div>}
              <label className="field"><span>参数 JSON</span><input value={mcpCall.arguments} onChange={(event) => setMcpCall({ ...mcpCall, arguments: event.target.value })} /></label>
                </div>
                <button className="button ghost compact" onClick={async () => {
                  try {
                    const result = await call("mcp.call", { serverId: mcpCall.serverId, toolName: mcpCall.toolName, arguments: JSON.parse(mcpCall.arguments) });
                    setMessage(JSON.stringify(result, null, 2));
                  } catch (reason) {
                    setMessage(String(reason));
                  }
                }}><Send size={13} /> 调用白名单工具</button>
              </div>

              <div className="config-card">
                <b>可观测平台只读查询</b>
                <label className="field"><span>查询 URL（使用 {"{traceId}"} 占位）</span><input value={observability.endpoint} onChange={(event) => setObservability({ ...observability, endpoint: event.target.value })} placeholder="https://platform/api/traces/{traceId}" /></label>
                <div className="form-grid two">
                  <label className="field"><span>Trace ID</span><input value={observability.traceId} onChange={(event) => setObservability({ ...observability, traceId: event.target.value })} /></label>
                  <button className="button ghost compact self-end" onClick={async () => {
                    setBusy(true);
                    try {
                      setObservabilityResult(await call("observability.query", observability));
                    } catch (reason) {
                      setMessage(String(reason));
                    } finally {
                      setBusy(false);
                    }
                  }}><RefreshCw size={13} /> 读取</button>
                </div>
                {observabilityResult && <pre className="result-json">{JSON.stringify(observabilityResult, null, 2)}</pre>}
              </div>

              <div className="config-card">
                <b>创建外部工单（预览后确认）</b>
                <div className="form-grid two">
                  <label className="field"><span>报告</span><select value={ticket.reportId} onChange={(event) => setTicket({ ...ticket, reportId: event.target.value })}>{reports.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
                  <label className="field"><span>Webhook</span><input value={ticket.endpoint} onChange={(event) => setTicket({ ...ticket, endpoint: event.target.value })} /></label>
                </div>
                <div className="settings-actions">
                  <button className="button ghost compact" disabled={!ticket.reportId} onClick={async () => {
                    const result = await call<Record<string, any>>("tickets.preview", ticket);
                    setTicket({ ...ticket, preview: result });
                  }}>预览</button>
                  <button className="button primary compact" disabled={!ticket.reportId || !ticket.endpoint || !ticket.preview?.id || ticket.preview.status !== "preview"} onClick={async () => {
                    const result = await call<Record<string, any>>("tickets.create", { ...ticket, ticketId: ticket.preview?.id });
                    setTicket((value) => ({ ...value, preview: result }));
                    setMessage(`工单状态：${result.status} ${JSON.stringify(result.result)}`);
                  }}>确认创建</button>
                </div>
                {ticket.preview && <pre className="result-json">{JSON.stringify(ticket.preview, null, 2)}</pre>}
              </div>
            </>
          )}

          {tab === "debug" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">PREVIEW · APPROVAL · RESTORE</span><h3>调试变更</h3></div></div>
              <div className="form-grid two">
                <label className="field"><span>操作类型</span><select value={debugType} onChange={(event) => {
                  setDebugType(event.target.value);
                  setDebugPayload(
                    event.target.value === "throttle"
                      ? JSON.stringify(throttle, null, 2)
                      : event.target.value === "map-local"
                        ? '{\n  "source": "https://api.example.com/v1/*",\n  "filePath": "/path/to/mock.json"\n}'
                        : event.target.value === "rewrite"
                          ? '{\n  "source": "https://api.example.com/v1/*",\n  "phase": "request",\n  "part": "header",\n  "action": "set",\n  "headerName": "X-QA",\n  "headerValue": "1"\n}'
                          : '{\n  "source": "https://api.example.com/v1/*",\n  "target": "http://127.0.0.1:3000/v1/"\n}'
                  );
                }}><option value="map-remote">Map Remote</option><option value="map-local">Map Local</option><option value="rewrite">Rewrite</option><option value="throttle">弱网</option></select></label>
                <button className="button ghost compact self-end" onClick={() => void previewDebug()} disabled={busy}><RefreshCw size={13} /> 生成预览</button>
              </div>
              {debugType === "map-local" && <div className="form-grid two"><label className="field"><span>文件授权会话</span><select value={sharedSessionId} onChange={event => setSharedSessionId(event.target.value)}>{sharedSessions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button className="button ghost compact" disabled={!sharedSessionId || busy} onClick={async () => { try { const path = await pickLocalFile(); if (!path) return; await call("sessions.add-file", { sessionId: sharedSessionId, path }); setDebugPayload(JSON.stringify({ ...JSON.parse(debugPayload), filePath: path }, null, 2)); setMessage("已授权此文件，应用前仍会核对内容摘要。"); } catch (reason) { setMessage(String(reason)); } }}>选择并共享 Mock 文件</button></div>}
              <label className="field"><span>参数 JSON</span><textarea className="large-textarea" value={debugPayload} onChange={(event) => setDebugPayload(event.target.value)} /></label>
              {debugAction && (
                <div className="debug-preview">
                  <div className="debug-preview-head"><b>影响与差异</b><span>{debugAction.status}</span></div>
                  <div><b>影响范围</b><p>{debugAction.preview.impact}</p></div>
                  <div className="diff-columns">
                    <pre>{JSON.stringify(debugAction.preview.before, null, 2)}</pre>
                    <pre>{JSON.stringify(debugAction.preview.after, null, 2)}</pre>
                  </div>
                  <div className="settings-actions">
                    <button className="button primary compact" disabled={debugAction.status !== "preview"} onClick={() => void applyDebug()}><Check size={13} /> 应用此版本</button>
                    {debugAction.status === "applied" && <button className="button ghost compact" onClick={() => void restoreDebug(debugAction.id)}><RotateCcw size={13} /> 恢复</button>}
                    {["applied", "restored", "restore-conflict"].includes(debugAction.status) && (
                      <button className="button ghost compact" disabled={busy} onClick={() => void verifyDebug()}><Activity size={13} /> 验证新增抓包</button>
                    )}
                  </div>
                </div>
              )}
              {debugVerification && (
                <div className="debug-preview">
                  <div className="debug-preview-head">
                    <b>操作后抓包验证</b>
                    <span>{new Date(debugVerification.since).toLocaleString("zh-CN")} 起</span>
                  </div>
                  <div className="verification-stats">
                    <span><b>{debugVerification.newRequestCount}</b> 新增请求</span>
                    <span><b>{debugVerification.ruleHitCount}</b> 规则命中</span>
                    <span><b>{debugVerification.failureCount}</b> 失败</span>
                    {debugVerification.sourceIp && <span><b>{debugVerification.sourceIp}</b> 设备</span>}
                  </div>
                  <p>{debugVerification.boundary}</p>
                  <pre className="result-json">{JSON.stringify({
                    statusBreakdown: debugVerification.statusBreakdown,
                    businessBreakdown: debugVerification.businessBreakdown,
                    verificationSteps: debugVerification.verificationSteps,
                    failureSamples: debugVerification.failureSamples.map((item) => ({
                      id: item.id,
                      method: item.method,
                      url: item.url,
                      status: item.status,
                      error: item.error,
                    })),
                  }, null, 2)}</pre>
                </div>
              )}
              <div className="config-card">
                <b>请求重放</b>
                <p>{selectedRequest ? `${selectedRequest.method} ${selectedRequest.url}` : "先在抓包页选择请求。"}</p>
                <div className="settings-actions">
                  <button className="button ghost compact" disabled={!selectedRequest} onClick={() => void previewReplay()}>预览请求</button>
                  <button className="button primary compact" disabled={!selectedRequest || !replay?.id || replay.status !== "preview"} onClick={() => void executeReplay()}>确认发送</button>
                </div>
                {replay && <pre className="result-json">{JSON.stringify(replay, null, 2)}</pre>}
                <div className="settings-note"><ShieldCheck size={14} /><span>重放可能产生业务副作用；超时显示“结果未知”，不会自动重试。</span></div>
              </div>
              <div className="config-list">
                {activeDebug.map((item) => (
                  <div className="config-row" key={item.id}>
                    <div><b>{item.type}</b><span>配置版本 {item.configVersion} · {new Date(item.createdAt).toLocaleString("zh-CN")}</span></div>
                    <button className="button ghost compact" onClick={() => void restoreDebug(item.id)}><RotateCcw size={12} /> 恢复</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "runs" && (
            <>
              <div className="settings-heading"><div><span className="eyebrow">PERSISTED RUNS</span><h3>执行记录</h3></div></div>
              <div className="config-card">
                <b>Agent 默认预算</b>
                <p className="muted small">只限制下一轮 Run；正在执行的 Run 保留启动时预算。继续分析可在原预算上显式调整。</p>
                {budgetDraft && (
                  <>
                    <div className="form-grid three">
                      <label className="field"><span>最大模型步骤</span><input type="number" min={1} max={64} value={budgetDraft.maxSteps} onChange={(event) => setBudgetDraft({ ...budgetDraft, maxSteps: Number(event.target.value) })} /></label>
                      <label className="field"><span>最大工具次数</span><input type="number" min={1} max={256} value={budgetDraft.maxToolCalls} onChange={(event) => setBudgetDraft({ ...budgetDraft, maxToolCalls: Number(event.target.value) })} /></label>
                      <label className="field"><span>最大 Token（0 为不限制）</span><input type="number" min={0} value={budgetDraft.maxTotalTokens} onChange={(event) => setBudgetDraft({ ...budgetDraft, maxTotalTokens: Number(event.target.value) })} /></label>
                    </div>
                    <div className="form-grid three">
                      <label className="field"><span>工具超时（秒）</span><input type="number" min={1} value={budgetDraft.toolTimeoutSeconds} onChange={(event) => setBudgetDraft({ ...budgetDraft, toolTimeoutSeconds: Number(event.target.value) })} /></label>
                      <label className="field"><span>模型请求超时（秒）</span><input type="number" min={1} value={budgetDraft.modelRequestTimeoutSeconds} onChange={(event) => setBudgetDraft({ ...budgetDraft, modelRequestTimeoutSeconds: Number(event.target.value) })} /></label>
                      <label className="field"><span>审批等待（秒）</span><input type="number" min={1} value={budgetDraft.approvalTimeoutSeconds} onChange={(event) => setBudgetDraft({ ...budgetDraft, approvalTimeoutSeconds: Number(event.target.value) })} /></label>
                    </div>
                    <div className="form-grid two">
                      <label className="field"><span>整体超时（秒）</span><input type="number" min={1} value={budgetDraft.totalTimeoutSeconds} onChange={(event) => setBudgetDraft({ ...budgetDraft, totalTimeoutSeconds: Number(event.target.value) })} /></label>
                      <button className="button primary compact self-end" disabled={busy} onClick={() => void saveBudget()}><Check size={13} /> 保存默认预算</button>
                    </div>
                  </>
                )}
              </div>
              <div className="run-table">
                {runs.map((run) => (
                  <button className="run-table-row" key={run.id} onClick={() => onSelectRequest(run.scope.requestVersions?.[0]?.id || "")}>
                    <span className={`run-status ${run.status}`}>{run.status}</span>
                    <div><b>{run.scope.batchLabel || run.batchId}</b><span>{run.id} · {run.mode}</span></div>
                    <span>{run.scope.requestCount} 样本</span>
                    <span>{run.usage.totalTokens || 0} tokens</span>
                    <span>{run.usage.toolCalls || 0} tools</span>
                    <time>{new Date(run.createdAt).toLocaleString("zh-CN")}</time>
                  </button>
                ))}
                {runs.length === 0 && <div className="empty-detail">还没有持久化的 Agent Run。</div>}
              </div>
              <div className="settings-note"><Database size={14} /><span>每个 Run 保存固定范围、模型消息、事件、工具结果、证据、预算与实际 Usage。重启后不会自动重放配置变更。</span></div>
            </>
          )}

          {message && <pre className={`workbench-message ${/失败|错误|未知|拒绝|冲突/.test(message) ? "error" : ""}`}>{message}</pre>}
        </div>
      </div>
    </Dialog>
  );
}
