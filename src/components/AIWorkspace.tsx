import { RunHistory } from "./RunHistory";
import { agentCommands, parseAgentCommand } from "../lib/agentCommands";
import { call, type AgentIssue } from "../lib/api";
import { AgentContextPanel, compressSessionContext, type InputPreview } from "./AgentContextPanel";
import { PanelResize } from "./PanelResize";
import { DiagnosticCopy } from "./DiagnosticCopy";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Download,
  FilePlus2,
  FileText,
  History,
  LoaderCircle,
  PanelRight,
  Paperclip,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AnalysisRun,
  AnalysisScope,
  Approval,
  Evidence,
  Message,
  Provider,
  Report,
  RequestRef,
  RunBudget,
  RunEvent,
  RunUsage,
  Session,
  SessionFile,
  SessionSummary,
  ToolCard,
} from "../types";
import { hostOf } from "../lib/format";

export interface LiveRun {
  content: string;
  tools: ToolCard[];
  status: "running" | "stopped" | "failed" | "completed";
  runId: string;
}

export type ScopeChoice = "selection" | "filter" | "scenario";

interface Props {
  sessions: SessionSummary[];
  session: Session;
  live: LiveRun | null;
  approvals: Approval[];
  providers: Provider[];
  selectedProviderId: string;
  onProvider: (id: string) => void;
  autoApply: boolean;
  onAutoApply: (enabled: boolean) => void;
  refs: RequestRef[];
  onRefs: (refs: RequestRef[]) => void;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onNew: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSettings: () => void;
  onPickFile: () => Promise<void>;
  onApproval: (approvalId: string, approved: boolean) => Promise<void>;
  busy: boolean;
  error: AgentIssue | null;
  runs: AnalysisRun[];
  activeRunId: string | null;
  reports: import("../types").ReportSummary[];
  reportTotal: number;
  events: RunEvent[];
  evidence: Evidence[];
  scope: AnalysisScope | null;
  budget: RunBudget | null;
  usage: RunUsage | null;
  mode: "analysis" | "debug";
  onMode: (mode: "analysis" | "debug") => void;
  scopeChoice: ScopeChoice;
  pendingScopeSummary: string;
  sourceRevision: string;
  onScopeChoice: (choice: ScopeChoice) => void;
  onAdjustScope: () => void;
  onRunSelect: (run: AnalysisRun) => Promise<void>;
  onContinue: (run: AnalysisRun) => Promise<void>;
  onFreshScope: (run: AnalysisRun) => Promise<void>;
  onPreviewContext: (text: string) => Promise<InputPreview>;
  onGenerateReport: (run: AnalysisRun) => Promise<void>;
  onSaveReport: (report: Report) => Promise<void>;
  onDeleteReport: (report: Report) => Promise<void>;
  onExportReport: (report: Report, format: "markdown" | "json") => Promise<void>;
  onEvidence: (requestId: string, direction: string, locator: string | null) => void;
  onOpenWorkbench: (tab?: string) => void;
  onStartChecklist: (requestIds: string[]) => Promise<void>;
}

const TOOL_LABELS: Record<string, string> = {
  query_captured_requests: "分页检索抓包",
  read_captured_request: "读取字段证据",
  aggregate_captured_requests: "聚合接口与失败率",
  compare_captured_requests: "对比请求字段",
  get_related_requests: "查询关联链",
  inspect_business_state: "判断业务状态",
  list_run_evidence: "读取证据列表",
  get_capture_status: "读取代理状态",
  propose_test_checklist: "生成人工验证点",
  create_analysis_report: "生成分析报告",
  preview_debug_action: "预览调试变更",
  apply_debug_action: "应用调试变更",
  restore_debug_action: "恢复调试变更",
  replay_request: "预览或重放请求", get_phone_connection_status: "手机连接诊断", compose_request: "编辑与重复预览",
  get_composed_request_status: "读取重复请求状态", compose_new_request: "新建请求预览", execute_composed_requests: "发送请求预览", preview_advanced_repeat: "高级重复预览",
  execute_advanced_repeat: "执行高级重复", manage_capture_proxy: "管理代理", prepare_phone_connection: "准备手机接入",
  authorize_proxy_address: "来源地址授权", run_local_shell: "本机Shell",
};

const MarkdownText = lazy(() => import("./MarkdownText"));
function InlineText({ text }: { text: string }) {
  return <Suspense fallback={<span>{text}</span>}><MarkdownText text={text} /></Suspense>;
}

function MessageBody({ message }: { message: Message }) {
  const refs = message.meta.refs ?? [];
  return (
    <div className={`message ${message.role}`}>
      <div className="message-meta">
        <span>{message.role === "user" ? "你" : "分析助手"}</span>
        <span>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
        {message.meta.mode && <span>{message.meta.mode === "analysis" ? "仅分析" : message.meta.mode === "debug" ? "调试模式" : message.meta.mode}</span>}
      </div>
      {refs.length > 0 && (
        <div className="message-refs">
          {refs.map((ref) => (
            <span className="request-ref" key={ref.id}>
              <b>{ref.method}</b> {ref.url ? hostOf(ref.url) : ref.id}
            </span>
          ))}
        </div>
      )}
      <div className="message-copy"><InlineText text={message.content} /></div>
    </div>
  );
}

function ToolStrip({ tools }: { tools: ToolCard[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!tools.length) return null;
  return (
    <div className="tool-strip detailed">
      {tools.map((tool) => (
        <div className={`tool-entry ${tool.status}`} key={tool.callId || tool.id}>
          <button className="tool-chip" onClick={() => setOpen(open === tool.id ? null : tool.id)}>
            {tool.status === "running" ? <LoaderCircle size={12} className="spin" /> : tool.status === "done" ? <Wrench size={12} /> : <X size={12} />}
            <span>{TOOL_LABELS[tool.name] || tool.name}</span>
            {tool.durationMs != null && <small>{tool.durationMs} ms</small>}
          </button>
          {open === tool.id && (
            <div className="tool-detail">
              <div><b>状态</b><span>{tool.outcome || tool.status}</span></div>
              <div><b>参数</b><pre>{JSON.stringify(tool.args || {}, null, 2)}</pre></div>
              {tool.result && <div><b>结果</b><pre>{tool.result}</pre></div>}
              {tool.error && <div><b>错误</b><pre>{tool.error}</pre></div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function InvestigationTrace({
  events,
  report,
}: {
  events: RunEvent[];
  report: () => void;
}) {
  const [open, setOpen] = useState(false);
  const visible = events.filter((event) =>
    ["cache_policy", "model_usage", "context_compacted", "model_step", "tool_call", "tool_result", "approval_required", "approval_resolved", "evidence", "budget_exhausted", "run_failed", "run_stopped", "run_completed"].includes(event.eventType),
  );
  if (!visible.length) return null;
  return (
    <div className={`investigation-trace ${open ? "open" : ""}`}>
      <button className="trace-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <History size={13} />
        <span>调查过程 · {visible.length} 个事件</span>
        <small>参数、结果、耗时与错误</small>
      </button>
      {open && (
        <div className="trace-events">
          {visible.map((event) => (
            <div className={`trace-event ${event.eventType} ${event.status || ""}`} key={event.id}>
              <span className="trace-seq">{event.seq}</span>
              <span className="trace-type">{
                event.eventType === "tool_call" ? "TOOL CALL" :
                event.eventType === "tool_result" ? "TOOL RESULT" :
                event.eventType === "model_step" ? "模型输出" :
                event.eventType === "model_usage" ? "模型用量" :
                event.eventType === "cache_policy" ? "缓存策略" :
                event.eventType === "context_compacted" ? "上下文整理" :
                event.eventType === "approval_required" ? "WAIT APPROVAL" :
                event.eventType === "approval_resolved" ? "APPROVAL" :
                event.eventType === "evidence" ? "EVIDENCE" :
                event.eventType.replaceAll("_", " ").toUpperCase()
              }</span>
              <span className="trace-detail">
                {event.eventType === "tool_call" || event.eventType === "tool_result"
                  ? event.payload.toolName
                  : event.eventType === "evidence"
                    ? event.payload.summary
                    : event.eventType === "model_usage"
                      ? `输入 ${event.payload.inputTokens ?? "未知"} / 输出 ${event.payload.outputTokens ?? "未知"} · 缓存读 ${event.payload.cacheReadTokens ?? "未知"} / 写 ${event.payload.cacheWriteTokens ?? "未知"} · 首输出 ${event.payload.firstOutputMs ?? "未知"}ms / 总耗时 ${event.payload.durationMs}ms`
                      : event.payload.message || event.payload.error || event.payload.delta || event.status || ""}
              </span>
              <time>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time>
              {(event.payload.args || event.payload.result) && (
                <details>
                  <summary>查看参数与结果</summary>
                  <pre>{JSON.stringify({ args: event.payload.args, result: event.payload.result }, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
          <button className="button ghost compact" onClick={report}><FileText size={13} /> 从本轮执行生成报告</button>
        </div>
      )}
    </div>
  );
}

export function AIWorkspace({
  sessions,
  session,
  live,
  approvals,
  providers,
  selectedProviderId,
  onProvider,
  autoApply,
  onAutoApply,
  refs,
  onRefs,
  onSend,
  onStop,
  onNew,
  onSelect,
  onDelete,
  onSettings,
  onPickFile,
  onApproval,
  busy,
  error,
  runs,
  activeRunId,
  reports,
  reportTotal,
  events,
  evidence,
  scope,
  budget,
  usage,
  mode,
  onMode,
  scopeChoice,
  pendingScopeSummary,
  sourceRevision,
  onScopeChoice,
  onAdjustScope,
  onRunSelect,
  onContinue,
  onFreshScope,
  onPreviewContext,
  onGenerateReport,
  onSaveReport,
  onDeleteReport,
  onExportReport,
  onEvidence,
  onOpenWorkbench,
  onStartChecklist,
}: Props) {
  const draftKey = `ai-proxy-draft:${session.id}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) || "");
  const visibleSession = useRef(session.id); visibleSession.current = session.id;
  const draftSession = useRef(session.id);
  useEffect(() => {
    if (draftSession.current !== session.id) { draftSession.current = session.id; setText(localStorage.getItem(draftKey) || ""); return; }
    try { localStorage.setItem(draftKey, text); } catch { /* Keep the current input editable when disk quota is exhausted. */ }
  }, [session.id, text]);
  const [providerOpen, setProviderOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem("ai-proxy-rail-collapsed") === "true");
  const [reportId, setReportId] = useState<string | null>(null);
  const [draftReport, setDraftReport] = useState<Report | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const submitting = useRef(false);
  const scrollSession = useRef(session.id);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    let saved: {top: number; follow: boolean} | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(`ai-proxy-reading:${session.id}`) || "null"); } catch { /* Start at the latest message when no position exists. */ }
    scrollSession.current = session.id;
    followOutput.current = saved?.follow ?? true;
    node.scrollTop = saved && !saved.follow ? saved.top : node.scrollHeight;
    setNewContent(false);
  }, [session.id, activeRunId]);
  const [sending, setSending] = useState(false);
  const [commandMessage, setCommandMessage] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const commandQuery = text.trim().toLowerCase();
  const suggestions = !commandDismissed && commandQuery.startsWith("/") && !commandQuery.startsWith("//") && !/\s/.test(commandQuery)
    ? agentCommands.filter(item => [item.name, ...item.aliases, item.label].some(value => value.includes(commandQuery === "/" ? "" : commandQuery))) : [];
  const chooseCommand = (name: string) => { setText(name); setCommandDismissed(true); setCommandIndex(0); inputRef.current?.focus(); };
  useEffect(() => { setCommandMessage(""); setCommandDismissed(false); setCommandIndex(0); }, [session.id]);
  const [stopping, setStopping] = useState(false);
  const [newContent, setNewContent] = useState(false);
  const provider = providers.find((item) => item.id === selectedProviderId);
  const currentRun = runs.find((item) => item.id === activeRunId) ?? runs[0] ?? null;
  const sessionApprovals = approvals.filter((item) => item.sessionId === session.id && item.runId === currentRun?.id);
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState("");
  const reportUpdated = reports.find(item => item.id === reportId)?.updatedAt;
  useEffect(() => {
    let live = true; setReport(null); setDraftReport(null); setReportError("");
    if (reportId) void call<Report>("reports.get", {reportId}).then(value => {
      if (live && visibleSession.current === session.id && value.sessionId === session.id) setReport(value);
    }).catch(reason => { if (live && visibleSession.current === session.id) setReportError(String(reason)); });
    return () => { live = false; };
  }, [reportId, session.id, reportUpdated]);
  useEffect(() => { setReportId(null); }, [session.id]);
  const interrupted = currentRun && ["failed", "stopped", "interrupted", "budget_exhausted"].includes(currentRun.status);
  const facts = useMemo(() => evidence, [evidence]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followOutput.current) node.scrollTop = node.scrollHeight;
    else if (node) setNewContent(true);
  }, [session.messages.length, live?.content, live?.tools.length, sessionApprovals.length, currentRun?.status]);

  useEffect(() => {
    if (!report) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`ai-proxy-report-draft:${report.id}`) || "null");
      setDraftReport(saved?.baseUpdatedAt === report.updatedAt ? saved.report : { ...report });
    } catch { setDraftReport({ ...report }); }
  }, [report?.id, report?.updatedAt]);

  useEffect(() => {
    if (!draftReport || !report || draftReport.id !== report.id) return;
    try { localStorage.setItem(`ai-proxy-report-draft:${report.id}`, JSON.stringify({ baseUpdatedAt: report.updatedAt, report: draftReport })); } catch { /* Keep editing when local storage is full. */ }
  }, [draftReport, report?.id, report?.updatedAt]);

  const submit = async () => {
    const original = text.trim();
    if (!original || submitting.current) return;
    const parsed = parseAgentCommand(original);
    if (parsed.kind === "error") { setCommandMessage(parsed.message); return; }
    if (busy && (parsed.kind === "text" || parsed.command.idle)) { setCommandMessage("请先等待或停止当前任务。"); return; }
    submitting.current = true; setSending(true); setProviderOpen(false); setCommandDismissed(true);
    const sentSession = session.id;
    const valid = () => visibleSession.current === sentSession;
    try {
      setCommandMessage("");
      let accepted = true;
      if (parsed.kind === "command") {
        switch (parsed.command.name) {
          case "/help": onOpenWorkbench("help"); break;
          case "/stop": await onStop(); break;
          case "/new": await onNew(); break;
          case "/compress": {
            const value = await compressSessionContext(sentSession);
            if (valid()) setCommandMessage(value.message || "压缩完成"); break;
          }
          case "/context": window.dispatchEvent(new Event("ai-proxy-open-context")); break;
          case "/sessions": setRailCollapsed(false); localStorage.setItem("ai-proxy-rail-collapsed", "false"); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".session-select")?.focus()); break;
          case "/models": if (providers.length) setProviderOpen(true); else onSettings(); break;
        }
      } else accepted = await onSend(parsed.text);
      if (accepted && valid()) {
        setText(value => value.trim() === original ? "" : value);
        followOutput.current = true;
        try { sessionStorage.setItem(`ai-proxy-reading:${sentSession}`, JSON.stringify({top: 0, follow: true})); } catch { /* Input remains usable without storage. */ }
      }
    } catch (reason) { if (valid()) setCommandMessage(String(reason)); }
    finally { submitting.current = false; setSending(false); }
  };

  const saveReport = async () => {
    if (!draftReport) return;
    await onSaveReport(draftReport);
    setDraftReport({ ...draftReport });
  };

  return (
    <div className={`ai-workspace ${railCollapsed ? "rail-collapsed" : ""}`}>
      <aside className="session-rail">
        <PanelResize name="调整会话列表宽度" variable="--rail-width" initial={18} />
        <div className="rail-head">
          <span>会话</span>
          <button className="icon-action small" title="新会话" onClick={() => void onNew()}><Plus size={16} /></button>
        </div>
        <button className="new-chat" onClick={() => void onNew()}><Plus size={14} /> 新会话</button>
        <div className="session-list">
          {sessions.map((item) => (
            <div className={`session-item ${item.id === session.id ? "active" : ""}`} key={item.id}>
              <button className="session-select" onClick={() => void onSelect(item.id)}>
                <span className="session-title">{item.title}</span>
                <span className="session-time">{new Date(item.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</span>
              </button>
              {sessions.length > 1 && (
                <button className="session-delete" title="删除会话" disabled={busy} onClick={() => void onDelete(item.id)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>

        <RunHistory key={session.id} sessionId={session.id} revision={JSON.stringify([runs.map(run => [run.id, run.status]), activeRunId])} reports={reports} reportTotal={reportTotal} onRun={onRunSelect} onReport={setReportId} />

        <div className="rail-footer">
          <div className="file-stack">
            <div className="rail-label"><Paperclip size={12} /> 已共享文件</div>
            {session.files.length === 0 ? (
              <span className="muted small">Map Local 文件会出现在这里</span>
            ) : session.files.map((file: SessionFile) => (
              <div className="shared-file" key={file.id} title={file.path}>{file.path.split("/").pop()}</div>
            ))}
          </div>
          <button className="settings-link" onClick={() => onOpenWorkbench("debug")}><ShieldCheck size={15} /> 调试操作与恢复</button>
          <button className="settings-link" onClick={onSettings}><Settings2 size={15} /> 供应商与设置</button>
        </div>
      </aside>

      <main className="conversation">
        <div className="conversation-head">
          <button className="button ghost compact" onClick={() => setRailCollapsed(current => { localStorage.setItem("ai-proxy-rail-collapsed", String(!current)); return !current; })}>{railCollapsed ? "展开会话列表" : "收起会话列表"}</button>
          <div>
            <h1 title={session.title}>{session.title}</h1>
          </div>
          <div className={`agent-state ${live?.status === "running" ? "running" : ""}`}>
            <span className={`live-dot ${live?.status === "running" ? "on" : ""}`} /> {busy ? ({ waiting_approval: "等待你的批准", executing_tool: "查询工具", preparing: "准备样本", running: "等待模型 / 整理结论" } as Record<string, string>)[currentRun?.status || "running"] || "调查进行中" : ({completed: "分析完成", failed: "执行失败", stopped: "已停止", interrupted: "运行已中断", budget_exhausted: "预算已用尽"} as Record<string, string>)[currentRun?.status || ""] || "等待输入"}
          </div>
        </div>

        <AgentContextPanel key={`${session.id}:${selectedProviderId}:${provider?.protocol}:${provider?.baseUrl}:${provider?.model}`} sessionId={session.id} runId={currentRun?.id} busy={busy} providerId={selectedProviderId}
          inputRevision={JSON.stringify([text, refs, pendingScopeSummary, sourceRevision, selectedProviderId, mode, currentRun?.id, currentRun?.status])} onPreview={() => onPreviewContext(text)} />
        {commandMessage && <p className="command-feedback" role="status">{commandMessage}</p>}
        <div className="scope-bar">
          <div className="scope-choice">
            <span>分析范围</span>
            <button className={scopeChoice === "selection" ? "active" : ""} onClick={() => onScopeChoice("selection")}>当前选择</button>
            <button className={scopeChoice === "filter" ? "active" : ""} onClick={() => onScopeChoice("filter")}>当前筛选</button>
            <button className={scopeChoice === "scenario" ? "active" : ""} onClick={() => onScopeChoice("scenario")}>当前场景</button>
          </div>
          <p className="boundary-note">本次发送：{pendingScopeSummary}。发送时按当前条件固定快照，实际纳入数量以新 Run 为准；续查沿用所选 Run 的原范围。筛选/场景分析排除仍在进行中的请求并记录数量；手选请求需全部完成。</p>
          <div className="scope-facts">
            <span>所选 Run 快照</span>
            <span><b>{scope?.requestCount ?? refs.length}</b> 样本</span>
            <span><b>{scope?.batchCount ?? "—"}</b> 批次总量</span>
            <span>{scope?.devices?.join("、") || "全部设备"}</span>
            <span>{scope?.snapshotAt ? new Date(scope.snapshotAt).toLocaleString("zh-CN") : "发送时固定快照"}</span>
            {!!scope?.excludedUnfinishedCount && <span>快照排除 {scope.excludedUnfinishedCount} 条进行中请求（原匹配 {scope.matchedCountAtCreation} 条）</span>}
            {scope?.expired && <span className="scope-expired">范围已失效</span>}
          </div>
          <div className="budget-readout">
            <span>步骤 {usage?.requests ?? 0}/{budget?.maxSteps ?? 8}</span>
            <span>工具 {usage?.toolCalls ?? 0}/{budget?.maxToolCalls ?? 24}</span>
            <span>Token {usage?.totalTokens ?? "—"}{budget?.maxTotalTokens ? `/${budget.maxTotalTokens}` : ""}</span>
            <span title="由供应商返回的用量；未报告时显示未知">缓存读 {usage?.cacheReadTokens ?? "未知"} / 写 {usage?.cacheWriteTokens ?? "未知"}</span>
            {usage?.cost && <span>成本 {usage.cost}</span>}
          </div>
        </div>

        <div className="conversation-scroll" ref={scrollRef} onScroll={() => {
          const node = scrollRef.current;
          if (!node) return;
          followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
          if (followOutput.current) setNewContent(false);
          try { sessionStorage.setItem(`ai-proxy-reading:${scrollSession.current}`, JSON.stringify({top: node.scrollTop, follow: followOutput.current})); } catch { /* Reading remains available without position persistence. */ }
        }}>
          {session.messages.length === 0 && !live && (
            <div className="agent-welcome">
              <div className="welcome-orbit"><Bot size={30} /></div>
              <span className="eyebrow">基于证据的抓包分析</span>
              <h2>让每个结论都能回到原请求。</h2>
              <p>先固定批次、设备和时间范围，再让 Agent 分页检索、按字段读取、聚合与对比。默认只读，调试变更必须预览和审批。</p>
              <div className="prompt-examples">
                <button onClick={() => setText("定位当前范围内的失败请求，先区分网络、TLS、HTTP、规则和业务错误。")}>排查失败请求</button>
                <button onClick={() => setText("按接口聚合并定位最慢的请求，给出 P95、样本量、弱网/Mock影响和下一步采集建议。")}>寻找慢接口</button>
                <button onClick={() => setText("识别重复请求、轮询和重试候选，并说明证据边界。")}>识别重复模式</button>
                <button onClick={() => setText("生成一份缺陷报告草稿，分为事实、候选原因、验证步骤和数据缺口。")}>生成缺陷报告</button>
              </div>
            </div>
          )}

          {session.messages.map((message) => (
            <div key={message.id}>
              <MessageBody message={message} />
              {message.meta.tools && <ToolStrip tools={message.meta.tools} />}
            </div>
          ))}

          {currentRun && (
            <InvestigationTrace
              events={events}
              report={() => void onGenerateReport(currentRun)}
            />
          )}

          {facts.length > 0 && (
            <div className="evidence-board">
              <div className="evidence-board-head">
                <div><span className="eyebrow">引用与证据</span><h3>本轮引用</h3></div>
                <span>{facts.filter(item => item.state === "valid").length} 条有效 · {facts.filter(item => item.state !== "valid").length} 条失效</span>
              </div>
              <div className="evidence-grid">
                {facts.map((item) => (
                  <button className={`evidence-card ${item.state !== "valid" ? "stale" : ""}`} key={item.id}
                    disabled={item.state === "deleted"} onClick={() => onEvidence(item.requestId, item.direction, item.locator)}>
                    <span className="evidence-direction">{item.direction}</span>
                    <b>{item.summary}</b>
                    <code>{item.locator}</code>
                    <small>{item.requestId} · v{item.requestVersion} · {item.state === "valid" ? "有效" : item.state === "deleted" ? "原请求已删除，保留历史引用" : item.state === "stale-comparison" ? "对比样本已变化，请重新核对" : "原请求已更新，请重新核对"}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {interrupted && (
            <div className="interrupted-card">
              <ShieldAlert size={18} />
              <div>
                <b>本轮为部分结果</b>
                <span>{currentRun.statusDetail || "运行未完整结束，已获得的工具结果和证据仍然保留。"}</span>
              </div>
              <button className="button ghost compact" onClick={() => void onContinue(currentRun)}><RefreshCw size={13} /> 继续原快照</button>
              <button className="button ghost compact" disabled={busy} title="按原筛选、选择或场景重新固定当前版本，创建新的模型分析任务；保留旧记录" onClick={() => void onFreshScope(currentRun)}>按原条件创建新快照分析</button>
            </div>
          )}

          {live && (
            <div className="live-message">
              <div className="message assistant">
                <div className="message-meta"><span>分析助手</span><span>实时输出</span></div>
                <div className="message-copy">
                  {live.content ? <InlineText text={live.content} /> : <span className="thinking"><i /><i /><i /></span>}
                </div>
              </div>
              <ToolStrip tools={live.tools} />
            </div>
          )}

          {sessionApprovals.map((approval) => (
            <div className="approval-card" key={approval.approvalId}>
              <div className="approval-icon"><ShieldAlert size={18} /></div>
              <div className="approval-copy">
                <span className="eyebrow">请审批本次变更</span>
                <h3>{approval.summary}</h3>
                <p>{approval.impact || "这会立即修改代理配置。"} {approval.restore || "已生效的修改不会因停止 Agent 自动撤销。"}</p>
                {approval.configVersion && <code>配置版本 {approval.configVersion}</code>}
                <details><summary>查看参数</summary><pre>{JSON.stringify(approval.args, null, 2)}</pre></details>
              </div>
              <div className="approval-actions">
                <button className="button ghost compact" onClick={() => void onApproval(approval.approvalId, false)}><X size={14} /> 拒绝</button>
                <button className="button primary compact" onClick={() => void onApproval(approval.approvalId, true)}><Check size={14} /> 允许执行</button>
              </div>
            </div>
          ))}

          {error && <div className="inline-error" role="alert">{error.message}
            <p>草稿与引用已保留。{error.outcomeUnknown || error.code === "receipt_unknown" ? "回执未知，请先核对执行记录与实际结果，避免重复发送。" : error.code.startsWith("scope_") ? "请等待所选请求结束或调整范围；旧结果仍按原快照保留。" : error.code.startsWith("provider_") ? "请核对供应商、密钥、模型权限及账户用量。" : error.code === "timeout" ? "等待已超时，请先查看执行状态，再决定继续或重试。" : "请检查本次操作前置条件和执行记录。"}</p>
            {currentRun && ["scope_expired", "scope_invalid"].includes(error.code) && <button className="button ghost compact" disabled={busy} onClick={() => void onFreshScope(currentRun)}>按原条件创建新快照分析</button>}
            {error.code.startsWith("scope_") && <button className="button ghost compact" onClick={onAdjustScope}>重新选择请求 / 调整场景</button>}
            {(error.code.startsWith("scope_") || error.code === "original_task_missing") && <button className="button ghost compact" onClick={() => {
              const target = session.id;
              if (!currentRun) { setCommandMessage("请直接在输入框指定原问题；未调用模型。"); inputRef.current?.focus(); return; }
              void call<{sessionId: string; text: string}>("agent.original-task", {runId: currentRun.id}).then(original => {
                if (visibleSession.current !== target || original.sessionId !== target) return;
                setText(original.text); setCommandMessage("已复制原任务问题；请核对范围后发送。"); inputRef.current?.focus();
              }).catch(reason => { if (visibleSession.current === target) setCommandMessage(String(reason)); });
            }}>复制保存的问题到输入框</button>}
            {error.code.startsWith("provider_") && <button className="button ghost compact" onClick={onSettings}>检查供应商配置</button>}
            <button className="button ghost compact" onClick={() => onOpenWorkbench("runs")}>查看执行记录</button><DiagnosticCopy area="agent" runId={currentRun?.id} status={currentRun?.status} />
          </div>}
        </div>

        {newContent && <button className="new-output" onClick={() => {
          followOutput.current = true;
          setNewContent(false);
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }}>有新内容 · 回到底部</button>}
        <div className="composer-wrap">
          {refs.length > 0 && (
            <div className="composer-refs">
              {refs.map((ref) => (
                <span className="request-ref removable" key={ref.id}>
                  <b>{ref.method}</b> {ref.url ? hostOf(ref.url) : ref.id}
                  <button title="移除此引用" aria-label="移除此引用" onClick={() => onRefs(refs.filter((item) => item.id !== ref.id))}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-controls">
            <div className="mode-switch">
              <button className={mode === "analysis" ? "active" : ""} onClick={() => onMode("analysis")}><ShieldCheck size={12} /> 仅分析</button>
              <button className={mode === "debug" ? "active" : ""} onClick={() => onMode("debug")}><Wrench size={12} /> 允许调试操作</button>
            </div>
            <button className="budget-link" onClick={() => onOpenWorkbench("runs")}><ClipboardCheck size={12} /> 预算与执行记录</button>
            <button className={`budget-link ${reportTotal ? "active" : ""}`} onClick={() => reports[0] && setReportId(reports[0].id)}><FileText size={12} /> 报告 {reportTotal || ""}</button>
          </div>
          <p className="boundary-note">发送至 {provider ? `${provider.name} · ${provider.model} · ${provider.baseUrl}` : "尚未选择的供应商"}；按上方本次发送条件创建固定范围，可能产生模型费用。</p>
          <div className={`composer ${!provider ? "needs-provider" : ""}`}>
            {suggestions.length > 0 && <div id="agent-command-list" className="agent-command-list" role="listbox" aria-label="本地命令">
              {suggestions.map((item, index) => <button type="button" id={`agent-command-${index}`} role="option" aria-selected={index === Math.min(commandIndex, suggestions.length-1)} key={item.name} disabled={busy && item.idle}
                onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(item.name)}><b>{item.name}</b><span>{item.label} · {busy && item.idle ? "请先停止或等待" : item.description}</span></button>)}
            </div>}
            <textarea
              ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls="agent-command-list"
              aria-activedescendant={suggestions.length ? `agent-command-${Math.min(commandIndex, suggestions.length-1)}` : undefined}
              value={text}
              placeholder={provider ? "描述你要排查、对比或验证的目标…" : "可输入 / 使用本地命令；模型分析需配置供应商"}
              onChange={(event) => { setText(event.target.value); setCommandDismissed(false); setCommandIndex(0); }}
              onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={(event) => {
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (suggestions.length && ["ArrowDown", "ArrowUp", "Tab", "Escape", "Enter"].includes(event.key) && !event.shiftKey) {
                  event.preventDefault();
                  if (event.key === "Escape") setCommandDismissed(true);
                  else if (event.key === "ArrowDown" || event.key === "ArrowUp") setCommandIndex(value => (value+(event.key === "ArrowDown" ? 1 : suggestions.length-1)) % suggestions.length);
                  else { const item = suggestions[Math.min(commandIndex, suggestions.length-1)]; if (!busy || !item.idle) chooseCommand(item.name); }
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
              }}
              onFocus={() => setProviderOpen(false)}
            />
            <div className="composer-bar">
              <div className="composer-tools">
                <button title="共享本地文件（用于 Map Local）" onClick={() => void onPickFile()}><FilePlus2 size={16} /></button>
                <button title="生成人工测试点" disabled={!refs.length || busy} onClick={() => void onStartChecklist(refs.map((item) => item.id))}><ClipboardCheck size={16} /></button>
                <label className="auto-apply" title="仅调试模式可用；规则/弱网绑定预览版本；新增Shell、代理、手机许可和批量发送始终人工批准">
                  <input type="checkbox" disabled={mode !== "debug"} checked={autoApply} onChange={(event) => onAutoApply(event.target.checked)} />
                  <span>{mode === "debug" ? "本会话自动执行已预览变更" : "只读模式"}</span>
                </label>
              </div>
              <div className="composer-send">
                <div className="provider-picker">
                  <button className="provider-trigger" onClick={() => setProviderOpen((value) => !value)}>
                    {provider?.name || "未配置供应商"} <ChevronDown size={13} />
                  </button>
                  {providerOpen && (
                    <div className="provider-menu">
                      {providers.length === 0 ? (
                        <button onClick={onSettings}><Settings2 size={14} /> 配置供应商</button>
                      ) : providers.map((item) => (
                        <button className={item.id === selectedProviderId ? "selected" : ""} key={item.id} onClick={() => { onProvider(item.id); setProviderOpen(false); }}>
                          <span>{item.name}</span><small>{item.model}</small>
                        </button>
                      ))}
                      {providers.length > 0 && <button className="menu-footer" onClick={onSettings}><Settings2 size={13} /> 管理供应商</button>}
                    </div>
                  )}
                </div>
                {busy ? (
                  <button className="send-button stop" title="停止" aria-label="停止分析" disabled={stopping} onClick={async () => { setStopping(true); try { await onStop(); } finally { setStopping(false); } }}><Square size={14} fill="currentColor" /></button>
                ) : (
                  <button className="send-button" title="发送" aria-label="发送分析请求" disabled={sending || !text.trim() || !provider && !text.trim().startsWith("/")} onClick={() => void submit()}>{sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} />}</button>
                )}
              </div>
            </div>
          </div>
          <div className="composer-note">输入 / 查看本地命令 · // 发送普通斜杠文本 · Enter 发送 · 写操作仅在调试模式注册</div>
        </div>
      </main>

      {reportError && <p role="alert">{reportError}<button onClick={() => setReportId(null)}>关闭报告</button></p>}
      {reportId && !report && !reportError && <p role="status">正在读取报告正文…<button onClick={() => setReportId(null)}>取消查看</button></p>}
      {report && draftReport && (
        <div className="report-drawer">
          <div className="report-drawer-head">
            <div><span className="eyebrow">报告草稿</span><input value={draftReport.title} onChange={(event) => setDraftReport({ ...draftReport, title: event.target.value })} /></div>
            <div className="report-actions">
              <button title="复制 Markdown" onClick={() => void navigator.clipboard.writeText(draftReport.content)}><Copy size={14} /></button>
              <button title="导出 Markdown" onClick={() => void onExportReport(draftReport, "markdown")}><Download size={14} /></button>
              <button title="导出 JSON" onClick={() => void onExportReport(draftReport, "json")}><PanelRight size={14} /></button>
              <button title="删除" onClick={() => void onDeleteReport(draftReport).then(() => setReportId(null)).catch(reason => setReportError(String(reason)))}><Trash2 size={14} /></button>
              <button title="关闭" onClick={() => setReportId(null)}><X size={15} /></button>
            </div>
          </div>
          <div className="report-meta">
            <span>{draftReport.scope?.batchLabel}</span>
            <span>{draftReport.scope?.requestCount} 条样本</span>
            <span>{draftReport.status}</span>
          </div>
          <textarea value={draftReport.content} onChange={(event) => setDraftReport({ ...draftReport, content: event.target.value })} />
          <div className="report-footer">
            <button className="button ghost" onClick={() => setDraftReport({ ...report })}>还原</button>
            <button className="button ghost" onClick={() => void onGenerateReport(currentRun!)} disabled={!currentRun}><FileText size={13} /> 从当前 Run 重新生成</button>
            <button className="button primary" onClick={() => void saveReport()}><Check size={13} /> 保存草稿</button>
          </div>
        </div>
      )}
    </div>
  );
}
