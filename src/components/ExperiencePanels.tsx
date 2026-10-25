import { useEffect, useRef, useState } from "react";
import { call, saveTextFile } from "../lib/api";
import { formatBytes } from "../lib/format";
import type { AnalysisRun, CaptureStatus, CaptureTimeoutSettings } from "../types";
import { TaskProgress } from "./OperationFeedback";

interface Health {
  checkedAt: number;
  dataDir: string;
  status: "ok" | "warning" | "error";
  disk: { freeBytes: number; totalBytes: number } | null;
  checks: Array<{ name: string; status: string; code?: string; message: string }>;
  capture: { lastPersistedAt: number | null; lastFailure: { at: number; code: string } | null; failedWrites: number; queueDrops: number; recordLossEvents: number; queueDepth: number; queueLimit: number };
  notice: string;
}

export function StorageHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const performing = useRef(false);
  const check = async () => {
    if (performing.current) return;
    performing.current = true; setBusy(true); setError("");
    try { setHealth(await call<Health>("storage.health")); }
    catch (reason) { setError(String(reason)); }
    finally { performing.current = false; setBusy(false); }
  };
  return <section className="experience-panel">
    <h3>存储健康与采集保存</h3>
    <p>主动检查磁盘余量、目录读写和数据库只读访问。写入检查只使用独立临时文件；不会删除或修复抓包数据库。</p>
    <button className="button ghost compact" disabled={busy} onClick={() => void check()}>{busy ? "正在检查…" : "检查存储健康"}</button>
    <TaskProgress busy={busy} label="检查本地存储" />
    {error && <p className="error-banner" role="alert">{error}。可以重新检查；磁盘、目录恢复前请保留原数据。</p>}
    {health && <>
      <p><b>{health.status === "ok" ? "本次检查通过" : health.status === "warning" ? "需要留意" : "发现存储问题"}</b> · {new Date(health.checkedAt).toLocaleString()}；这是最近一次结果，非实时保证。</p>
      <code className="path-line">{health.dataDir}</code>
      {health.disk && <p>可用 {formatBytes(health.disk.freeBytes)} / 总计 {formatBytes(health.disk.totalBytes)}</p>}
      <ul>{health.checks.map((item, index) => <li key={`${item.name}:${index}`}><b>{item.name} · {item.status === "ok" ? "通过" : item.status === "warning" ? "提示" : "失败"}</b>：{item.message}{item.code ? `（${item.code}）` : ""}</li>)}</ul>
      <p>最近成功保存：{health.capture.lastPersistedAt ? new Date(health.capture.lastPersistedAt).toLocaleString() : "本次打开尚无成功保存记录"} · 待写入 {health.capture.queueDepth}/{health.capture.queueLimit} · 写入失败累计 {health.capture.failedWrites} 次</p>
      <p>队列已满丢弃 {health.capture.queueDrops} 次 · 保存缺口事件共 {health.capture.recordLossEvents} 次；按记录快照计数，同一请求可能有多次，不等于唯一请求数。</p>
      {health.capture.lastFailure && <p role="alert">最近保存失败：{new Date(health.capture.lastFailure.at).toLocaleString()} · {health.capture.lastFailure.code}。目录检查通过也不代表历史失败数据已经恢复。</p>}
      <p className="boundary-note">{health.notice} 未执行数据库完整性扫描，无法补回已丢失响应。</p>
      <button className="button ghost compact" onClick={() => {
        const { dataDir: _privatePath, ...safe } = health;
        void navigator.clipboard.writeText(JSON.stringify(safe, null, 2)).catch(reason => setError(String(reason)));
      }}>复制诊断元数据（不含数据路径与正文）</button>
    </>}
  </section>;
}

const defaults: CaptureTimeoutSettings = { requestTimeoutSeconds: 120, streamIdleTimeoutSeconds: 120, http2Enabled: true };
export function CaptureTimeoutPanel({ capture, onChanged }: { capture: CaptureStatus; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState(capture.timeoutSettings || defaults);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const performing = useRef(false);
  const [message, setMessage] = useState("");
  useEffect(() => { if (!dirty) setDraft(capture.timeoutSettings || defaults); }, [capture.timeoutSettings?.requestTimeoutSeconds, capture.timeoutSettings?.streamIdleTimeoutSeconds, capture.timeoutSettings?.http2Enabled, dirty]);
  const valid = [draft.requestTimeoutSeconds, draft.streamIdleTimeoutSeconds].every(value => Number.isInteger(value) && value >= 5 && value <= 3600);
  const save = async () => {
    if (performing.current || !valid) return;
    performing.current = true; setBusy(true); setMessage("");
    try {
      const result = await call<CaptureStatus>("capture.timeouts.set", { settings: draft });
      setDraft(result.timeoutSettings || draft); setDirty(false);
      setMessage("策略已保存。超时值用于新请求；现有请求保留启动时策略。");
      try { await onChanged(); } catch { setMessage("策略已有保存回执，但状态刷新失败；重新打开设置核对生效值。"); }
    } catch (reason) { setMessage(String(reason)); }
    finally { performing.current = false; setBusy(false); }
  };
  return <section className="experience-panel">
    <h3>抓包超时与协议</h3>
    <p>普通请求按Header起计总时限；流按无数据时间计，持续有数据不会因总时长被中断。每项5–3600秒。</p>
    <div className="form-grid two">
      <label className="field"><span>普通请求总时限（秒）</span><input type="number" min={5} max={3600} disabled={busy} value={draft.requestTimeoutSeconds} onChange={event => { setDirty(true); setDraft({ ...draft, requestTimeoutSeconds: Number(event.target.value) }); }} /></label>
      <label className="field"><span>流空闲时限（秒）</span><input type="number" min={5} max={3600} disabled={busy} value={draft.streamIdleTimeoutSeconds} onChange={event => { setDirty(true); setDraft({ ...draft, streamIdleTimeoutSeconds: Number(event.target.value) }); }} /></label>
    </div>
    <label className="switch-row compact"><div><b>允许HTTP/2</b><span>停止代理后才能修改；关闭后新连接协商HTTP/1。</span></div><input type="checkbox" disabled={capture.running || busy} checked={draft.http2Enabled} onChange={event => { setDirty(true); setDraft({ ...draft, http2Enabled: event.target.checked }); }} /></label>
    <p className="boundary-note">当前内核超时会关闭承载连接，HTTP/2的并行请求可能一起中断。需要减少连带影响时，停止代理后关闭HTTP/2；这可能改变目标应用的协议表现。WebSocket空闲按承载连接收发（含心跳）计算。大响应流式转发也使用流空闲时限。</p>
    <p>已保存：请求 {capture.timeoutSettings?.requestTimeoutSeconds ?? 120} 秒 / 流空闲 {capture.timeoutSettings?.streamIdleTimeoutSeconds ?? 120} 秒 / HTTP/2 {(capture.timeoutSettings?.http2Enabled ?? true) ? "开启" : "关闭"}</p>
    <div className="qa-actions"><button className="button primary compact" disabled={busy || !valid || !dirty} onClick={() => void save()}>保存超时策略</button><button className="button ghost compact" disabled={busy} onClick={() => { setDirty(true); setDraft({ ...defaults, http2Enabled: capture.running ? capture.timeoutSettings?.http2Enabled ?? true : true }); setMessage("已填入默认值，点击保存后生效。"); }}>填入默认值</button></div>
    {!valid && <p role="alert">请输入5–3600秒的整数，不能设置为无限等待。</p>}
    {message && <p role="status">{message}</p>}
    <TaskProgress busy={busy} label="保存抓包超时策略" />
  </section>;
}

interface PerformanceItem {
  runId: string; model: string; status: string; createdAt: number; durationMs: number | null;
  context: { protocol: string; sampleCount: number; mode: string; cachePolicy: string } | null;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  firstOutputMs: number | null; modelDurationMs: number | null; modelRequests: number;
  localToolCache: { hits: number | null; misses: number | null; resetDuringRun: boolean } | null;
  steps: Array<Record<string, unknown>>;
}
interface PerformanceComparison { comparable: boolean; notice: string; costNotice: string; items: PerformanceItem[] }
const metric = (value: number | null | undefined, unit = "") => value == null ? "未知" : `${value}${unit}`;
export function PerformancePanel({ runs }: { runs: AnalysisRun[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<{ key: string; value: PerformanceComparison } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const performing = useRef(false);
  const selectionKey = JSON.stringify(selected.map(id => {
    const run = runs.find(item => item.id === id);
    return [id, run?.status, run?.finishedAt, run?.usage];
  }));
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const result = snapshot?.key === selectionKey ? snapshot.value : null;
  useEffect(() => () => { currentSelection.current = "unmounted"; }, []);
  useEffect(() => { setSelected(ids => ids.filter(id => runs.some(run => run.id === id))); }, [runs]);
  const compare = async () => {
    if (performing.current) return;
    const key = selectionKey;
    performing.current = true; setBusy(true); setError(""); setSnapshot(null);
    try {
      const value = await call<PerformanceComparison>("agent.performance-compare", { runIds: selected });
      if (currentSelection.current === key) setSnapshot({ key, value });
      else if (currentSelection.current !== "unmounted") setError("所选记录已更新，请重新比较；旧结果未应用。");
    }
    catch (reason) { if (currentSelection.current === key) setError(String(reason)); }
    finally { performing.current = false; setBusy(false); }
  };
  return <section className="experience-panel">
    <h3>缓存与耗时比较</h3>
    <p>选择2–10条执行记录，只读取已有指标，不发送模型请求。比较同模型、端点、样本版本和规则范围；提示、历史长度与工具路径仍需人工核对。</p>
    {!runs.length && <p>当前会话还没有执行记录。完成调查后可返回比较，真实模型由你主动调用。</p>}
    <div className="performance-selection">{runs.map(run => <label key={run.id}><input type="checkbox" checked={selected.includes(run.id)} disabled={busy || (!selected.includes(run.id) && selected.length >= 10)} onChange={event => { setSelected(ids => event.target.checked ? [...ids, run.id] : ids.filter(id => id !== run.id)); setSnapshot(null); }} /><span>{new Date(run.createdAt).toLocaleString()} · {run.model} · {run.status} · {run.scope.requestCount}条 · {run.id}</span></label>)}</div>
    <button className="button ghost compact" disabled={busy || selected.length < 2} onClick={() => void compare()}>读取并比较（已选{selected.length}条）</button>
    <TaskProgress busy={busy} label="读取已有用量与耗时" />
    {error && <p className="error-banner" role="alert">{error}。可缩小选择后重新读取。</p>}
    {result && <>
      <p role="status"><b>{result.comparable ? "主要比较条件一致" : "不能直接比较优化效果"}</b>：{result.notice}</p>
      <div className="performance-table"><table><thead><tr><th>记录 / 条件</th><th>输入 / 输出Token</th><th>模型缓存读 / 写Token</th><th>首个模型请求首输出</th><th>模型耗时 / 整轮耗时</th><th>本地工具命中 / 未命中</th></tr></thead><tbody>{result.items.map(item => <tr key={item.runId}><td>{item.runId}<br />{item.model} · {item.context?.protocol || "协议未知"}<br />{item.context ? `${item.context.sampleCount}条 · ${item.context.mode} · 缓存${item.context.cachePolicy}` : "旧记录缺少对比元数据"}<br />{item.modelRequests}次模型请求 · {item.status}</td><td>{metric(item.inputTokens)} / {metric(item.outputTokens)}</td><td>{metric(item.cacheReadTokens)} / {metric(item.cacheWriteTokens)}</td><td>{metric(item.firstOutputMs, "ms")}</td><td>{metric(item.modelDurationMs, "ms")} / {metric(item.durationMs, "ms")}</td><td>{metric(item.localToolCache?.hits)} / {metric(item.localToolCache?.misses)}{item.localToolCache?.resetDuringRun ? "（执行中清理过缓存）" : ""}</td></tr>)}</tbody></table></div>
      <p className="boundary-note">{result.costNotice} 缺少供应商指标时保留未知；本地工具缓存与模型缓存分别计算。未记录的失败调用耗时不算进已完成模型请求合计；整轮耗时还包含工具与审批等待。</p>
      {result.items.map(item => <details key={item.runId}><summary>{item.runId} · 单次模型用量</summary><pre className="result-json">{JSON.stringify(item.steps, null, 2)}</pre></details>)}
      <button className="button ghost compact" onClick={() => void saveTextFile("ai-proxy-performance.json", JSON.stringify(result, null, 2)).catch(reason => setError(String(reason)))}>保存比较元数据（不含提示与正文）</button>
    </>}
  </section>;
}
