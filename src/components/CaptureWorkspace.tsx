import {
  ArrowUpRight,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Database,
  FileJson2,
  Filter,
  History,
  KeyRound,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldOff,
  Trash2,
  UnlockKeyhole,
  Wifi,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type {
  Batch,
  CaptureStatus,
  RequestDetail,
  RequestSummary,
  RuleType,
  ThrottleStatus,
} from "../types";
import {
  formatBytes,
  formatDuration,
  formatTime,
  methodTone,
  shortPath,
  statusTone,
} from "../lib/format";

interface Filters {
  query: string;
  method: string;
  status: string;
  sourceIp: string;
}

interface Props {
  capture: CaptureStatus;
  throttle: ThrottleStatus;
  currentBatch: Batch;
  batches: Batch[];
  requests: RequestSummary[];
  selected: RequestSummary | null;
  detail: RequestDetail | null;
  detailLoading: boolean;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onBatchSelect: (id: string) => Promise<void>;
  onNewBatch: () => Promise<void>;
  onClearBatch: () => Promise<void>;
  onSelect: (request: RequestSummary) => void;
  onAddToAI: (request: RequestSummary) => void;
  onRule: (type: RuleType, source: string) => void;
  onDecrypt: (host: string, enabled: boolean) => Promise<void>;
  onRules: () => void;
  onPhone: () => void;
  onThrottle: () => void;
  busy: boolean;
  error: string | null;
}

function BodyPanel({ text, body, truncated }: { text: string | null; body: RequestDetail["requestBody"]; truncated: boolean }) {
  const [pretty, setPretty] = useState(true);
  if (!text && !body) return <div className="empty-detail">没有记录正文</div>;
  if (body?.base64) {
    return <div className="image-preview"><img src={`data:${body.mime};base64,${body.base64}`} alt="抓包图片" /></div>;
  }
  let content = text || "";
  if (pretty && (content.trim().startsWith("{") || content.trim().startsWith("["))) {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Keep the original text when it is not valid JSON.
    }
  }
  return (
    <div className="body-panel">
      <div className="body-toolbar">
        <span>{body ? formatBytes(body.size) : "—"}</span>
        {truncated && <span className="warning-pill">已截断</span>}
        <button className={`tiny-toggle ${pretty ? "active" : ""}`} onClick={() => setPretty((value) => !value)}>格式化</button>
      </div>
      <pre className="body-code"><code>{content}</code></pre>
    </div>
  );
}

function HeadersTable({ headers }: { headers: [string, string][] }) {
  if (!headers.length) return <div className="empty-detail">没有 Header</div>;
  return (
    <div className="headers-table">
      {headers.map(([name, value], index) => (
        <div className="header-row" key={`${name}-${index}`}>
          <div className="header-name">{name}</div>
          <div className="header-value">{value}</div>
        </div>
      ))}
    </div>
  );
}

export function CaptureWorkspace({
  capture,
  throttle,
  currentBatch,
  batches,
  requests,
  selected,
  detail,
  detailLoading,
  filters,
  onFilters,
  onStart,
  onPause,
  onStop,
  onBatchSelect,
  onNewBatch,
  onClearBatch,
  onSelect,
  onAddToAI,
  onRule,
  onDecrypt,
  onRules,
  onPhone,
  onThrottle,
  busy,
  error,
}: Props) {
  const [tab, setTab] = useState<"overview" | "request" | "response" | "timing">("overview");
  const [openHosts, setOpenHosts] = useState<Record<string, boolean>>({});
  const [openPaths, setOpenPaths] = useState<Record<string, boolean>>({});
  const decryptAll = capture.decryptHosts.includes("*");

  const tree = useMemo(() => {
    const hosts = new Map<string, Map<string, RequestSummary[]>>();
    for (const request of requests) {
      if (!hosts.has(request.host)) hosts.set(request.host, new Map());
      const paths = hosts.get(request.host)!;
      const path = request.path.split("?")[0] || "/";
      if (!paths.has(path)) paths.set(path, []);
      paths.get(path)!.push(request);
    }
    return [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [requests]);

  const decodedHost = detail ? decryptAll || capture.decryptHosts.some((pattern) => {
    if (pattern.startsWith("*.")) return detail.host.endsWith(pattern.slice(1));
    return pattern === detail.host;
  }) : false;

  return (
    <div className="capture-workspace">
      <section className="capture-toolbar">
        <div className="capture-controls">
          {capture.running ? (
            <>
              <button className="button ghost compact" onClick={onPause} disabled={busy}>
                {capture.paused ? <Play size={14} /> : <Pause size={14} />}
                {capture.paused ? "继续记录" : "暂停记录"}
              </button>
              <button className="button ghost compact danger-hover" onClick={onStop} disabled={busy}>
                <CircleStop size={14} /> 停止代理
              </button>
            </>
          ) : (
            <button className="button primary compact" onClick={onStart} disabled={busy}>
              <Play size={14} fill="currentColor" /> {busy ? "正在启动" : "开始抓包"}
            </button>
          )}
          <span className="toolbar-separator" />
          <button className="button ghost compact" onClick={() => void onNewBatch()}><Database size={14} /> 新建批次</button>
          <button className="button ghost compact" onClick={() => void onClearBatch()}><Trash2 size={14} /> 清空</button>
        </div>

        <div className="capture-meta">
          <span className={`capture-beacon ${capture.running && !capture.paused ? "active" : ""}`} />
          <span>{capture.running ? (capture.paused ? "仍转发 · 不记录" : `${capture.requestCount} 个请求`) : "未监听"}</span>
          <span className="toolbar-divider" />
          <button
            className={`meta-action ${decryptAll ? "active" : ""}`}
            title={decryptAll ? "关闭全部 HTTPS 解密" : "开启全部 HTTPS 解密"}
            onClick={() => void onDecrypt("*", !decryptAll)}
          >
            {decryptAll ? <UnlockKeyhole size={14} /> : <LockKeyhole size={14} />}
            {decryptAll ? "HTTPS 解密中" : "开启 HTTPS 解密"}
          </button>
          <button className={`meta-action ${capture.lan ? "active" : ""}`} onClick={onPhone}>
            <Wifi size={14} /> {capture.lan ? `${capture.localIp}:${capture.port}` : "连接手机"}
          </button>
          <button className={`meta-action ${throttle.enabled ? "active" : ""}`} onClick={onThrottle}>
            <Clock3 size={14} /> {throttle.enabled ? `弱网 ${throttle.downKbPerSecond || "∞"} KB/s` : "弱网关闭"}
          </button>
          <button className="meta-action" onClick={onRules}><FileJson2 size={14} /> {batches.length} 个批次</button>
        </div>
      </section>

      <section className="filterbar">
        <div className="filter-search"><Search size={14} /><input value={filters.query} placeholder="筛选 URL 或 Host" onChange={(event) => onFilters({ ...filters, query: event.target.value })} /></div>
        <div className="filter-select"><Filter size={13} /><select value={filters.method} onChange={(event) => onFilters({ ...filters, method: event.target.value })}><option value="">全部方法</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>CONNECT</option></select></div>
        <div className="filter-select"><select value={filters.status} onChange={(event) => onFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option><option value="200">2xx</option><option value="300">3xx</option><option value="400">4xx</option><option value="500">5xx</option></select></div>
        <div className="filter-select device-filter"><select value={filters.sourceIp} onChange={(event) => onFilters({ ...filters, sourceIp: event.target.value })}><option value="">全部设备</option>{[...new Set(requests.map((item) => item.sourceIp).filter(Boolean))].map((ip) => <option key={ip!} value={ip!}>{ip}</option>)}</select></div>
        <div className="batch-picker"><History size={13} /><select value={currentBatch.id} onChange={(event) => void onBatchSelect(event.target.value)}>{batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.label} · {batch.request_count ?? batch.requestCount ?? 0}</option>)}</select></div>
      </section>

      {error && <div className="capture-error"><Ban size={14} /> {error}</div>}

      <div className="capture-body">
        <aside className="request-tree">
          <div className="tree-head">
            <span>HOST / PATH</span>
            <span>{requests.length}</span>
          </div>
          <div className="tree-scroll">
            {tree.length === 0 ? (
              <div className="tree-empty">
                <div className="tree-empty-mark"><ArrowUpRight size={20} /></div>
                <h3>{capture.running ? "等待第一个请求" : "抓包工作区还未启动"}</h3>
                <p>{capture.running ? "把设备代理指向这里，请求会按 Host 和 Path 分组。" : "启动代理不会自动修改系统设置，手机可通过局域网手动接入。"}</p>
                {!capture.running && <button className="button primary compact" onClick={onStart}><Play size={14} /> 开始抓包</button>}
              </div>
            ) : tree.map(([host, paths]) => {
              const hostOpen = openHosts[host] !== false;
              const hostRequests = [...paths.values()].flat();
              const hostEncrypted = hostRequests.every((item) => item.encrypted);
              const hostDecoded = decryptAll || capture.decryptHosts.some((pattern) =>
                pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : pattern === host,
              );
              return (
                <div className="host-group" key={host}>
                  <button className="host-row" onClick={() => setOpenHosts((value) => ({ ...value, [host]: !hostOpen }))}>
                    {hostOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className={`host-favicon ${hostEncrypted ? "locked" : ""}`}>{hostEncrypted ? <LockKeyhole size={11} /> : host.slice(0, 1).toUpperCase()}</span>
                    <span className="host-name">{host}</span>
                    <span className="host-count">{hostRequests.length}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      className={`decrypt-toggle ${hostDecoded ? "active" : ""}`}
                      title={decryptAll ? "全部 HTTPS 解密已开启" : hostDecoded ? "关闭此域 HTTPS 解密" : "解密此域 HTTPS"}
                      onClick={(event) => { event.stopPropagation(); if (!decryptAll) void onDecrypt(host, !hostDecoded); }}
                      onKeyDown={(event) => { if (event.key === "Enter" && !decryptAll) { event.stopPropagation(); void onDecrypt(host, !hostDecoded); } }}
                    >
                      {hostDecoded ? <UnlockKeyhole size={11} /> : <KeyRound size={11} />}
                    </span>
                  </button>
                  {hostOpen && [...paths.entries()].map(([path, entries]) => {
                    const pathKey = `${host}:${path}`;
                    const pathOpen = openPaths[pathKey] !== false;
                    const latest = entries[entries.length - 1];
                    return (
                      <div className="path-group" key={pathKey}>
                        <button className="path-row" onClick={() => setOpenPaths((value) => ({ ...value, [pathKey]: !pathOpen }))}>
                          {pathOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span className={`method-dot ${methodTone(latest.method)}`} />
                          <span className="path-name">{path}</span>
                          <span className="path-count">{entries.length > 1 ? entries.length : ""}</span>
                        </button>
                        {pathOpen && entries.map((request) => (
                          <button
                            className={`request-row ${selected?.id === request.id ? "active" : ""}`}
                            key={request.id}
                            onClick={() => onSelect(request)}
                          >
                            <span className={`method-badge ${methodTone(request.method)}`}>{request.method}</span>
                            <span className="request-query">{shortPath(request.path).replace(path, "") || "/"}</span>
                            <span className={`status-code ${statusTone(request.status)}`}>{request.status || (request.encrypted ? "TLS" : "—")}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </aside>

        <main className="request-detail">
          {!selected ? (
            <div className="detail-placeholder">
              <div className="detail-grid-mark" />
              <div className="eyebrow">REQUEST INSPECTOR</div>
              <h2>选择一条请求查看细节</h2>
              <p>重复路径不会互相覆盖；每次请求都保留自己的方法、状态、来源和耗时。</p>
            </div>
          ) : (
            <>
              <div className="detail-head">
                <div className="request-title-row">
                  <span className={`method-badge large ${methodTone(selected.method)}`}>{selected.method}</span>
                  <div className="request-title">
                    <h2>{selected.host}</h2>
                    <code>{shortPath(selected.path)}</code>
                  </div>
                  <div className="request-head-actions">
                    <button className="button ghost compact" onClick={() => onAddToAI(selected)}><Bot size={14} /> 交给 AI</button>
                    <button className="button ghost compact" onClick={() => onRule("local", selected.url)}>Map Local</button>
                    <button className="button ghost compact" onClick={() => onRule("remote", selected.url)}>Map Remote</button>
                  </div>
                </div>
                <div className="request-facts">
                  <span className={`status-fact ${statusTone(selected.status)}`}>{selected.status || "—"} {selected.status ? "STATUS" : ""}</span>
                  <span><Clock3 size={12} /> {formatDuration(selected.durationMs)}</span>
                  <span><Database size={12} /> {formatBytes(selected.size)}</span>
                  <span><Wifi size={12} /> {selected.sourceIp || "本机"}</span>
                  <span>{formatTime(selected.startedAt)}</span>
                </div>
                {(selected.matchedRule || selected.actualUrl || selected.ruleError || selected.error || selected.encrypted) && (
                  <div className="rule-traces">
                    {selected.encrypted && <span className="trace-chip locked"><LockKeyhole size={12} /> HTTPS 已透传 · 需开启域名解密</span>}
                    {selected.matchedRule && <span className="trace-chip rule"><RotateCcw size={12} /> 命中规则 {selected.matchedRule.slice(-6)}</span>}
                    {selected.actualUrl && <span className="trace-chip">实际上游 {selected.actualUrl}</span>}
                    {selected.tlsError && <span className="trace-chip error"><ShieldOff size={12} /> {selected.tlsError}</span>}
                    {selected.ruleError && <span className="trace-chip error">规则错误：{selected.ruleError}</span>}
                    {selected.error && <span className="trace-chip error">{selected.error}</span>}
                  </div>
                )}
              </div>

              <div className="detail-tabs">
                {(["overview", "request", "response", "timing"] as const).map((key) => (
                  <button className={tab === key ? "active" : ""} key={key} onClick={() => setTab(key)}>
                    {{ overview: "概要", request: "请求", response: "响应", timing: "耗时" }[key]}
                  </button>
                ))}
              </div>

              <div className="detail-scroll">
                {detailLoading && <div className="detail-loading"><span className="spinner" /> 正在读取请求正文…</div>}
                {!detailLoading && !detail && <div className="empty-detail">详情读取失败</div>}
                {detail && tab === "overview" && (
                  <div className="overview-grid">
                    <section className="overview-block full">
                      <div className="block-head"><span>GENERAL</span></div>
                      <dl className="fact-list">
                        <dt>请求 URL</dt><dd className="break">{detail.url}</dd>
                        <dt>实际上游</dt><dd className="break">{detail.actualUrl || detail.url}</dd>
                        <dt>协议</dt><dd>{detail.scheme.toUpperCase()}{detail.encrypted ? " · CONNECT" : ""}</dd>
                        <dt>内容类型</dt><dd>{detail.contentType || "—"}</dd>
                        <dt>来源设备</dt><dd>{detail.sourceIp || "—"}</dd>
                        <dt>请求时间</dt><dd>{new Date(detail.startedAt).toLocaleString("zh-CN")}</dd>
                      </dl>
                    </section>
                    <section className="overview-block">
                      <div className="block-head"><span>REQUEST</span><small>{formatBytes(detail.requestBodySize)}</small></div>
                      <div className="mini-code">{detail.requestBodyText ? detail.requestBodyText.slice(0, 900) : "无正文"}</div>
                    </section>
                    <section className="overview-block">
                      <div className="block-head"><span>RESPONSE</span><small>{formatBytes(detail.responseBodySize)}</small></div>
                      <div className="mini-code">{detail.responseBodyText ? detail.responseBodyText.slice(0, 900) : "无正文"}</div>
                    </section>
                  </div>
                )}
                {detail && tab === "request" && (
                  <div className="detail-section">
                    <div className="section-heading"><h3>Request Headers</h3><span>{detail.requestHeaders.length}</span></div>
                    <HeadersTable headers={detail.requestHeaders} />
                    <div className="section-heading spaced"><h3>Request Body</h3></div>
                    <BodyPanel text={detail.requestBodyText} body={detail.requestBody} truncated={detail.requestTruncated} />
                  </div>
                )}
                {detail && tab === "response" && (
                  <div className="detail-section">
                    <div className="section-heading"><h3>Response Headers</h3><span>{detail.responseHeaders.length}</span></div>
                    <HeadersTable headers={detail.responseHeaders} />
                    <div className="section-heading spaced"><h3>Response Body</h3></div>
                    <BodyPanel text={detail.responseBodyText} body={detail.responseBody} truncated={detail.responseTruncated} />
                  </div>
                )}
                {detail && tab === "timing" && (
                  <div className="timing-panel">
                    <div className="timing-hero"><span>{formatDuration(detail.durationMs)}</span><small>TOTAL DURATION</small></div>
                    <div className="timing-track"><div className="timing-fill" style={{ width: "100%" }} /></div>
                    <div className="timing-grid">
                      <div><span>开始</span><b>{formatTime(detail.startedAt)}</b></div>
                      <div><span>来源</span><b>{detail.sourceIp}</b></div>
                      <div><span>响应大小</span><b>{formatBytes(detail.size)}</b></div>
                      <div><span>状态</span><b>{detail.status ?? "无响应"}</b></div>
                    </div>
                    <p className="timing-note">耗时来自代理观察到的完整请求生命周期；弱网延迟会计入这里。</p>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
