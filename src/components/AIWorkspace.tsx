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
import { useEffect, useMemo, useRef, useState } from "react";
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
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  onNew: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSettings: () => void;
  onPickFile: () => Promise<void>;
  onApproval: (approvalId: string, approved: boolean) => Promise<void>;
  busy: boolean;
  error: string | null;
  runs: AnalysisRun[];
  activeRunId: string | null;
  reports: Report[];
  events: RunEvent[];
  evidence: Evidence[];
  scope: AnalysisScope | null;
  budget: RunBudget | null;
  usage: RunUsage | null;
  mode: "analysis" | "debug";
  onMode: (mode: "analysis" | "debug") => void;
  scopeChoice: ScopeChoice;
  onScopeChoice: (choice: ScopeChoice) => void;
  onRunSelect: (run: AnalysisRun) => Promise<void>;
  onContinue: (run: AnalysisRun) => Promise<void>;
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
  replay_request: "预览或重放请求",
};

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          const body = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
          return <pre key={index}><code>{body}</code></pre>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

function MessageBody({ message }: { message: Message }) {
  const refs = message.meta.refs ?? [];
  return (
    <div className={`message ${message.role}`}>
      <div className="message-meta">
        <span>{message.role === "user" ? "YOU" : "AGENT"}</span>
        <span>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
        {message.meta.mode && <span>{message.meta.mode.toUpperCase()}</span>}
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
    ["model_step", "tool_call", "tool_result", "approval_required", "approval_resolved", "evidence", "budget_exhausted", "run_failed", "run_stopped", "run_completed"].includes(event.eventType),
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
                event.eventType === "model_step" ? "MODEL STEP" :
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
  events,
  evidence,
  scope,
  budget,
  usage,
  mode,
  onMode,
  scopeChoice,
  onScopeChoice,
  onRunSelect,
  onContinue,
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
  const draftSession = useRef(session.id);
  useEffect(() => {
    if (draftSession.current !== session.id) { draftSession.current = session.id; setText(localStorage.getItem(draftKey) || ""); return; }
    localStorage.setItem(draftKey, text);
  }, [session.id, text]);
  const [providerOpen, setProviderOpen] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [draftReport, setDraftReport] = useState<Report | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const provider = providers.find((item) => item.id === selectedProviderId);
  const currentRun = runs.find((item) => item.id === activeRunId) ?? runs[0] ?? null;
  const sessionApprovals = approvals.filter((item) => item.sessionId === session.id && item.runId === currentRun?.id);
  const report = reports.find((item) => item.id === reportId) ?? null;
  const interrupted = currentRun && ["failed", "stopped", "interrupted", "budget_exhausted"].includes(currentRun.status);
  const facts = useMemo(() => evidence, [evidence]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [session.messages.length, live?.content, live?.tools.length, sessionApprovals.length, currentRun?.status]);

  useEffect(() => {
    if (!report) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`ai-proxy-report-draft:${report.id}`) || "null");
      setDraftReport(saved?.baseUpdatedAt === report.updatedAt ? saved.report : { ...report });
    } catch { setDraftReport({ ...report }); }
  }, [report?.id]);

  useEffect(() => {
    if (!draftReport || !report || draftReport.id !== report.id) return;
    try { localStorage.setItem(`ai-proxy-report-draft:${report.id}`, JSON.stringify({ baseUpdatedAt: report.updatedAt, report: draftReport })); } catch { /* Keep editing when local storage is full. */ }
  }, [draftReport, report?.id, report?.updatedAt]);

  const submit = async () => {
    const content = text.trim();
    if (!content || busy) return;
    setText("");
    setProviderOpen(false);
    await onSend(content);
  };

  const saveReport = async () => {
    if (!draftReport) return;
    await onSaveReport(draftReport);
    setDraftReport({ ...draftReport });
  };

  return (
    <div className="ai-workspace">
      <aside className="session-rail">
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

        <div className="run-history">
          <div className="rail-label"><History size={12} /> 分析记录 / 报告</div>
          {runs.slice(0, 12).map((run) => (
            <button className={`run-history-item ${run.status}`} key={run.id} onClick={() => void onRunSelect(run)}>
              <span>{run.scope.batchLabel || run.batchId || "分析"}</span>
              <small>{run.status} · {new Date(run.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
            </button>
          ))}
          {reports.slice(0, 8).map((item) => (
            <button className="report-history-item" key={item.id} onClick={() => setReportId(item.id)}>
              <FileText size={11} /><span>{item.title}</span>
            </button>
          ))}
        </div>

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
          <div>
            <span className="eyebrow">HARNESSED REACT SESSION</span>
            <h1>{session.title}</h1>
          </div>
          <div className={`agent-state ${live?.status === "running" ? "running" : ""}`}>
            <span className={`live-dot ${live?.status === "running" ? "on" : ""}`} /> {live?.status === "running" ? "Agent 正在执行" : currentRun?.status || "Agent 空闲"}
          </div>
        </div>

        <div className="scope-bar">
          <div className="scope-choice">
            <span>分析范围</span>
            <button className={scopeChoice === "selection" ? "active" : ""} onClick={() => onScopeChoice("selection")}>当前选择</button>
            <button className={scopeChoice === "filter" ? "active" : ""} onClick={() => onScopeChoice("filter")}>当前筛选</button>
            <button className={scopeChoice === "scenario" ? "active" : ""} onClick={() => onScopeChoice("scenario")}>当前场景</button>
          </div>
          <div className="scope-facts">
            <span><b>{scope?.requestCount ?? refs.length}</b> 样本</span>
            <span><b>{scope?.batchCount ?? "—"}</b> 批次总量</span>
            <span>{scope?.devices?.join("、") || "全部设备"}</span>
            <span>{scope?.snapshotAt ? new Date(scope.snapshotAt).toLocaleString("zh-CN") : "发送时固定快照"}</span>
            {scope?.expired && <span className="scope-expired">范围已失效</span>}
          </div>
          <div className="budget-readout">
            <span>步骤 {usage?.requests ?? 0}/{budget?.maxSteps ?? 8}</span>
            <span>工具 {usage?.toolCalls ?? 0}/{budget?.maxToolCalls ?? 24}</span>
            <span>Token {usage?.totalTokens ?? "—"}{budget?.maxTotalTokens ? `/${budget.maxTotalTokens}` : ""}</span>
            {usage?.cost && <span>成本 {usage.cost}</span>}
          </div>
        </div>

        <div className="conversation-scroll" ref={scrollRef}>
          {session.messages.length === 0 && !live && (
            <div className="agent-welcome">
              <div className="welcome-orbit"><Bot size={30} /></div>
              <span className="eyebrow">EVIDENCE-FIRST CAPTURE AGENT</span>
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
                <div><span className="eyebrow">EVIDENCE BOARD</span><h3>本轮引用</h3></div>
                <span>{facts.length} 条有效证据</span>
              </div>
              <div className="evidence-grid">
                {facts.map((item) => (
                  <button className="evidence-card" key={item.id} onClick={() => onEvidence(item.requestId, item.direction, item.locator)}>
                    <span className="evidence-direction">{item.direction}</span>
                    <b>{item.summary}</b>
                    <code>{item.locator}</code>
                    <small>{item.requestId} · v{item.requestVersion} · {item.state === "valid" ? "有效" : `来源失效：${item.state}`}</small>
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
              <button className="button ghost compact" onClick={() => void onContinue(currentRun)}><RefreshCw size={13} /> 继续分析</button>
            </div>
          )}

          {live && (
            <div className="live-message">
              <div className="message assistant">
                <div className="message-meta"><span>AGENT</span><span>LIVE</span></div>
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
                <span className="eyebrow">VERSIONED ACTION REQUIRES APPROVAL</span>
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

          {error && <div className="inline-error">{error}</div>}
        </div>

        <div className="composer-wrap">
          {refs.length > 0 && (
            <div className="composer-refs">
              {refs.map((ref) => (
                <span className="request-ref removable" key={ref.id}>
                  <b>{ref.method}</b> {ref.url ? hostOf(ref.url) : ref.id}
                  <button onClick={() => onRefs(refs.filter((item) => item.id !== ref.id))}><X size={12} /></button>
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
            <button className={`budget-link ${reports.length ? "active" : ""}`} onClick={() => reports[0] && setReportId(reports[0].id)}><FileText size={12} /> 报告 {reports.length || ""}</button>
          </div>
          <div className={`composer ${!provider ? "needs-provider" : ""}`}>
            <textarea
              value={text}
              placeholder={provider ? "描述你要排查、对比或验证的目标…" : "先配置一个供应商，再开始对话"}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              onFocus={() => setProviderOpen(false)}
            />
            <div className="composer-bar">
              <div className="composer-tools">
                <button title="共享本地文件（用于 Map Local）" onClick={() => void onPickFile()}><FilePlus2 size={16} /></button>
                <button title="生成人工测试点" disabled={!refs.length || busy} onClick={() => void onStartChecklist(refs.map((item) => item.id))}><ClipboardCheck size={16} /></button>
                <label className="auto-apply" title="仅调试模式可用；每个变更仍绑定预览版本">
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
                  <button className="send-button stop" title="停止" onClick={() => void onStop()}><Square size={14} fill="currentColor" /></button>
                ) : (
                  <button className="send-button" title="发送" disabled={!text.trim() || !provider} onClick={() => void submit()}><ArrowUp size={17} /></button>
                )}
              </div>
            </div>
          </div>
          <div className="composer-note">Enter 发送 · 固定范围与分析版本 · 工具结果和证据会持久化 · 写操作仅在调试模式注册</div>
        </div>
      </main>

      {report && draftReport && (
        <div className="report-drawer">
          <div className="report-drawer-head">
            <div><span className="eyebrow">REPORT DRAFT</span><input value={draftReport.title} onChange={(event) => setDraftReport({ ...draftReport, title: event.target.value })} /></div>
            <div className="report-actions">
              <button title="复制 Markdown" onClick={() => void navigator.clipboard.writeText(draftReport.content)}><Copy size={14} /></button>
              <button title="导出 Markdown" onClick={() => void onExportReport(draftReport, "markdown")}><Download size={14} /></button>
              <button title="导出 JSON" onClick={() => void onExportReport(draftReport, "json")}><PanelRight size={14} /></button>
              <button title="删除" onClick={() => void onDeleteReport(draftReport)}><Trash2 size={14} /></button>
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
