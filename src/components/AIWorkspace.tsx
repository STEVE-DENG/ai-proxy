import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  FilePlus2,
  LoaderCircle,
  Paperclip,
  Plus,
  Settings2,
  ShieldAlert,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  Approval,
  Message,
  Provider,
  RequestRef,
  Session,
  SessionFile,
  SessionSummary,
  ToolCard,
} from "../types";
import { hostOf } from "../lib/format";

export interface LiveRun {
  content: string;
  tools: ToolCard[];
  status: "running" | "stopped";
  runId: string;
}

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
}

const TOOL_LABELS: Record<string, string> = {
  list_captured_requests: "检索抓包",
  read_captured_request: "读取请求",
  compare_captured_requests: "对比请求",
  get_capture_status: "读取代理状态",
  start_capture: "启动代理",
  set_recording_paused: "切换记录状态",
  decrypt_host: "修改解密范围",
  list_rules: "读取规则",
  list_shared_files: "读取共享文件",
  map_local: "添加 Map Local",
  map_remote: "添加 Map Remote",
  add_rewrite_rule: "添加 Rewrite",
  set_proxy_throttle: "修改弱网",
  set_mac_system_proxy: "修改系统代理",
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
  if (!tools.length) return null;
  return (
    <div className="tool-strip">
      {tools.map((tool) => (
        <div className={`tool-chip ${tool.status}`} key={tool.id} title={tool.error || tool.result || ""}>
          {tool.status === "running" ? <LoaderCircle size={12} className="spin" /> : tool.status === "error" ? <X size={12} /> : <Wrench size={12} />}
          <span>{TOOL_LABELS[tool.name] || tool.name}</span>
        </div>
      ))}
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
}: Props) {
  const [text, setText] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const provider = providers.find((item) => item.id === selectedProviderId);
  const sessionApprovals = approvals.filter((item) => item.sessionId === session.id);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [session.messages.length, live?.content, live?.tools.length, sessionApprovals.length]);

  const submit = async () => {
    const content = text.trim();
    if (!content || busy) return;
    setText("");
    setProviderOpen(false);
    await onSend(content);
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
        <div className="rail-footer">
          <div className="file-stack">
            <div className="rail-label"><Paperclip size={12} /> 已共享文件</div>
            {session.files.length === 0 ? (
              <span className="muted small">Map Local 文件会出现在这里</span>
            ) : session.files.map((file: SessionFile) => (
              <div className="shared-file" key={file.id} title={file.path}>{file.path.split("/").pop()}</div>
            ))}
          </div>
          <button className="settings-link" onClick={onSettings}><Settings2 size={15} /> 供应商与设置</button>
        </div>
      </aside>

      <main className="conversation">
        <div className="conversation-head">
          <div>
            <span className="eyebrow">DEBUG SESSION</span>
            <h1>{session.title}</h1>
          </div>
          <div className={`agent-state ${live?.status === "running" ? "running" : ""}`}>
            <span className={`live-dot ${live?.status === "running" ? "on" : ""}`} /> {live?.status === "running" ? "Agent 正在执行" : "Agent 空闲"}
          </div>
        </div>

        <div className="conversation-scroll" ref={scrollRef}>
          {session.messages.length === 0 && !live && (
            <div className="agent-welcome">
              <div className="welcome-orbit"><Bot size={30} /></div>
              <span className="eyebrow">CAPTURE-AWARE AGENT</span>
              <h2>让请求自己说出问题。</h2>
              <p>选中一条抓包记录交给 AI，或直接描述你正在排查的接口。Agent 可以查流量、建规则、开弱网，但改动配置前会先向你确认。</p>
              <div className="prompt-examples">
                <button onClick={() => setText("分析当前这条请求为什么失败，先查真实抓包记录。")}>排查失败请求</button>
                <button onClick={() => setText("列出当前批次的接口，定位响应最慢的请求。")}>寻找慢接口</button>
                <button onClick={() => setText("准备一条 Map Local 规则，把某个接口映射到我共享的 JSON 文件。")}>设计 Mock 规则</button>
              </div>
            </div>
          )}

          {session.messages.map((message) => (
            <div key={message.id}>
              <MessageBody message={message} />
              {message.meta.tools && <ToolStrip tools={message.meta.tools} />}
            </div>
          ))}

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
                <span className="eyebrow">ACTION REQUIRES APPROVAL</span>
                <h3>{approval.summary}</h3>
                <p>这会立即修改代理配置。已经生效的修改不会因为停止 Agent 自动撤销。</p>
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
          <div className={`composer ${!provider ? "needs-provider" : ""}`}>
            <textarea
              ref={textAreaRef}
              value={text}
              placeholder={provider ? "描述你要抓、查或改的请求…" : "先配置一个供应商，再开始对话"}
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
                <label className="auto-apply" title="本会话中后续配置修改不再逐条确认">
                  <input type="checkbox" checked={autoApply} onChange={(event) => onAutoApply(event.target.checked)} />
                  <span>本会话自动执行变更</span>
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
          <div className="composer-note">Enter 发送 · Shift + Enter 换行 · 抓包正文发送给供应商前会脱敏常见凭证</div>
        </div>
      </main>
    </div>
  );
}
