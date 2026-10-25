import { useEffect, useRef, useState } from "react";
import { call } from "../lib/api";
import type { AnalysisRun, ReportSummary } from "../types";
export const runStatusLabels: Record<string, string> = {preparing: "准备中", running: "运行中", executing_tool: "工具执行中", waiting_approval: "等待批准", completed: "已完成", failed: "失败", interrupted: "已中断", stopped: "已停止", budget_exhausted: "预算已用尽"};
interface Page<T> {items: T[]; total: number; offset: number}
export function RunHistory({sessionId, revision, reports, reportTotal, onRun, onReport}: {
  sessionId: string; revision: string; reports: ReportSummary[]; reportTotal: number; onRun: (run: AnalysisRun) => Promise<void>; onReport: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0), [reportOffset, setReportOffset] = useState(0);
  const [page, setPage] = useState<Page<AnalysisRun> | null>(null), [reportPage, setReportPage] = useState<Page<ReportSummary> | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    if (!open) return;
    let live = true; const sequence = ++request.current; setLoading(true); setError("");
    void Promise.all([
      call<Page<AnalysisRun>>("agent.history", {sessionId, offset, limit: 12}),
      call<Page<ReportSummary>>("reports.history", {sessionId, offset: reportOffset, limit: 8}),
    ]).then(([runs, saved]) => { if (live && sequence === request.current) { setPage(runs); setReportPage(saved); } })
      .catch(reason => { if (live && sequence === request.current) setError(String(reason)); })
      .finally(() => { if (live && sequence === request.current) setLoading(false); });
    return () => { live = false; request.current++; };
  }, [open, sessionId, offset, reportOffset, revision, reports, retry]);
  const shownOffset = page?.offset || 0, shownReports = reportPage?.offset || 0;
  return <details className="run-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="rail-label">分析记录 {page?.total ?? "展开读取"} / 报告 {reportTotal}</summary>
    {page?.items.map(run => <button className={`run-history-item ${run.status}`} key={run.id} title={`${run.taskText || "旧记录未保存任务问题"}\n${run.parentRunId ? `续查 ${run.continuationDepth || "?"} · 父Run ${run.parentRunId}${run.rootTaskMissing ? " · 原任务链缺失，显示当前输入" : ""}\n` : ""}${run.scope.batchLabel || run.batchId}\n${run.id}\n${run.statusDetail || ""}`} onClick={() => void onRun(run).catch(reason => setError(String(reason)))}>
      <span>{run.parentRunId ? `续查 ${run.continuationDepth || "?"} · ` : ""}{run.taskText?.replace(/\s+/g, " ") || run.summary || "未命名分析"}</span>
      <small>{runStatusLabels[run.status] || run.status} · {new Date(run.createdAt).toLocaleString("zh-CN", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"})}</small>
    </button>)}
    {loading && <p role="status">读取中，当前仍显示上次成功读取的页码与记录…</p>}
    {error && <p role="alert">{error}<button disabled={loading} onClick={() => setRetry(value => value+1)}>重试</button></p>}
    {!!page?.total && <div className="history-pages"><button disabled={loading || shownOffset === 0} onClick={() => setOffset(Math.max(0, shownOffset-12))}>上一页</button><span>{shownOffset+1}–{shownOffset+page.items.length} / {page.total}</span><button disabled={loading || shownOffset+12 >= page.total} onClick={() => setOffset(shownOffset+12)}>查看更多</button></div>}
    {reportPage?.items.map(item => <button className="report-history-item" key={item.id} title={item.title} onClick={() => onReport(item.id)}><span>{item.title}</span></button>)}
    {!!reportPage?.total && <div className="history-pages"><button disabled={loading || shownReports === 0} onClick={() => setReportOffset(Math.max(0, shownReports-8))}>上页报告</button><span>{shownReports+1}–{shownReports+reportPage.items.length} / {reportPage.total}</span><button disabled={loading || shownReports+8 >= reportPage.total} onClick={() => setReportOffset(shownReports+8)}>更多报告</button></div>}
  </details>;
}
