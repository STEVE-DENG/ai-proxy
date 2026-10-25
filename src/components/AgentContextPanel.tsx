import { useEffect, useRef, useState } from "react";
import { call } from "../lib/api";
interface ModelWindow { contextTokens: number; outputReserve: number; source: string }
interface ContextStatus {
  settings: { maxTokens: number; maxMessages: number }; estimatedTokens: number;
  savedMessages: number; nextMessages: number; nextEstimatedTokens: number;
  modelWindow?: ModelWindow; notice: string; error?: string; message?: string;
}
export interface InputPreview {
  parts: Record<string, number>; estimatedInputTokens: number; modelWindow: ModelWindow;
  estimatedRemaining: number | null; estimatedPercent: number | null; exceedsEstimate: boolean;
  scopeCount: number; snapshotAt: number; notice: string; fingerprint: string;
}
export async function compressSessionContext(sessionId: string) {
  const result = await call<ContextStatus>("agent.compress", { sessionId });
  window.dispatchEvent(new CustomEvent("ai-proxy-context-changed", { detail: sessionId }));
  return result;
}
export function AgentContextPanel({ sessionId, runId, busy, providerId, inputRevision, onPreview }: {
  sessionId: string; runId?: string; busy: boolean; providerId: string; inputRevision: string;
  onPreview: () => Promise<InputPreview>;
}) {
  const [status, setStatus] = useState<ContextStatus | null>(null);
  const [draft, setDraft] = useState({ maxTokens: 24000, maxMessages: 80 });
  const [model, setModel] = useState({ contextTokens: 0, outputReserve: 0 });
  const [preview, setPreview] = useState<{revision: string; value: InputPreview} | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const [stale, setStale] = useState(false);
  const guard = useRef(false), requestSequence = useRef(0);
  const historyDirty = useRef(false), modelDirty = useRef(false);
  const identity = `${sessionId}:${providerId}`;
  const current = useRef(identity); current.current = identity;
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; requestSequence.current++;
    historyDirty.current = false; modelDirty.current = false;
    setStatus(null); setMessage(""); setPreview(null); setStale(false); setWorking(false); guard.current = false;
    setDraft({maxTokens: 24000, maxMessages: 80}); setModel({contextTokens: 0, outputReserve: 0});
    return () => { generation.current++; requestSequence.current++; };
  }, [identity]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (guard.current) return;
      const seq = ++requestSequence.current;
      setLoading(true);
      void call<ContextStatus>("agent.context", { sessionId, providerId }).then(value => {
        if (!live || current.current !== identity || seq !== requestSequence.current) return;
        setStatus(value);
        if (!historyDirty.current) setDraft(value.settings);
        if (!modelDirty.current) setModel({contextTokens: value.modelWindow?.contextTokens || 0, outputReserve: value.modelWindow?.outputReserve || 0});
      }).catch(reason => { if (live && current.current === identity && seq === requestSequence.current) setMessage(String(reason)); })
        .finally(() => { if (live && seq === requestSequence.current) setLoading(false); });
    };
    const changed = (event: Event) => { if ((event as CustomEvent).detail === sessionId) { setStale(true); refresh(); } };
    const open = () => document.querySelector<HTMLDetailsElement>(".agent-context-panel")?.setAttribute("open", "");
    refresh(); window.addEventListener("ai-proxy-context-changed", changed); window.addEventListener("ai-proxy-open-context", open);
    return () => { live = false; requestSequence.current++; window.removeEventListener("ai-proxy-context-changed", changed); window.removeEventListener("ai-proxy-open-context", open); };
  }, [identity, runId, busy, retry]);
  useEffect(() => {
    if (!preview || stale) return;
    let live = true, pending = false;
    const check = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try { const value = await call<{fingerprint: string}>("agent.context.identity", {sessionId, providerId}); if (live && value.fingerprint !== preview.value.fingerprint) setStale(true); }
      catch { if (live) setStale(true); }
      finally { pending = false; }
    };
    const invalidate = () => { if (live) setStale(true); };
    void check(); const timer = window.setInterval(() => void check(), 5000);
    document.addEventListener("visibilitychange", invalidate);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", invalidate); };
  }, [preview, stale, identity]);
  const action = async (kind: "compress" | "save" | "model" | "preview") => {
    if (guard.current) return;
    guard.current = true; requestSequence.current++; setLoading(false); setWorking(true); setMessage("");
    const version = generation.current, target = current.current, revision = inputRevision;
    const valid = () => generation.current === version && current.current === target;
    try {
      if (kind === "compress") {
        const value = await compressSessionContext(sessionId);
        if (valid()) { setStatus(value); setMessage(value.message || "压缩完成"); setPreview(null); }
      } else if (kind === "preview") {
        const value = await onPreview(); if (valid()) { setPreview({revision, value}); setStale(false); }
      } else if (kind === "model") {
        await call("agent.context.model.set", { providerId, ...model });
        if (valid()) { modelDirty.current = false; setPreview(null); setMessage("已保存此端点与模型的窗口配置；仅用于估算。"); setRetry(value => value+1); }
      } else {
        await call("agent.context.set", { settings: draft });
        if (!valid()) return;
        historyDirty.current = false;
        const value = await call<ContextStatus>("agent.context", { sessionId, providerId });
        if (valid()) { setStatus(value); setPreview(null); setMessage("已保存，下一次发送生效。"); }
      }
    } catch (reason) { if (valid()) setMessage(String(reason)); }
    finally { if (valid()) { guard.current = false; setWorking(false); if (kind !== "preview") setRetry(value => value+1); } }
  };
  const fresh = !stale && !historyDirty.current && !modelDirty.current && preview?.revision === inputRevision ? preview.value : null;
  return <details className="agent-context-panel">
    <summary>上下文 {status ? `· 历史保守估算 ${status.estimatedTokens.toLocaleString()} / ${status.settings.maxTokens.toLocaleString()} · ${status.savedMessages} 条消息` : "· 展开设置"}</summary>
    <p>{status?.notice || "读取上下文状态后可设置历史预算或手动压缩。"}</p>
    {status && <p>下轮预计保留 {status.nextMessages} 条消息，历史估算 {status.nextEstimatedTokens.toLocaleString()}。实际Token与费用以供应商回执为准。</p>}
    {loading && <p role="status">正在读取已保存设置；未保存的编辑会保留。</p>}
    <button className="button ghost compact" disabled={working || loading} onClick={() => setRetry(value => value+1)}>刷新 / 重试读取</button>
    <fieldset disabled={working} className="context-fields">
      <label>历史估算预算<input type="number" min={4000} max={128000} step={1000} value={draft.maxTokens} onChange={event => { historyDirty.current = true; setDraft({ ...draft, maxTokens: Number(event.target.value) }); }} /></label>
      <label>消息预算<input type="number" min={8} max={200} value={draft.maxMessages} onChange={event => { historyDirty.current = true; setDraft({ ...draft, maxMessages: Number(event.target.value) }); }} /></label>
      <button className="button ghost compact" onClick={() => void action("save")}>保存历史设置</button>
      <button className="button ghost compact" disabled={busy} onClick={() => void action("compress")}>压缩历史 /compress</button>
      <label>模型窗口Token（自行核实，0为未知）<input type="number" min={0} max={4000000} value={model.contextTokens} onChange={event => { modelDirty.current = true; setModel({...model, contextTokens: Number(event.target.value)}); }} /></label>
      <label>输出预留Token<input type="number" min={0} max={1000000} value={model.outputReserve} onChange={event => { modelDirty.current = true; setModel({...model, outputReserve: Number(event.target.value)}); }} /></label>
      <button disabled={!providerId} className="button ghost compact" onClick={() => void action("model")}>保存模型窗口估算配置</button>
      <button disabled={busy || historyDirty.current || modelDirty.current} className="button ghost compact" onClick={() => void action("preview")}>计算完整发送预览（不调用模型）</button>
    </fieldset>
    {(historyDirty.current || modelDirty.current) && <p>有未保存设置；请保存后重新计算完整发送预览。</p>}
    {preview && !fresh && <p>输入、范围或模型已变化，请重新计算发送预览。</p>}
    {fresh && <div className="input-estimate">
      <p>本次预览快照 {fresh.scopeCount} 条 · {new Date(fresh.snapshotAt).toLocaleTimeString()} · 输入保守估算 {fresh.estimatedInputTokens.toLocaleString()}</p>
      <dl>{Object.entries(fresh.parts).map(([key, count]) => <div key={key}><dt>{({history: "保留历史", instructions: "系统指令与兼容历史", tools: "工具定义", input: "下条输入", scopeAndRefs: "范围与引用"} as Record<string, string>)[key] || key}</dt><dd>{count.toLocaleString()} 字节</dd></div>)}</dl>
      <p>{fresh.estimatedPercent == null ? "模型窗口未知，不计算占用率或剩余量。" : `按你配置的窗口估算占用 ${fresh.estimatedPercent}%，剩余约 ${fresh.estimatedRemaining?.toLocaleString()} Token。${fresh.exceedsEstimate ? "保守估算超过预算，请压缩或调整配置。" : ""}`}</p>
      <p className="boundary-note">{fresh.notice}</p>
    </div>}
    <p>压缩保留最近至多2个完整轮次与本地固定摘要，可能损失旧细节；原Run、消息和证据保留，不会请求模型。</p>
    {(status?.error || message) && <p role="status">{message || status?.error}</p>}
  </details>;
}
