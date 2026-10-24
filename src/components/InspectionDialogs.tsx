import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  GitCompareArrows,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Repeat2,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "./Dialogs";
import type {
  AggregateResult,
  ChecklistResult,
  DuplicateResult,
  RequestComparison,
  Scenario,
  ScenarioComparison,
  WaterfallResult,
} from "../types";
import { formatDuration, formatTime } from "../lib/format";

function ValueCell({ value }: { value: unknown }) {
  if (value == null) return <span className="diff-empty">∅</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre>{text}</pre>;
}

export function ComparisonDialog({
  open,
  comparison,
  loading,
  onClose,
  onEvidence,
}: {
  onEvidence: (requestId: string, direction: string, locator: string | null, version?: number) => void;
  open: boolean;
  comparison: RequestComparison | null;
  loading: boolean;
  onClose: () => void;
}) {
  const [showIgnored, setShowIgnored] = useState(false);
  useEffect(() => {
    if (open) setShowIgnored(false);
  }, [open]);
  const visible = comparison
    ? comparison.differences.filter((item) => showIgnored || !item.ignored)
    : [];
  return (
    <Dialog open={open} title="请求字段对比" kicker="HEADER · QUERY · JSON POINTER" wide onClose={onClose}>
      {loading && <div className="dialog-loading"><LoaderCircle className="spin" size={16} /> 正在读取并脱敏对比字段…</div>}
      {!loading && comparison && (
        <>
          <div className="comparison-summary">
            <div className="comparison-side">
              <span className="eyebrow">A · {formatTime(comparison.a.startedAt)}</span>
              <b>{comparison.a.method} {comparison.a.status ?? "—"}</b>
              <code>{comparison.a.url}</code>
              <small>v{comparison.a.version} · {formatDuration(comparison.a.durationMs)}</small>
            </div>
            <GitCompareArrows size={20} />
            <div className="comparison-side">
              <span className="eyebrow">B · {formatTime(comparison.b.startedAt)}</span>
              <b>{comparison.b.method} {comparison.b.status ?? "—"}</b>
              <code>{comparison.b.url}</code>
              <small>v{comparison.b.version} · {formatDuration(comparison.b.durationMs)}</small>
            </div>
          </div>
          <div className="diff-toolbar">
            <span>{visible.length} 个差异 · {comparison.sameCount} 个相同字段</span>
            {comparison.ignored.length > 0 && (
              <label className="filter-check">
                <input type="checkbox" checked={showIgnored} onChange={(event) => setShowIgnored(event.target.checked)} />
                显示 {comparison.ignored.length} 个动态字段
              </label>
            )}
          </div>
          <div className="diff-table">
            <div className="diff-row diff-head-row">
              <span>类型 / 路径</span><span>A</span><span>B</span>
            </div>
            {visible.map((item, index) => (
              <div className={`diff-row ${item.ignored ? "ignored" : ""}`} key={`${item.kind}-${item.path}-${index}`}>
                <div className="diff-locator">
                  <span className="diff-kind">{item.kind}</span>
                  <code>{item.path}</code>
                  {item.ignored && <small>动态字段忽略</small>}
                </div>
                <div className="diff-value a"><ValueCell value={item.a} /><button className="button ghost compact" onClick={() => onEvidence(comparison.a.id, item.direction || "overview", item.locator || null, comparison.a.version)}>查看 A 来源</button></div>
                <div className="diff-value b"><ValueCell value={item.b} /><button className="button ghost compact" onClick={() => onEvidence(comparison.b.id, item.direction || "overview", item.locator || null, comparison.b.version)}>查看 B 来源</button></div>
              </div>
            ))}
            {visible.length === 0 && <div className="empty-detail">当前字段没有可见差异。</div>}
          </div>
          <div className="boundary-note">
            <AlertTriangle size={14} />
            对比只覆盖代理已保存的 Header、Query 与正文；正文状态为
            {" "}{comparison.limits.bodyStates.a.request}/{comparison.limits.bodyStates.a.response}
            {" "}与 {comparison.limits.bodyStates.b.request}/{comparison.limits.bodyStates.b.response}。
            动态字段仍展示但不会参与“有效差异”判断。
          </div>
        </>
      )}
    </Dialog>
  );
}

export function ScenarioCompareDialog({
  open,
  scenarios,
  result,
  busy,
  onCompare,
  onSelectRequest,
  onClose,
}: {
  open: boolean;
  scenarios: Scenario[];
  result: ScenarioComparison | null;
  busy: boolean;
  onCompare: (a: string, b: string) => Promise<void>;
  onSelectRequest: (id: string) => void;
  onClose: () => void;
}) {
  const ended = scenarios.filter((item) => item.status === "ended");
  const selectable = ended.length >= 2 ? ended : scenarios;
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  useEffect(() => {
    if (!open) return;
    setA(selectable[0]?.id || "");
    setB(selectable[1]?.id || "");
  }, [open, scenarios]);
  return (
    <Dialog open={open} title="成功 / 失败场景对比" kicker="SCENARIO PAIRING" wide onClose={onClose}>
      <div className="scenario-compare-controls">
        <label className="field"><span>场景 A</span><select value={a} onChange={(event) => setA(event.target.value)}>{selectable.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.requestCount} 条</option>)}</select></label>
        <GitCompareArrows size={18} />
        <label className="field"><span>场景 B</span><select value={b} onChange={(event) => setB(event.target.value)}>{selectable.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.requestCount} 条</option>)}</select></label>
        <button className="button primary compact self-end" disabled={!a || !b || a === b || busy} onClick={() => void onCompare(a, b)}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <GitCompareArrows size={14} />} 开始配对
        </button>
      </div>
      {selectable.length < 2 && <div className="empty-detail">至少需要两个场景才能对比。可先结束一次失败操作，再记录一次成功操作。</div>}
      {result && (
        <>
          <div className="scenario-compare-summary">
            <span><b>{result.aCount}</b> A 样本</span>
            <span><b>{result.bCount}</b> B 样本</span>
            <span><b>{result.pairs.length}</b> 已配对接口</span>
            <span><b>{result.unpaired.length}</b> 未配对实例</span>
          </div>
          <div className="run-table scenario-pair-table">
            {result.pairs.map((pair) => (
              <button className="run-table-row" key={`${pair.aId}-${pair.bId}`} onClick={() => onSelectRequest(pair.aId)}>
                <span className="status-pill active">{pair.differenceCount} DIFF</span>
                <div><b>{pair.key}</b><span>{pair.aId} ↔ {pair.bId}</span></div>
                <span>A {pair.comparison.a.status ?? "—"}</span>
                <span>B {pair.comparison.b.status ?? "—"}</span>
                <span>{formatDuration(pair.comparison.a.durationMs)} / {formatDuration(pair.comparison.b.durationMs)}</span>
              </button>
            ))}
            {result.pairs.length === 0 && <div className="empty-detail">没有可配对接口；请检查场景是否包含同一业务链路。</div>}
          </div>
          {result.unpaired.length > 0 && (
            <div className="unpaired-list">
              <b>未配对实例</b>
              {result.unpaired.map((item) => (
                <button key={`${item.scenario}-${item.id}`} onClick={() => onSelectRequest(item.id)}>
                  <span className={`status-pill ${item.scenario === "a" ? "" : "active"}`}>场景 {item.scenario.toUpperCase()}</span>
                  <code>{item.key}</code>
                  <small>{item.id}</small>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

export function AggregateDialog({
  open,
  result,
  busy,
  groupBy,
  onGroupBy,
  onLoad,
  onSelectRequest,
  onClose,
}: {
  open: boolean;
  result: AggregateResult | null;
  busy: boolean;
  groupBy: string;
  onGroupBy: (value: string) => void;
  onLoad: () => Promise<void>;
  onSelectRequest: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} title="接口聚合与耗时" kicker="FAILURE RATE · P50 · P95" wide onClose={onClose}>
      <div className="aggregate-controls">
        <label className="field"><span>聚合维度</span><select value={groupBy} onChange={(event) => onGroupBy(event.target.value)}>
          <option value="endpoint">接口</option>
          <option value="status">HTTP 状态</option>
          <option value="business">业务状态</option>
          <option value="device">设备</option>
        </select></label>
        <button className="button primary compact" disabled={busy} onClick={() => void onLoad()}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 重新聚合
        </button>
      </div>
      {result && (
        <>
          <div className="aggregate-summary">
            <span><b>{result.totalSamples.toLocaleString()}</b> 匹配样本</span>
            <span><b>{result.coverage.batchCount.toLocaleString()}</b> 批次总量</span>
            <span><b>{result.groups.length}</b> 聚合组</span>
          </div>
          <div className="aggregate-grid">
            {result.groups.slice(0, 200).map((group) => (
              <button className="aggregate-card" key={group.key} onClick={() => group.sampleIds[0] && onSelectRequest(group.sampleIds[0])}>
                <div><b>{group.key}</b><span>{group.count} samples</span></div>
                <div className="aggregate-metrics">
                  <span className={group.failureCount ? "bad" : "good"}>{(group.failureRate * 100).toFixed(1)}% fail</span>
                  <span>P50 {formatDuration(group.p50Ms)}</span>
                  <span>P95 {formatDuration(group.p95Ms)}</span>
                  <span>MAX {formatDuration(group.maxMs)}</span>
                  <span className={`status-code ${(group.latestStatus || 0) >= 400 ? "bad" : "good"}`}>{group.latestStatus ?? "—"}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      {busy && !result && <div className="dialog-loading"><LoaderCircle className="spin" size={16} /> 正在计算聚合指标…</div>}
    </Dialog>
  );
}

export function DuplicateDialog({
  open,
  result,
  busy,
  onLoad,
  onSelectRequest,
  onClose,
}: {
  open: boolean;
  result: DuplicateResult | null;
  busy: boolean;
  onLoad: () => Promise<void>;
  onSelectRequest: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} title="重复、轮询与重试候选" kicker="TEMPORAL PATTERN DETECTION" wide onClose={onClose}>
      <div className="aggregate-controls">
        <span className="muted small">按方法 + URL 做时间统计；不等同于确认业务重试。</span>
        <button className="button ghost compact" disabled={busy} onClick={() => void onLoad()}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Repeat2 size={14} />} 重新识别
        </button>
      </div>
      {result && (
        <>
          <div className="aggregate-summary">
            <span><b>{result.coverage.samples.toLocaleString()}</b> 样本</span>
            <span><b>{result.patterns.length}</b> 重复模式</span>
          </div>
          <div className="pattern-list">
            {result.patterns.map((pattern) => (
              <button className="pattern-card" key={pattern.key} onClick={() => onSelectRequest(pattern.requestIds[0])}>
                <span className={`pattern-type ${pattern.pattern}`}>{pattern.pattern === "polling" ? "POLLING" : "REPEAT"}</span>
                <div><b>{pattern.key}</b><small>{pattern.boundary}</small></div>
                <span><b>{pattern.count}</b> 次</span>
                <span>平均间隔 {formatDuration(pattern.averageIntervalMs)}</span>
              </button>
            ))}
            {result.patterns.length === 0 && <div className="empty-detail">当前范围没有达到 3 次的重复接口。</div>}
          </div>
        </>
      )}
    </Dialog>
  );
}

export function WaterfallDialog({
  open,
  initialTraceId,
  result,
  loading,
  onLoad,
  onSelectRequest,
  onClose,
}: {
  open: boolean;
  initialTraceId: string;
  result: WaterfallResult | null;
  loading: boolean;
  onLoad: (traceId: string) => Promise<void>;
  onSelectRequest: (id: string) => void;
  onClose: () => void;
}) {
  const [traceId, setTraceId] = useState(initialTraceId);
  useEffect(() => {
    if (!open) return;
    setTraceId(initialTraceId);
    if (initialTraceId) void onLoad(initialTraceId);
  }, [open, initialTraceId]);
  const services = useMemo(() => new Set(result?.entries.map((item) => item.serviceName) || []), [result]);
  return (
    <Dialog open={open} title="跨服务调用瀑布" kicker="PROXY OBSERVED + IMPORTED SPANS" wide onClose={onClose}>
      <div className="waterfall-search">
        <label className="field"><span>W3C Trace ID</span><input value={traceId} onChange={(event) => setTraceId(event.target.value.trim())} placeholder="32 位十六进制 Trace ID" /></label>
        <button className="button primary compact self-end" disabled={!traceId || loading} onClick={() => void onLoad(traceId)}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />} 读取瀑布
        </button>
      </div>
      {result && (
        <>
          <div className="waterfall-coverage">
            <span><Layers3 size={13} /> {services.size} 个服务</span>
            <span>{result.coverage.proxyRequests} 条代理请求</span>
            <span>{result.coverage.importedSpans} 个导入 Span</span>
            {(result.coverage.sampledSpans || 0) > 0 && <span>{result.coverage.sampledSpans} 个已采样</span>}
            {result.coverage.unsampledSpans > 0 && <span className="warning-pill">{result.coverage.unsampledSpans} 个未采样</span>}
            {(result.coverage.missingParentSpans || 0) > 0 && <span className="warning-pill">{result.coverage.missingParentSpans} 个父 Span 缺失</span>}
            {(result.coverage.asyncLinks || 0) > 0 && <span>{result.coverage.asyncLinks} 个异步 Link</span>}
            {(result.coverage.clockSkewCandidates || 0) > 0 && <span className="warning-pill">{result.coverage.clockSkewCandidates} 个时钟偏差候选</span>}
          </div>
          <div className="waterfall-chart">
            {result.entries.map((entry) => (
              <button
                className={`waterfall-row ${entry.kind} ${entry.sampled === false ? "unsampled" : ""}`}
                key={`${entry.kind}-${entry.id}`}
                disabled={entry.kind !== "proxy-request"}
                onClick={() => onSelectRequest(entry.id)}
              >
                <div className="waterfall-label" style={{ paddingLeft: `${Math.min(entry.depth || 0, 6) * 12}px` }}>
                  <span>{entry.serviceName}</span>
                  <b>{entry.name}</b>
                  <small className="waterfall-meta">
                    {entry.connectionType || "unlinked"}
                    {entry.spanKind != null ? ` · kind ${entry.spanKind}` : ""}
                    {entry.sampled === false ? " · UNSAMPLED" : ""}
                    {entry.clockSkewMs != null ? ` · clock ${Math.round(entry.clockSkewMs)}ms` : ""}
                    {entry.parentSpanId ? ` · parent ${entry.parentSpanId.slice(0, 8)}` : ""}
                    {entry.links?.length ? ` · ${entry.links.length} link` : ""}
                  </small>
                </div>
                <div className="waterfall-track">
                  <span
                    className="waterfall-bar"
                    style={{ left: `${entry.percentStart}%`, width: `${entry.percentWidth}%` }}
                    title={`${entry.startOffsetMs.toFixed(1)} ms + ${entry.durationMs.toFixed(1)} ms`}
                  />
                </div>
                <span className="waterfall-time">{formatDuration(entry.durationMs)}</span>
              </button>
            ))}
            {result.entries.length === 0 && <div className="empty-detail">该 Trace ID 没有代理请求或已导入 Span。</div>}
          </div>
          {result.entries.some(entry => entry.links?.length) && <div className="trace-associations"><h3>独立 Span Links</h3>{result.entries.flatMap(entry => (entry.links || []).map((link, index) => <button className="trace-association" key={`${entry.id}-${index}`} onClick={() => { const target = String(link.traceId || ""); setTraceId(target); void onLoad(target); }}><div><b>{entry.serviceName} · {entry.spanId}</b><small>parent 关系保持不变；{link.targetPresent ? "目标 Trace 已导入" : "目标 Trace 尚未导入，请补充本地 OTLP"}</small></div><code>→ {String(link.traceId)} / {String(link.spanId)}</code></button>))}</div>}
          {result.associations?.length > 0 && (
            <div className="trace-associations">
              <div className="section-heading"><h3>抓包与 Span 关联</h3><span>{result.associations.length} 条依据</span></div>
              {result.associations.map((association) => (
                <button
                  className={`trace-association ${association.confidence}`}
                  key={`${association.requestId}-${association.spanId}-${association.confidence}`}
                  onClick={() => onSelectRequest(association.requestId)}
                >
                  <span className="confidence-pill">{association.confidence === "explicit" ? "明确" : "候选"}</span>
                  <div><b>{association.serviceName || "未命名服务"}</b><small>{association.basis}</small></div>
                  <code>{association.requestId.slice(0, 8)} → {association.spanId.slice(0, 8)}</code>
                </button>
              ))}
            </div>
          )}
          <div className="boundary-note">
            <AlertTriangle size={14} />
            {result.coverage.gapStatement}
            代理只观察到经过本机的请求；未导入的服务端 Span 不会被推测补绘。异步调用可能只通过 Span Link 可见。
          </div>
        </>
      )}
    </Dialog>
  );
}

export function ChecklistDialog({
  open,
  result,
  loading,
  onClose,
}: {
  open: boolean;
  result: ChecklistResult | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} title="人工验证清单" kicker="QA VERIFICATION POINTS" wide onClose={onClose}>
      {loading && <div className="dialog-loading"><LoaderCircle className="spin" size={16} /> 正在整理事实与验证步骤…</div>}
      {result && (
        <>
          <div className="boundary-note"><ClipboardCheck size={14} />{result.note}</div>
          <div className="checklist-grid">
            {result.items.map((item) => (
              <section className="checklist-card" key={item.requestId}>
                <div className="checklist-card-head"><CheckCircle2 size={16} /><div><b>{item.title}</b><code>{item.requestId}</code></div></div>
                <h4>已观察事实</h4>
                <ul>{item.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                <h4>人工验证步骤</h4>
                <ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              </section>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
