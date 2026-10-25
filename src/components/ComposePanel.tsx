import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { call, confirmAction } from "../lib/api";
import { HeaderFields } from "./HeaderFields";
import type { RequestSummary } from "../types";
type Data = Record<string, any>;
const terminal = (job: Data | null) => !job || !["running", "stopping"].includes(job.status);
const labels: Record<string, string> = {preview: "待确认", running: "发送中", stopping: "正在停止", completed: "已完成", failed: "失败", timeout: "已超时", stopped: "已停止", interrupted: "已中断", unknown: "结果未知", sending: "等待响应"};
export function ComposePanel({selected, onSelectRequest}: {selected: RequestSummary | null; onSelectRequest: (id: string) => void}) {
  const [source, setSource] = useState<{id: string; version: number} | null>(null);
  const [draft, setDraft] = useState({method: "GET", url: "", headers: "[]", body: "", bodyMode: "original"});
  const [options, setOptions] = useState({route: "direct", count: 1, concurrency: 1, intervalMs: 0, totalSeconds: 30});
  const [job, setJob] = useState<Data | null>(null), [jobs, setJobs] = useState<{items: Data[]; total: number; offset: number}>({items: [], total: 0, offset: 0});
  const [pollStopped, setPollStopped] = useState(false);
  const historySequence = useRef(0), startAttemptAt = useRef(0);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false), sequence = useRef(0), alive = useRef(true), jobRef = useRef(job), revision = useRef(0);
  jobRef.current = job;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const loadJobs = async (offset = 0) => {
    const version = ++historySequence.current;
    const value = await call<{items: Data[]; total: number; offset: number}>("compose.list", {offset, limit: 20});
    if (alive.current && version === historySequence.current) setJobs(value);
  };
  useEffect(() => { alive.current = true; void loadJobs().catch(reason => { if (alive.current) setError(String(reason)); }); return () => { alive.current = false; sequence.current++; historySequence.current++; }; }, []);
  const changed = () => { revision.current++; setDirty(true); };
  const perform = async (action: () => Promise<void>) => {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError("");
    try { await action(); } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { guard.current = false; if (alive.current) setBusy(false); }
  };
  const refresh = async (id: string) => {
    const version = ++sequence.current;
    const value = await call<Data>("compose.status", {jobId: id});
    if (alive.current && sequence.current === version && jobRef.current?.id === id) { setJob(value); setUnknown(false); }
    return value;
  };
  const capturePending = job?.actions?.some((action: Data) => action.response?.capturePending);
  useEffect(() => {
    if (!job || pollStopped || terminal(job) && !unknown && !capturePending) return;
    let live = true, loading = false, failures = 0;
    const deadline = terminal(job) && capturePending ? (job.finishedAt || Date.now())+35000
      : (job.startedAt || startAttemptAt.current || job.createdAt)+job.totalSeconds*1000+30000;
    const pause = (message: string) => {
      if (!live) return;
      live = false; sequence.current++; setPollStopped(true); setUnknown(true); setError(message);
    };
    const check = async () => {
      if (!live || loading || document.hidden) return;
      if (Date.now() >= deadline) { pause("已达到发送时限与30秒回执宽限，停止自动等待；结果待核对，请手动读取实际状态，不会重发。"); return; }
      loading = true;
      try { await refresh(job.id); failures = 0; }
      catch (reason) { if (live) { failures++; setError(String(reason)); if (failures >= 3) pause("连续3次状态读取失败，已停止自动等待；请恢复连接后核对实际状态，不会重发。"); } }
      finally { loading = false; }
    };
    const timer = window.setInterval(() => void check(), 1500);
    const timeout = window.setTimeout(() => pause("状态等待已结束；结果未知，请手动核对，不能据此判断服务端未执行。"), Math.max(0, deadline-Date.now()));
    const visible = () => { if (!document.hidden) void check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; window.clearInterval(timer); window.clearTimeout(timeout); document.removeEventListener("visibilitychange", visible); };
  }, [job?.id, job?.status, unknown, pollStopped, capturePending]);
  const fromSelection = () => void perform(async () => {
    if (!selected) return;
    const identity = `${selected.id}:${selected.version}`;
    const detail = await call<Data>("requests.detail", {requestId: selected.id});
    if (!alive.current || `${selectedRef.current?.id}:${selectedRef.current?.version}` !== identity) return;
    if (detail.version !== selected.version) throw new Error("所选请求已变化，请重新选择后载入");
    setSource({id: selected.id, version: selected.version});
    setDraft({method: detail.method, url: detail.url, headers: JSON.stringify(detail.requestHeaders || [], null, 2), body: detail.requestBodyText || "", bodyMode: "original"}); changed();
  });
  const preview = () => void perform(async () => {
    const version = revision.current;
    const edits: Data = {url: draft.url, method: draft.method, headers: JSON.parse(draft.headers)};
    if (draft.bodyMode === "text") edits.body = draft.body;
    if (draft.bodyMode === "base64") edits.bodyBase64 = draft.body;
    const value = await call<Data>("compose.preview", {requestId: source?.id || null, expectedSourceVersion: source?.version ?? null, edits, ...options});
    if (!alive.current || revision.current !== version) return;
    setJob(value); jobRef.current = value; setDirty(false); setUnknown(false); setPollStopped(false);
    await loadJobs();
  });
  const start = () => void perform(async () => {
    if (!job || dirty || unknown) return;
    const id = job.id, version = revision.current;
    const first = job.actions?.[0]?.request;
    if (!await confirmAction(`确认发送整组固定预览？\n${first?.method} ${first?.url}\n链路：${job.route === "proxy" ? "经过本地代理（规则/弱网以实际证据为准）" : "直连（不应用代理规则/弱网）"}\n次数 ${job.count}，并发 ${job.concurrency}，派发间隔 ${job.intervalMs}ms，总时限 ${job.totalSeconds}s。\n写接口可能产生真实业务副作用；停止不能撤销已发请求，结果未知不自动重试。`)) return;
    if (!alive.current || jobRef.current?.id !== id || revision.current !== version) return;
    startAttemptAt.current = Date.now(); setPollStopped(false); setUnknown(true);
    try { const value = await call<Data>("compose.start", {jobId: id}); if (alive.current && jobRef.current?.id === id) { setJob(value); setUnknown(false); setPollStopped(false); } }
    catch (reason) { throw reason; }
  });
  const running = !terminal(job);
  return <div className="compose-panel">
    <p>空白Compose或从已有抓包编辑，先预览整组再发送。每次发送都有独立记录。</p>
    <div className="qa-actions"><button disabled={busy || running || unknown} className="button ghost compact" onClick={fromSelection}>从当前抓包载入{selected ? ` ${selected.method}` : "（请先选择）"}</button><button disabled={busy || running || unknown} className="button ghost compact" onClick={() => { setSource(null); setDraft({method: "GET", url: "", headers: "[]", body: "", bodyMode: "original"}); changed(); }}>新建空白请求</button></div>
    <p className="boundary-note">{source ? `编辑来源 ${source.id} · v${source.version}` : "空白请求；发送前不创建伪造抓包样本。"}</p>
    <fieldset disabled={busy || running || unknown} className="task-fields">
      <div className="form-grid two"><label className="field"><span>方法</span><input value={draft.method} onChange={e => { setDraft({...draft, method: e.target.value}); changed(); }} /></label><label className="field"><span>URL（含Query）</span><input value={draft.url} placeholder="https://api.example.com/v1/items" onChange={e => { setDraft({...draft, url: e.target.value}); changed(); }} /></label></div>
      <HeaderFields value={draft.headers} onChange={headers => { setDraft({...draft, headers}); changed(); }} />
      <label className="field"><span>正文</span><Select value={draft.bodyMode} onChange={e => { setDraft({...draft, bodyMode: e.target.value, body: ""}); changed(); }}><option value="original">{source ? "保留原始正文（含二进制）" : "空正文"}</option><option value="text">完整替换为文本</option><option value="base64">完整替换为Base64二进制</option></Select></label>
      {draft.bodyMode !== "original" && <textarea aria-label="完整请求正文" rows={5} value={draft.body} onChange={e => { setDraft({...draft, body: e.target.value}); changed(); }} />}
      <div className="context-fields">
        <label>发送链路<Select value={options.route} onChange={e => { setOptions({...options, route: e.target.value}); changed(); }}><option value="direct">直连，不应用规则/弱网</option><option value="proxy">经过本地代理，应用已启用规则/弱网</option></Select></label>
        <label>次数（1–20）<input type="number" min={1} max={20} value={options.count} onChange={e => { const count = Number(e.target.value); setOptions({...options, count, concurrency: Math.min(options.concurrency, Math.max(1, count))}); changed(); }} /></label>
        <label>并发（1–3）<input type="number" min={1} max={Math.min(3, options.count)} value={options.concurrency} onChange={e => { setOptions({...options, concurrency: Number(e.target.value)}); changed(); }} /></label>
        <label>全局派发间隔ms<input type="number" min={0} max={10000} value={options.intervalMs} onChange={e => { setOptions({...options, intervalMs: Number(e.target.value)}); changed(); }} /></label>
        <label>整组总时限秒<input type="number" min={5} max={60} value={options.totalSeconds} onChange={e => { setOptions({...options, totalSeconds: Number(e.target.value)}); changed(); }} /></label>
      </div>
      <button className="button primary compact" onClick={preview}>生成整组固定预览</button>
    </fieldset>
    <p className="boundary-note">HTTPS经过代理须先显式启用目标Host解密；仅信任当前项目CA，不修改系统信任。不跟随重定向、不自动重试；单次等待最多30秒，整组最多60秒。并发中已发请求不会因另一条失败而撤销。</p>
    <div className="qa-actions">
      <button className="button primary compact" disabled={busy || dirty || unknown || job?.status !== "preview"} onClick={start}>确认发送整组</button>
      <button className="button ghost compact" disabled={busy || !running} onClick={() => void perform(async () => { const value = await call<Data>("compose.stop", {jobId: job!.id}); if (alive.current) setJob(value); })}>停止本组</button>
      <button className="button ghost compact" disabled={busy || !job} onClick={() => void perform(async () => { setPollStopped(false); await refresh(job!.id); })}>核对实际状态</button>
      <button className="button ghost compact" disabled={busy} onClick={() => void perform(async () => { await loadJobs(jobs.offset); })}>刷新历史任务</button>
    </div>
    {dirty && job?.status === "preview" && <p role="status">编辑已变化，原预览不能发送，请重新生成。</p>}
    {unknown && <p role="alert">{pollStopped ? "自动等待已结束，状态待核对；请手动核对实际结果，不会自动重发。" : "回执尚未确认，请核对实际状态，不要重复生成或发送。"}</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {job && <section className="compose-results"><b>{pollStopped ? "状态待核对" : labels[job.status] || job.status} · {job.completedCount}/{job.count} 完成 · {job.unsentCount} 未发送 · {job.unknownCount || 0} 未知 · {job.failedCount || 0} 动作失败 · {job.httpErrorCount || 0} HTTP错误</b><p>{job.notice}</p>
      {job.error && <p role="alert">{job.error}</p>}
      <details open={job.status === "preview"}><summary>整组参数、固定预览与逐次结果 · {job.id}</summary><p>链路 {job.route} · 并发 {job.concurrency} · 间隔 {job.intervalMs}ms · 总时限 {job.totalSeconds}s</p>
        {job.actions?.map((action: Data, index: number) => <div className="compose-action" key={action.id}><b>{index+1}. {action.request.method} {action.request.url} · {labels[action.status] || action.status}</b><details><summary>查看请求预览与响应</summary><pre>{JSON.stringify(action, null, 2)}</pre></details>{action.response?.route === "proxy" && <p role="status">抓包保存：{({saved: "已确认保存", pending: "等待保存确认（最多30秒）", failed: "保存失败，请检查存储", unknown: "保存状态未知，可核对实际状态"} as Record<string, string>)[action.response.captureState] || (action.response.captureError ? "未取得抓包记录" : "待核对")}</p>}{action.response?.capturedRequestId && (action.response.route !== "proxy" || action.response.captureState === "saved") && <button className="button ghost compact" onClick={() => onSelectRequest(action.response.capturedRequestId)}>查看对应抓包</button>}</div>)}
      </details></section>}
    {!!jobs.total && <details><summary>历史Compose任务 · {jobs.total}组（每页20组摘要）</summary>{jobs.items.map(item => <button className="button ghost compact" disabled={busy || running || unknown} key={item.id} onClick={() => void perform(async () => { const value = await call<Data>("compose.status", {jobId: item.id}); if (alive.current) { setJob(value); jobRef.current = value; setDirty(false); setUnknown(false); setPollStopped(false); revision.current++; } })}>{new Date(item.createdAt).toLocaleString()} · {labels[item.status] || item.status} · {item.count}次 · {item.route}</button>)}<div className="history-pages"><button disabled={busy || jobs.offset === 0} onClick={() => void perform(() => loadJobs(Math.max(0, jobs.offset-20)))}>上一页任务</button><span>{jobs.offset+1}–{jobs.offset+jobs.items.length} / {jobs.total}</span><button disabled={busy || jobs.offset+jobs.items.length >= jobs.total} onClick={() => void perform(() => loadJobs(jobs.offset+20))}>下一页任务</button></div></details>}
  </div>;
}
