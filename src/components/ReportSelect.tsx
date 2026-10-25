import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { call } from "../lib/api";
import type { ReportSummary } from "../types";
interface Page {items: ReportSummary[]; total: number; offset: number}
// Metadata-only paging keeps older reports available in the handoff selector.
export function ReportSelect({sessionId, value, onChange, recent}: {sessionId?: string; value: string; onChange: (id: string) => void; recent: ReportSummary[]}) {
  const [offset, setOffset] = useState(0), [retry, setRetry] = useState(0);
  const [page, setPage] = useState<Page | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const current = useRef(sessionId); current.current = sessionId;
  useEffect(() => { setPage(null); setOffset(0); }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let live = true; setLoading(true); setError("");
    void call<Page>("reports.history", {sessionId, offset, limit: 8}).then(result => { if (live && current.current === sessionId) setPage(result); })
      .catch(reason => { if (live && current.current === sessionId) setError(String(reason)); })
      .finally(() => { if (live && current.current === sessionId) setLoading(false); });
    return () => { live = false; };
  }, [sessionId, offset, retry, recent]);
  const items = page?.items || recent;
  return <div>
    <Select aria-label="报告" value={value} onChange={event => onChange(event.target.value)}>
      <option value="">选择报告</option>
      {value && !items.some(item => item.id === value) && <option value={value}>{recent.find(item => item.id === value)?.title || `已选择报告 ${value}`}</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </Select>
    {loading && <small role="status">读取报告摘要，保留原页…</small>}
    {error && <p role="alert">{error}<button disabled={loading} onClick={() => setRetry(item => item+1)}>重试</button></p>}
    {page && page.total > 8 && <div className="history-pages">
      <button disabled={loading || page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset-8))}>上页报告</button>
      <small>{page.offset+1}–{page.offset+page.items.length} / {page.total}</small>
      <button disabled={loading || page.offset+8 >= page.total} onClick={() => setOffset(page.offset+8)}>更多报告</button>
    </div>}
  </div>;
}
