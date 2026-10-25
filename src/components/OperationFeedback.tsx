import { useEffect, useState, useSyncExternalStore } from "react";
import { dismissFinishedOperations, dismissOperation, getOperations, pruneOperations, subscribeOperations } from "../lib/operations";

function useClock(enabled = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!enabled) return; setNow(Date.now()); const timer = window.setInterval(() => { pruneOperations(); setNow(Date.now()); }, 1000); return () => window.clearInterval(timer); }, [enabled]);
  return now;
}

export function TaskProgress({ busy, label }: { busy: boolean; label: string }) {
  const [started, setStarted] = useState(Date.now);
  useEffect(() => { if (busy) setStarted(Date.now()); }, [busy]);
  const now = useClock(busy);
  if (!busy) return null;
  return <div className="task-progress"><b role="status">{label}</b><span>开始于 {new Date(started).toLocaleTimeString()} · 已等待 {Math.max(0, Math.floor((now - started) / 1000))} 秒</span><small>可在底部“任务与等待”查看当前操作的时限与回执。关闭面板不会取消后台操作。</small></div>;
}

export function OperationCenter({ onHistory = () => window.dispatchEvent(new Event("ai-proxy-operation-history")), active = true }: { onHistory?: () => void; active?: boolean }) {
  const operations = useSyncExternalStore(subscribeOperations, getOperations);
  const now = useClock(active);
  const running = operations.filter(item => item.status === "running" && now - item.startedAt >= 1500);
  const problems = operations.filter(item => ["failed", "timeout", "unknown"].includes(item.status));
  const recent = operations.filter(item => item.status === "completed" && (item.finishedAt || 0) - item.startedAt >= 1500).slice(-5);
  const visible = [...running, ...problems.slice(-10), ...recent].sort((a, b) => b.startedAt - a.startedAt);
  const states = { running: "等待回执", completed: "已收到回执", failed: "失败", timeout: "读取超时", unknown: "回执未知" };
  return <details className="operation-center">
    <summary>任务与等待{running.length ? ` · ${running.length} 项等待` : ""}{problems.length ? ` · ${problems.length} 项需核对` : ""}</summary>
    <p>只保留本次打开中的操作元数据，最多100条/10分钟。不会自动重试或重复发送；关闭面板不会取消。Agent持续运行的阶段和停止请在调查页查看。</p>
    {!!problems.length && <button className="button ghost compact" onClick={dismissFinishedOperations}>清除已核对的提示</button>}
    {!visible.length && <p>当前没有等待超过1.5秒的操作或近期错误。</p>}
    {visible.map(item => <div className={`operation-row ${item.status}`} key={item.id}>
      <div><b>{item.label} · {states[item.status]}</b><small>{new Date(item.startedAt).toLocaleTimeString()} · {Math.max(0, Math.floor(((item.finishedAt || now) - item.startedAt) / 1000))} 秒 · 回执时限 {item.timeoutMs / 1000} 秒</small></div>
      <span>{item.status === "running" ? "正在等待应用引擎；此处没有后台取消能力。" : item.status === "unknown" ? "先查看操作历史并核对实际结果，再决定是否新建操作。" : item.status === "failed" || item.status === "timeout" ? item.readOnly ? "返回原功能，检查范围后主动重试读取。" : "返回原功能检查错误与预览；不自动重试。" : "回执已收到；若结果是创建任务，请在对应功能继续查看。"}</span>
      {item.status === "unknown" && <button className="button ghost compact" onClick={onHistory}>查看操作历史</button>}
      {item.status !== "running" && <button className="button ghost compact" onClick={() => dismissOperation(item.id)}>移除此提示</button>}
    </div>)}
  </details>;
}
