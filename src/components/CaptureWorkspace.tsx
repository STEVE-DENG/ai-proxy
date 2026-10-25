import { Select } from "./Select";
import { DirectoryTree } from "./DirectoryTree";
import { attachFocusLayer } from "../lib/focus";
import { PanelResize } from "./PanelResize";
import { useRowHeight } from "../lib/display";
import {
  Activity,
  ArrowUpRight,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Columns3,
  Database,
  Download,
  ExternalLink,
  FileJson2,
  Filter,
  Folder,
  GitCompareArrows,
  History,
  KeyRound,
  Link2,
  ListTree,
  LoaderCircle,
  LockKeyhole,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldOff,
  Sparkles,
  Star,
  Tags,
  TimerReset,
  Trash2,
  UnlockKeyhole,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LiveRun } from "./AIWorkspace";
import type {
  AnalysisScope,
  Batch,
  BodyState,
  CaptureFilters,
  CaptureTreeNode,
  CaptureTreePayload,
  CaptureStatus,
  CaptureUiState,
  ConfigItem,
  ContentRead,
  Evidence,
  EvidenceTarget,
  RequestDetail,
  RequestPage,
  RequestSummary,
  RuleType,
  RunEvent,
  Scenario,
  ThrottleStatus,
} from "../types";
import { call } from "../lib/api";
import {
  formatBytes,
  formatDuration,
  formatTime,
  methodTone,
  shortPath,
  statusTone,
} from "../lib/format";

interface ScopeRequest {
  filters: CaptureFilters;
  selectedIds: string[];
  scenarioId?: string | null;
}

interface RelationPayload {
  edges: Array<{
    sourceId: string;
    targetId: string;
    type: string;
    confidence: string;
    basis: Record<string, unknown>;
    boundary: string;
  }>;
  traceGroups: Array<{ traceId: string; requestIds: string[] }>;
  approximateGroups: Array<{ key: string; requestIds: string[]; type: string; boundary: string }>;
  coverage: Record<string, unknown>;
}

interface Props {
  capture: CaptureStatus;
  throttle: ThrottleStatus;
  currentBatch: Batch;
  batches: Batch[];
  requestPage: RequestPage;
  selected: RequestSummary | null;
  detail: RequestDetail | null;
  detailLoading: boolean;
  evidenceTarget: EvidenceTarget | null;
  filters: CaptureFilters;
  filterOptions: { devices: string[]; hosts: string[]; environments: string[] };
  scenarios: Scenario[];
  multiSelected: string[];
  uiState: CaptureUiState;
  inlineOpen: boolean;
  live: LiveRun | null;
  events: RunEvent[];
  evidence: Evidence[];
  scope: AnalysisScope | null;
  relations: RelationPayload | null;
  agentBusy: boolean;
  busy: boolean;
  error: string | null;
  onFilters: (filters: CaptureFilters) => void;
  onLoadMore: () => Promise<void>;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onBatchSelect: (id: string) => Promise<void>;
  onNewBatch: () => Promise<void>;
  onClearBatch: (deleteReports: boolean) => Promise<void>;
  onSelect: (request: RequestSummary) => void;
  onMultiSelected: (ids: string[]) => void;
  onAddRelation: (sourceId: string, targetId: string) => Promise<void>;
  onUiState: (state: CaptureUiState) => void;
  onAddToAI: (request: RequestSummary) => void;
  onRule: (type: RuleType, source: string) => void;
  onDecrypt: (host: string, enabled: boolean) => Promise<void>;
  onRules: () => void;
  onPhone: () => void;
  onThrottle: () => void;
  onScenarioStart: (name: string, device: string) => Promise<void>;
  onScenarioEnd: (scenarioId: string) => Promise<void>;
  onAddScenarioRequest: (scenarioId: string, requestId: string, membership: "include" | "exclude") => Promise<void>;
  onCompare: () => void;
  onScenarioCompare: () => void;
  onExportHar: () => Promise<void>;
  onOpenWorkbench: (tab?: string) => void;
  onLoadRelations: () => Promise<void>;
  relationsLoading: boolean;
  relationsError: string | null;
  onAggregate: () => void;
  onDuplicates: () => void;
  onWaterfall: (traceId?: string) => void;
  onInlineOpen: () => void;
  onInlineClose: () => void;
  savedFilters: ConfigItem[];
  onSaveFilter: (name: string) => Promise<void>;
  onDeleteFilter: (configId: string) => Promise<void>;
  onFullAI: () => void;
  onAnalyze: (prompt: string, scope: ScopeRequest) => Promise<void>;
  onEvidenceSelect: (requestId: string, direction: string, locator: string | null) => void;
}

interface PathGroup {
  key: string;
  method: string;
  path: string;
  entries: RequestSummary[];
}

interface DirNode {
  name: string;
  path: string;
  children: Map<string, DirNode>;
  groups: PathGroup[];
}

function rootKey(request: RequestSummary): string {
  const defaultPort = request.scheme === "https" ? 443 : 80;
  const host = request.host.includes(":") && !request.host.startsWith("[") ? `[${request.host}]` : request.host;
  return `${request.scheme}://${host}${request.port === defaultPort ? "" : `:${request.port}`}`;
}

function buildDirectories(entries: RequestSummary[]): DirNode {
  const root: DirNode = { name: "", path: "", children: new Map(), groups: [] };
  for (const request of entries) {
    const pathname = request.path.split("?")[0] || "/";
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
      addGroup(root, request, "/");
      continue;
    }
    let node = root;
    let accumulated = "";
    for (const segment of segments) {
      accumulated += `/${segment}`;
      if (!node.children.has(segment)) {
        node.children.set(segment, {
          name: segment,
          path: accumulated,
          children: new Map(),
          groups: [],
        });
      }
      node = node.children.get(segment)!;
    }
    addGroup(node, request, pathname);
  }
  return root;
}

function addGroup(node: DirNode, request: RequestSummary, path: string) {
  const key = `${request.method} ${request.host}:${request.port}${path}`;
  let group = node.groups.find((item) => item.key === key);
  if (!group) {
    group = { key, method: request.method, path, entries: [] };
    node.groups.push(group);
  }
  group.entries.push(request);
}

function nodeEntries(node: DirNode): RequestSummary[] {
  return [
    ...node.groups.flatMap((group) => group.entries),
    ...[...node.children.values()].flatMap(nodeEntries),
  ];
}

function VirtualRequestList({
  items,
  renderRow,
  selectedId,
  rowHeight: configuredHeight,
  position,
  onPosition,
}: {
  rowHeight?: number;
  selectedId?: string;
  items: RequestSummary[];
  renderRow: (request: RequestSummary) => React.ReactNode;
  position?: { scrollTop: number; selectedId?: string };
  onPosition?: (position: { scrollTop: number; selectedId?: string }) => void;
}) {
  const displayHeight = useRowHeight();
  const rowHeight = configuredHeight || displayHeight;
  const [scrollTop, setScrollTop] = useState(position?.scrollTop || 0);
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledSelection = useRef<string | undefined>(position?.selectedId);
  const previousHeight = useRef(rowHeight);
  useLayoutEffect(() => {
    const node = listRef.current;
    if (node && previousHeight.current !== rowHeight) {
      const next = node.scrollTop / previousHeight.current * rowHeight;
      node.scrollTop = next; setScrollTop(next);
    }
    previousHeight.current = rowHeight;
  }, [rowHeight]);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = position?.scrollTop || 0;
  }, []);
  useEffect(() => {
    if (scrolledSelection.current === selectedId) return;
    const index = items.findIndex(item => item.id === selectedId);
    if (index < 0 || !listRef.current) return;
    scrolledSelection.current = selectedId;
    const top = index * rowHeight;
    if (top >= listRef.current.scrollTop && top + rowHeight <= listRef.current.scrollTop + listRef.current.clientHeight) return;
    listRef.current.scrollTop = Math.max(0, top - 56);
    setScrollTop(Math.max(0, top - 56));
    listRef.current.scrollIntoView({ block: "nearest" });
  }, [selectedId, items]);
  const viewportHeight = Math.min(320, Math.max(rowHeight, items.length * rowHeight));
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 10;
  return (
    <div
      ref={listRef}
      className="virtual-request-list"
      style={{ height: viewportHeight }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setScrollTop(top);
        onPosition?.({ scrollTop: top, selectedId });
      }}
    >
      <div style={{ height: items.length * rowHeight, position: "relative" }}>
        {items.slice(start, start + visibleCount).map((request, index) => (
          <div
            className="virtual-request-row"
            key={request.id}
            style={{ top: (start + index) * rowHeight, height: rowHeight }}
          >
            {renderRow(request)}
          </div>
        ))}
      </div>
    </div>
  );
}

function toDateTimeLocal(timestamp: number | null): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocal(value: string): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function BodyStateBadge({ state }: { state: BodyState }) {
  if (state === "available") return null;
  const labels: Record<string, string> = {
    pending: "等待正文",
    empty: "空正文",
    missing: "正文缺失",
    "stream-not-saved": "流式未保存",
    "capture-truncated": "采集截断",
    "connect-tunnel": "加密隧道",
    "decode-failed": "解码失败",
  };
  return <span className={`body-state-badge ${state}`}>{labels[state] || state}</span>;
}

type ParsedEvidenceLocator =
  | { kind: "header"; direction: string; name: string }
  | { kind: "query"; key: string }
  | { kind: "status"; direction: string }
  | { kind: "chars"; direction: string; start: number; end: number }
  | { kind: "json"; direction: string; pointer: string }
  | { kind: "body"; direction: string }
  | { kind: "request"; direction: string }
  | { kind: "other"; direction: string };

function parseEvidenceLocator(locator: string | null, direction: string): ParsedEvidenceLocator | null {
  if (!locator) return null;
  const header = locator.match(/^(request|response)\/headers\/(.+)$/);
  if (header) return { kind: "header", direction: header[1], name: header[2] };
  if (locator.startsWith("url/query/")) {
    return { kind: "query", key: locator.slice("url/query/".length) };
  }
  const status = locator.match(/^(request|response)\/status$/);
  if (status) return { kind: "status", direction: status[1] };
  const chars = locator.match(/^(request|response)#chars\/(\d+)-(\d+)$/);
  if (chars) {
    return {
      kind: "chars",
      direction: chars[1],
      start: Number(chars[2]),
      end: Number(chars[3]),
    };
  }
  const pointer = locator.match(/^(request|response)#(.*)$/);
  if (pointer) return { kind: "json", direction: pointer[1], pointer: pointer[2] };
  if (locator === "request" || locator === "response") {
    return { kind: "body", direction: locator };
  }
  if (locator === direction) return { kind: "request", direction: locator };
  return { kind: "other", direction };
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function splitJsonPointer(pointer: string): string[] {
  return pointer.split("/").slice(1).map(decodePointerSegment);
}

function pathsEqual(left: string[], right: string[] | null): boolean {
  return Boolean(
    right
    && left.length === right.length
    && left.every((segment, index) => segment === right[index]),
  );
}

interface JsonLine {
  text: string;
  targeted: boolean;
}

function jsonValueLines(
  value: unknown,
  path: string[],
  targetPath: string[] | null,
  depth: number,
  memberKey?: string,
  trailingComma = false,
): JsonLine[] {
  const indent = "  ".repeat(depth);
  const label = memberKey == null ? "" : `${JSON.stringify(memberKey)}: `;
  const comma = trailingComma ? "," : "";
  const targeted = pathsEqual(path, targetPath);
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ text: `${indent}${label}[]${comma}`, targeted }];
    const lines: JsonLine[] = [{ text: `${indent}${label}[`, targeted }];
    value.forEach((item, index) => {
      lines.push(...jsonValueLines(item, [...path, String(index)], targetPath, depth + 1, undefined, index < value.length - 1));
    });
    lines.push({ text: `${indent}]${comma}`, targeted: false });
    return lines;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [{ text: `${indent}${label}{}${comma}`, targeted }];
    const lines: JsonLine[] = [{ text: `${indent}${label}{`, targeted }];
    entries.forEach(([key, item], index) => {
      lines.push(...jsonValueLines(item, [...path, key], targetPath, depth + 1, key, index < entries.length - 1));
    });
    lines.push({ text: `${indent}}${comma}`, targeted: false });
    return lines;
  }
  return [{ text: `${indent}${label}${JSON.stringify(value)}${comma}`, targeted }];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function QueryHighlight({ url, queryKey }: { url: string; queryKey: string | null }) {
  const targetRef = useRef<HTMLElement>(null);
  const decoded = (() => {
    try {
      return decodeURIComponent(queryKey || "");
    } catch {
      return queryKey || "";
    }
  })();
  let start = -1;
  let end = -1;
  if (queryKey) {
    const keys = [...new Set([queryKey, encodeURIComponent(queryKey), decoded])].filter(Boolean);
    const match = new RegExp(`[?&](?:${keys.map(escapeRegExp).join("|")})=[^&#]*`).exec(url);
    if (match?.index != null) {
      start = match.index + 1;
      end = match.index + match[0].length;
    }
  }
  useEffect(() => {
    if (start >= 0) requestAnimationFrame(() => targetRef.current?.scrollIntoView({ block: "center" }));
  }, [start, url]);
  if (start < 0 || end < 0) return <>{url}</>;
  return (
    <>
      {url.slice(0, start)}
      <mark ref={targetRef} className="evidence-mark">{url.slice(start, end)}</mark>
      {url.slice(end)}
    </>
  );
}

function BodyPanel({
  requestId,
  direction,
  text,
  body,
  state,
  locator,
  evidenceNonce,
}: {
  requestId: string;
  direction: "request" | "response";
  text: string | null;
  body: RequestDetail["requestBody"];
  state: BodyState;
  locator: string | null;
  evidenceNonce: number;
}) {
  const [pretty, setPretty] = useState(true);
  const [loadedText, setLoadedText] = useState(text ? text.slice(0, 16_000) : "");
  const [nextOffset, setNextOffset] = useState<number | null>(text && text.length > 16_000 ? 16_000 : null);
  const [storedSize, setStoredSize] = useState<number | null>(body?.size ?? null);
  const [contentBusy, setContentBusy] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const jsonTargetRef = useRef<HTMLSpanElement>(null);
  const textTargetRef = useRef<HTMLElement>(null);
  const parsedLocator = parseEvidenceLocator(locator, direction);
  const jsonPointer = parsedLocator?.kind === "json" ? parsedLocator.pointer : null;
  const charRange = parsedLocator?.kind === "chars" ? parsedLocator : null;

  useEffect(() => {
    const initial = text ? Array.from(text).slice(0, 16_000).join("") : "";
    setLoadedText(initial);
    setNextOffset(text != null && (body?.size || 0) > new TextEncoder().encode(initial).length ? Array.from(initial).length : null);
    setStoredSize(body?.size ?? null);
    setContentError(null);
  }, [requestId, direction, text, body?.size]);

  useEffect(() => {
    if (!locator) return;
    const timer = window.setTimeout(() => {
      const target = jsonTargetRef.current || textTargetRef.current;
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [evidenceNonce, locator, loadedText]);

  const [locatedValue, setLocatedValue] = useState<ContentRead | null>(null);
  useEffect(() => {
    setLocatedValue(null);
    if (parsedLocator?.kind !== "json" && parsedLocator?.kind !== "chars") return;
    let active = true;
    void call<ContentRead>("requests.content", { requestId, direction, ...(parsedLocator.kind === "json" ? { kind: "json-pointer", jsonPointer: parsedLocator.pointer } : { offset: parsedLocator.start, limit: Math.min(60000, parsedLocator.end - parsedLocator.start) }) }).then(result => { if (active) setLocatedValue(result); }).catch(reason => { if (active) setContentError(String(reason)); });
    return () => { active = false; };
  }, [requestId, direction, locator, evidenceNonce]);

  const loadChunk = async () => {
    if (nextOffset == null || contentBusy) return;
    setContentBusy(true);
    setContentError(null);
    try {
      const result = await call<ContentRead>("requests.content", {
        requestId,
        direction,
        offset: nextOffset,
        limit: 24_000,
        localRaw: true,
      });
      const chunk = typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2);
      setLoadedText((current) => current + chunk);
      setNextOffset(result.nextOffset ?? null);
      setStoredSize(result.storedSize ?? storedSize);
    } catch (reason) {
      setContentError(String(reason));
    } finally {
      setContentBusy(false);
    }
  };

  if (!text && !body) {
    return (
      <div className="body-unavailable">
        <FileJson2 size={18} />
        <b>{state === "stream-not-saved" ? "流式正文未保存" : state === "connect-tunnel" ? "仅捕获 CONNECT 隧道" : "没有可用正文"}</b>
        <span>可继续分析 Header、状态、规则影响和连接信息，但不能据此推断正文内容。</span>
      </div>
    );
  }
  if (locatedValue) {
    return <div className="body-content"><p>证据脱敏视图 · {locatedValue.locator} · v{locatedValue.requestVersion} · 脱敏视图</p><pre>{JSON.stringify(locatedValue, null, 2)}</pre></div>;
  }
  if (body?.base64) {
    return <div className="image-preview"><img src={`data:${body.mime};base64,${body.base64}`} alt="抓包图片" /></div>;
  }
  let content = loadedText || text || "";
  if (pretty && (content.trim().startsWith("{") || content.trim().startsWith("["))) {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Keep invalid JSON readable as plain text.
    }
  }
  let jsonLines: JsonLine[] | null = null;
  if (jsonPointer && content.trim()) {
    try {
      const parsed = JSON.parse(content);
      jsonLines = jsonValueLines(parsed, [], splitJsonPointer(jsonPointer), 0);
    } catch {
      jsonLines = null;
    }
  }
  const contentOffset = jsonLines ? 0 : charRange?.start ?? 0;
  const contentEnd = jsonLines ? 0 : charRange?.end ?? 0;
  const hasTextRange = !jsonLines && charRange && contentOffset < content.length;
  return (
    <div className="body-panel">
      <div className="body-toolbar">
        <span>{storedSize != null ? formatBytes(storedSize) : body ? formatBytes(body.size) : "—"}</span>
        <BodyStateBadge state={state} />
        <button className={`tiny-toggle ${pretty ? "active" : ""}`} onClick={() => setPretty((value) => !value)}>格式化</button>
        {nextOffset != null && (
          <button className="tiny-toggle" onClick={() => void loadChunk()} disabled={contentBusy}>
            {contentBusy ? "读取中…" : `继续读取 @${nextOffset.toLocaleString()}`}
          </button>
        )}
      </div>
      {contentError && <div className="body-read-error">{contentError}</div>}
      {jsonPointer && !jsonLines && (
        <div className="evidence-locator-warning">
          目标字段不在当前已加载正文中，或正文不是完整 JSON。可继续读取后再定位。
        </div>
      )}
      <pre className="body-code">
        <code>
          {jsonLines
            ? jsonLines.map((line, index) => (
              <span
                className={`body-json-line ${line.targeted ? "evidence-target" : ""}`}
                key={index}
                ref={line.targeted ? jsonTargetRef : undefined}
              >
                {line.text}{index < jsonLines.length - 1 ? "\n" : ""}
              </span>
            ))
            : hasTextRange
              ? (
                <>
                  {content.slice(0, contentOffset)}
                  <mark
                    className="evidence-mark"
                    ref={textTargetRef}
                  >
                    {content.slice(contentOffset, Math.min(contentEnd, content.length))}
                  </mark>
                  {content.slice(Math.min(contentEnd, content.length))}
                </>
              )
              : content}
        </code>
      </pre>
    </div>
  );
}

function HeadersTable({
  headers,
  highlightedName,
  evidenceNonce,
}: {
  headers: [string, string][];
  highlightedName?: string | null;
  evidenceNonce?: number;
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  const normalizedName = highlightedName?.toLowerCase() || "";
  useEffect(() => {
    if (!normalizedName) return;
    const timer = window.setTimeout(() => {
      targetRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [evidenceNonce, normalizedName]);
  if (!headers.length) return <div className="empty-detail">没有 Header</div>;
  return (
    <div className="headers-table">
      {headers.map(([name, value], index) => {
        const targeted = Boolean(normalizedName) && name.toLowerCase() === normalizedName;
        return (
        <div
          className={`header-row ${targeted ? "evidence-target" : ""}`}
          key={`${name}-${index}`}
          ref={targeted ? targetRef : undefined}
        >
          <div className="header-name">{name}</div>
          <div className="header-value">{value}</div>
        </div>
        );
      })}
    </div>
  );
}

export function CaptureWorkspace({
  capture,
  throttle,
  currentBatch,
  batches,
  requestPage,
  selected,
  detail,
  detailLoading,
  evidenceTarget,
  filters,
  filterOptions,
  scenarios,
  multiSelected,
  uiState,
  inlineOpen,
  live,
  events,
  evidence,
  scope,
  relations,
  agentBusy,
  busy,
  error,
  onFilters,
  onLoadMore,
  onStart,
  onPause,
  onStop,
  onBatchSelect,
  onNewBatch,
  onClearBatch,
  onSelect,
  onMultiSelected,
  onAddRelation,
  onUiState,
  onAddToAI,
  onRule,
  onDecrypt,
  onRules,
  onPhone,
  onThrottle,
  onScenarioStart,
  onScenarioEnd,
  onAddScenarioRequest,
  onCompare,
  onScenarioCompare,
  onExportHar,
  onOpenWorkbench,
  onLoadRelations,
  relationsLoading,
  relationsError,
  onAggregate,
  onDuplicates,
  onWaterfall,
  onInlineOpen,
  onInlineClose,
  savedFilters,
  onSaveFilter,
  onDeleteFilter,
  onFullAI,
  onAnalyze,
  onEvidenceSelect,
}: Props) {
  const rowHeight = useRowHeight();
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [timelineDescending, setTimelineDescending] = useState(false);
  const [savedFilterId, setSavedFilterId] = useState("");
  const [savedFilterName, setSavedFilterName] = useState("失败请求");
  const [savingFilter, setSavingFilter] = useState(false);
  const inlinePanel = useRef<HTMLElement>(null);
  const inlineCloseRef = useRef(onInlineClose);
  inlineCloseRef.current = onInlineClose;
  useEffect(() => {
    if (!inlineOpen) return;
    const element = inlinePanel.current;
    if (!element) return;
    return attachFocusLayer(element, () => inlineCloseRef.current(), () => window.matchMedia("(max-width:1120px)").matches);
  }, [inlineOpen]);
  const treeScroll = useRef<HTMLDivElement>(null);
  const [treeViewport, setTreeViewport] = useState({ top: uiState.scrollTop, height: 600 });
  const uiRef = useRef(uiState);
  uiRef.current = uiState;
  const updateUi = useCallback((patch: Partial<CaptureUiState>) => {
    uiRef.current = { ...uiRef.current, ...patch };
    onUiState(uiRef.current);
  }, [onUiState]);
  useLayoutEffect(() => {
    const element = treeScroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTreeViewport(current => ({ ...current, height: element.clientHeight })));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const requests = requestPage.items;
  const decryptAll = capture.decryptHosts.includes("*");
  const searchExpanded = Boolean(filters.query.trim());
  const activeScenario = scenarios.find((item) => item.status === "active");
  const visibleIds = requests.map((item) => item.id);
  const selectedSet = useMemo(() => new Set(multiSelected), [multiSelected]);
  const [treeRoot, setTreeRoot] = useState<{ nodes: CaptureTreeNode[]; matchedCount: number; batchCount: number }>({
    nodes: [],
    matchedCount: 0,
    batchCount: requestPage.batchCount,
  });
  type HostPage = { items: RequestSummary[]; nextOffset: number | null; offset: number; matchCount: number; loading: boolean; error?: string };
  const [groupPages, setGroupPages] = useState<Record<string, HostPage>>({});
  const pagesRef = useRef(groupPages);
  pagesRef.current = groupPages;
  const [treeBusy, setTreeBusy] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [rootPage, setRootPage] = useState({ offset: 0, nextOffset: null as number | null, count: 0, partial: false });
  const treeScopeKey = JSON.stringify([currentBatch.id, filters]);
  const scopeVersion = useRef({ key: treeScopeKey, version: 0 });
  if (scopeVersion.current.key !== treeScopeKey) scopeVersion.current = { key: treeScopeKey, version: scopeVersion.current.version + 1 };
  const treeScope = `${treeScopeKey}:${scopeVersion.current.version}`;
  const scopeRef = useRef(treeScope);
  scopeRef.current = treeScope;
  const rootFlight = useRef<string | null>(null);
  const hostFlights = useRef(new Map<string, symbol>());
  const selectedCapture = useRef(selected);
  const visibleHosts = useRef(new Set<string>());
  selectedCapture.current = selected;

  useEffect(() => {
    if (uiState.view === "relations" && !relations && !relationsLoading && !relationsError) void onLoadRelations();
  }, [uiState.view, relations, relationsLoading, relationsError, onLoadRelations]);

  const loadTreeGroup = useCallback(async (node: CaptureTreeNode, offset = 0, targetId?: string) => {
    const scope = treeScope;
    const flightKey = `${scope}:${node.key}`;
    if (hostFlights.current.has(flightKey)) return;
    const ticket = Symbol();
    hostFlights.current.set(flightKey, ticket);
    setGroupPages(pages => ({ ...pages, [node.key]: { ...(pages[node.key] || { items: [], nextOffset: null, offset, matchCount: node.count }), loading: true, error: undefined } }));
    try {
      const payload = await call<CaptureTreePayload>("requests.tree", {
        batchId: currentBatch.id, filters, parent: { type: "host-requests", root: node.root, offset, targetId }, limit: 200,
      });
      if (scope !== scopeRef.current || hostFlights.current.get(flightKey) !== ticket) return;
      updateUi({ treePageOffsets: { ...uiRef.current.treePageOffsets, [`requests:${node.key}`]: payload.offset || 0 } });
      setGroupPages(pages => ({ ...pages, [node.key]: { items: payload.items || [], nextOffset: payload.nextOffset ?? null,
        offset: payload.offset || 0, matchCount: payload.matchCount ?? node.count, loading: false } }));
    } catch (reason) {
      if (scope !== scopeRef.current) return;
      setGroupPages(pages => ({ ...pages, [node.key]: { ...(pages[node.key] || { items: [], nextOffset: null, offset, matchCount: node.count }), loading: false, error: String(reason) } }));
    } finally {
      if (hostFlights.current.get(flightKey) === ticket) hostFlights.current.delete(flightKey);
    }
  }, [currentBatch.id, filters, treeScope]);

  const loadTreeRoot = useCallback(async (offset = 0, targetId?: string) => {
    const scope = treeScope;
    if (rootFlight.current === scope) return;
    rootFlight.current = scope;
    setTreeBusy(true);
    setTreeError(null);
    try {
      const payload = await call<CaptureTreePayload>("requests.tree", {
        batchId: currentBatch.id, filters, parent: { type: "hosts", offset, targetId }, limit: 600,
      });
      if (scope !== scopeRef.current) return;
      setRootPage({ offset: payload.offset || 0, nextOffset: payload.nextOffset ?? null, count: payload.nodeCount || 0, partial: false });
      updateUi({ treePageOffsets: { ...uiRef.current.treePageOffsets, root: payload.offset || 0 } });
      setTreeRoot({ nodes: payload.nodes || [], matchedCount: payload.coverage.matchedCount, batchCount: payload.coverage.batchCount });
      const target = selectedCapture.current;
      const refreshNodes = (payload.nodes || []).filter(node =>
        (filters.query.trim() || uiRef.current.openNodes[node.key]) && (visibleHosts.current.has(node.key) || target && rootKey(target) === node.root));
      void (async () => {
        for (let start = 0; start < refreshNodes.length && scope === scopeRef.current; start += 4) {
          await Promise.all(refreshNodes.slice(start, start + 4).map(node => {
            const page = pagesRef.current[node.key];
            if (page?.error) return Promise.resolve();
            return loadTreeGroup(node, page?.offset ?? uiRef.current.treePageOffsets?.[`requests:${node.key}`] ?? 0);
          }));
        }
      })();
    } catch (reason) {
      if (scope === scopeRef.current) setTreeError(String(reason));
    } finally {
      if (rootFlight.current === scope) rootFlight.current = null;
      if (scope === scopeRef.current) setTreeBusy(false);
    }
  }, [currentBatch.id, filters, treeScope, loadTreeGroup]);

  useEffect(() => {
    setGroupPages({});
    pagesRef.current = {};
    setTreeRoot({ nodes: [], matchedCount: 0, batchCount: requestPage.batchCount });
    void loadTreeRoot(uiRef.current.treePageOffsets?.root || 0);
  }, [treeScope, loadTreeRoot]);

  useEffect(() => {
    if (uiState.view !== "structure" || treeError) return;
    const timer = window.setTimeout(() => void loadTreeRoot(rootPage.offset), 500);
    return () => window.clearTimeout(timer);
  }, [requestPage.matchCount, capture.running, uiState.view, loadTreeRoot, rootPage.offset, treeError]);

  useEffect(() => {
    if (!capture.running || uiState.view !== "structure" || treeError) return;
    const timer = window.setInterval(() => void loadTreeRoot(rootPage.offset), 2000);
    return () => window.clearInterval(timer);
  }, [capture.running, uiState.view, loadTreeRoot, rootPage.offset, treeError]);

  useEffect(() => {
    const updates = new Map(requests.map(item => [item.id, item]));
    setGroupPages(pages => {
      let changed = false;
      const next = { ...pages };
      for (const [key, page] of Object.entries(pages)) {
        const items = page.items.map(item => {
          const update = updates.get(item.id);
          if (update && update.version !== item.version) { changed = true; return update; }
          return item;
        });
        next[key] = { ...page, items };
      }
      return changed ? next : pages;
    });
  }, [requests]);

  const positionedSelection = useRef(selected ? `${treeScope}:${selected.id}` : "");
  const rootSelectionSeek = useRef("");
  useEffect(() => {
    if (!selected || uiState.view !== "structure") return;
    const positionKey = `${treeScope}:${selected.id}`;
    if (positionedSelection.current === positionKey) return;
    const node = treeRoot.nodes.find(item => item.root === rootKey(selected));
    if (!node) {
      if (!treeBusy && !treeError && rootSelectionSeek.current !== positionKey) {
        rootSelectionSeek.current = positionKey;
        void loadTreeRoot(0, selected.id);
      }
      return;
    }
    if (!uiRef.current.openNodes[node.key]) updateUi({ openNodes: { ...uiRef.current.openNodes, [node.key]: true } });
    const page = pagesRef.current[node.key];
    if (page?.items.some(item => item.id === selected.id)) positionedSelection.current = positionKey;
    else if (!page?.loading && !page?.error) void loadTreeGroup(node, 0, selected.id);
  }, [selected?.id, treeRoot.nodes, uiState.view, loadTreeGroup, loadTreeRoot, groupPages, treeScope, treeBusy, treeError]);

  const toggleNode = (key: string, node?: CaptureTreeNode) => {
    const opening = !(uiState.openNodes[key] ?? false);
    updateUi({ openNodes: { ...uiState.openNodes, [key]: opening } });
    if (opening && node && !pagesRef.current[key]) void loadTreeGroup(node, uiRef.current.treePageOffsets?.[`requests:${key}`] || 0);
  };
  const collapseAll = () => updateUi({ openNodes: {} });
  const expandLevel = async (_level: string) => {
    updateUi({ openNodes: { ...uiState.openNodes, ...Object.fromEntries(treeRoot.nodes.map(node => [node.key, true])) } });
    // Bound parallel reads rather than issuing hundreds of IPC requests together.
    for (let start = 0; start < treeRoot.nodes.length; start += 4) {
      await Promise.all(treeRoot.nodes.slice(start, start + 4).map(node => loadTreeGroup(node)));
    }
  };

  const toggleMulti = (requestId: string) => {
    onMultiSelected(
      selectedSet.has(requestId)
        ? multiSelected.filter((id) => id !== requestId)
        : [...multiSelected, requestId],
    );
  };

  const analyze = async (message: string, useSelection = true) => {
    if (!message.trim() || agentBusy) return;
    setPrompt("");
    await onAnalyze(message.trim(), {
      filters,
      selectedIds: useSelection
        ? (multiSelected.length ? multiSelected : selected ? [selected.id] : [])
        : [],
      scenarioId: activeScenario?.id ?? null,
    });
    onInlineOpen();
  };

  const selectedEvidence = detail
    ? evidence.filter((item) => item.requestId === detail.id)
    : [];
  const activeEvidence = evidenceTarget?.requestId === detail?.id ? evidenceTarget : null;
  const activeLocator = parseEvidenceLocator(activeEvidence?.locator ?? null, activeEvidence?.direction || "");
  const activeHeaderName = activeLocator?.kind === "header" ? activeLocator.name : null;
  const activeQueryKey = activeLocator?.kind === "query" ? activeLocator.key : null;
  const activeBodyLocator = activeLocator?.kind === "json"
    || activeLocator?.kind === "chars"
    || activeLocator?.kind === "body"
    ? activeEvidence?.locator ?? null
    : null;
  const activeDirection = activeLocator && "direction" in activeLocator
    ? activeLocator.direction
    : activeEvidence?.direction || "";

  const renderRequest = (request: RequestSummary, depth: number): React.ReactNode => (
    <button
      className={`request-row ${selected?.id === request.id ? "active" : ""} ${selectedSet.has(request.id) ? "multi" : ""}`}
      key={request.id}
      data-tree-key={request.id}
      style={{ paddingLeft: 18 + depth * 13 }}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) toggleMulti(request.id);
        else onSelect(request);
      }}
      onDoubleClick={() => void analyze(`分析请求 ${request.id}，定位失败、慢点或业务错误，并引用真实字段证据。`)}
    >
      <span
        className={`selection-box ${selectedSet.has(request.id) ? "checked" : ""}`}
        onClick={(event) => { event.stopPropagation(); toggleMulti(request.id); }}
      >
        {selectedSet.has(request.id) && <Check size={9} />}
      </span>
      <span className={`method-badge ${methodTone(request.method)}`}>{request.method}</span>
      <span className="request-query" title={request.path}>{request.path || "/"}</span>
      {request.requestState === "in_progress" && <LoaderCircle className="spin request-progress" size={11} />}
      <span title={request.error || undefined} className={`status-code ${request.error ? "bad" : statusTone(request.status)}`}>
        {request.error ? (request.error.includes("超时") ? "超时" : "失败") : request.status || (request.requestState === "in_progress" ? "…" : request.encrypted ? "TLS" : "—")}
      </span>
    </button>
  );

  const renderLazyNode = (node: CaptureTreeNode, depth = 0): React.ReactNode => {
    const open = searchExpanded || Boolean(uiState.openNodes[node.key]);
    if (node.type === "host") {
      const focused = uiState.focusHosts.includes(node.root);
      const decided = decryptAll || capture.decryptHosts.some((pattern) =>
        pattern.startsWith("*.") ? Boolean(node.host?.endsWith(pattern.slice(1))) : pattern === node.host,
      );
      return (
        <div className="host-group" key={node.key}>
          <button data-tree-key={node.key} className={`host-row ${focused ? "focused" : ""}`} onClick={() => toggleNode(node.key, node)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className={`host-favicon ${decided ? "decoded" : "locked"}`}>
              {decided ? node.host?.slice(0, 1).toUpperCase() : <LockKeyhole size={10} />}
            </span>
            <span className="host-name">{node.name}</span>
            {node.failureCount > 0 && <span className="host-fail">{node.failureCount}</span>}
            {node.inProgressCount > 0 && <LoaderCircle className="spin request-progress" size={11} />}
            <span className="host-count">{node.count}</span>
            <span
              role="button"
              tabIndex={0}
              className={`focus-host ${focused ? "active" : ""}`}
              title="关注 Host"
              aria-label={`${focused ? "取消关注" : "关注"} ${node.host}`}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); event.currentTarget.click(); } }}
              onClick={(event) => {
                event.stopPropagation();
                updateUi({
                  focusHosts: focused
                    ? uiState.focusHosts.filter((key) => key !== node.root)
                    : [...uiState.focusHosts, node.root],
                });
              }}
            >
              <Star size={11} fill={focused ? "currentColor" : "none"} />
            </span>
            <span
              role="button"
              tabIndex={0}
              className={`decrypt-toggle ${decided ? "active" : ""}`}
              aria-label={`${decided ? "关闭" : "开启"} ${node.host} HTTPS 解密`}
              aria-disabled={decryptAll}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); event.currentTarget.click(); } }}
              onClick={(event) => {
                event.stopPropagation();
                if (!decryptAll && node.host) void onDecrypt(node.host, !decided);
              }}
            >
              {decided ? <UnlockKeyhole size={11} /> : <KeyRound size={11} />}
            </span>
          </button>
        </div>
      );
    }
    return null;
  };
  const renderNodePager = (node: CaptureTreeNode) => {
    const page = groupPages[node.key];
    if (!page) return null;
    return <div className="host-request-pager">
      {page.error ? <><span role="alert">{page.error}</span><button disabled={page.loading} onClick={() => void loadTreeGroup(node, page.offset)}>重试</button></>
        : <><button disabled={page.loading || page.offset === 0} onClick={() => void loadTreeGroup(node, Math.max(0, page.offset - 200))}>上一页</button>
          <span>{page.matchCount ? `${page.offset + 1}–${page.offset + page.items.length} / ${page.matchCount}` : "暂无请求"}</span>
          <button disabled={page.loading || page.nextOffset == null} onClick={() => void loadTreeGroup(node, page.nextOffset!)}>下一页</button></>}
    </div>;
  };

  const timeline = [...requests].sort((a, b) =>
    timelineDescending ? b.startedAt - a.startedAt : a.startedAt - b.startedAt,
  );
  const sortedRoots = [...treeRoot.nodes].sort((a, b) => Number(uiState.focusHosts.includes(b.root)) - Number(uiState.focusHosts.includes(a.root)) || a.key.localeCompare(b.key));
  type TreeRow = { key: string; node: CaptureTreeNode; request?: RequestSummary; depth: number; kind: "node" | "request" | "pager" | "loading"; top: number; height: number };
  const treeRows: TreeRow[] = [];
  let treeHeight = 0;
  const appendTreeRow = (node: CaptureTreeNode, kind: TreeRow["kind"], height: number, request?: RequestSummary) => {
    treeRows.push({ key: request?.id || `${kind}:${node.key}`, node, request, depth: 0, kind, top: treeHeight, height });
    treeHeight += height;
  };
  if (uiState.view === "structure") for (const node of sortedRoots) {
    appendTreeRow(node, "node", rowHeight);
    if (!(searchExpanded || uiState.openNodes[node.key])) continue;
    const page = groupPages[node.key];
    if (!page) { appendTreeRow(node, "loading", rowHeight); continue; }
    for (const request of page.items) appendTreeRow(node, "request", rowHeight, request);
    if (page.loading && !page.items.length) appendTreeRow(node, "loading", rowHeight);
    if (page.error || page.offset > 0 || page.nextOffset != null) appendTreeRow(node, "pager", rowHeight + 10);
  }
  const virtualRows = treeRows.filter(row => row.top + row.height >= treeViewport.top - 320 && row.top <= treeViewport.top + treeViewport.height + 320);
  visibleHosts.current = new Set(virtualRows.map(row => row.node.key));
  const visibleHostKey = [...visibleHosts.current].join("\n");
  useEffect(() => {
    if (uiState.view !== "structure") return;
    for (const node of sortedRoots) {
      if (visibleHosts.current.has(node.key) && (searchExpanded || uiRef.current.openNodes[node.key]) && !pagesRef.current[node.key]) void loadTreeGroup(node, uiRef.current.treePageOffsets?.[`requests:${node.key}`] || 0);
    }
  }, [visibleHostKey, uiState.openNodes, uiState.view, treeRoot.nodes, loadTreeGroup]);
  const restoreKey = `${currentBatch.id}:${uiState.view}:${JSON.stringify(filters)}`;
  const restoreState = useRef({ key: restoreKey, top: uiState.scrollTop, done: false });
  if (restoreState.current.key !== restoreKey) restoreState.current = { key: restoreKey, top: uiState.scrollTop, done: false };
  useLayoutEffect(() => {
    const element = treeScroll.current;
    if (!element || restoreState.current.done || treeBusy) return;
    const target = restoreState.current.top;
    element.scrollTop = target;
    setTreeViewport(current => ({ ...current, top: element.scrollTop }));
    if (element.scrollTop >= target - 1) restoreState.current.done = true;
  }, [restoreKey, treeHeight, treeBusy, requestPage.items.length]);

  const revealedSelection = useRef(uiState.selectedId);
  const revealedBatch = useRef(currentBatch.id);
  if (revealedBatch.current !== currentBatch.id) {
    revealedBatch.current = currentBatch.id;
    revealedSelection.current = uiState.selectedId;
  }
  useLayoutEffect(() => {
    if (!selected || selected.id === revealedSelection.current || uiState.view !== "structure") return;
    const row = treeRows.find(item => item.request?.id === selected.id);
    const element = treeScroll.current;
    if (!row || !element) return;
    revealedSelection.current = selected.id;
    restoreState.current.done = true;
    if (row.top < element.scrollTop || row.top + row.height > element.scrollTop + element.clientHeight) {
      element.scrollTop = row.top;
      setTreeViewport(current => ({ ...current, top: element.scrollTop }));
    }
  }, [selected?.id, treeRows, groupPages, uiState.view]);
  const keyboardRows: Array<{ key: string; request?: RequestSummary; node?: CaptureTreeNode; parent?: string }> = [];
  if (uiState.view === "structure") for (const row of treeRows) {
    if (row.kind === "node") keyboardRows.push({ key: row.node.key, node: row.node });
    if (row.request) keyboardRows.push({ key: row.request.id, request: row.request, parent: row.node.key });
  }
  else (uiState.view === "timeline" ? timeline : requests).forEach(request => keyboardRows.push({ key: request.id, request }));
  const focusRow = (row: typeof keyboardRows[number]) => {
    if (row.request) onSelect(row.request);
    const virtualRow = treeRows.find(item => row.request ? item.request?.id === row.request.id : item.kind === "node" && item.node.key === row.key);
    const element = treeScroll.current;
    if (element && virtualRow && (virtualRow.top < element.scrollTop || virtualRow.top + virtualRow.height > element.scrollTop + element.clientHeight)) {
      restoreState.current.done = true;
      element.scrollTop = virtualRow.top;
      setTreeViewport(current => ({ ...current, top: element.scrollTop }));
    }
    requestAnimationFrame(() => requestAnimationFrame(() => treeScroll.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(row.key)}"]`)?.focus({ preventScroll: false })));
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (uiState.view === "directories") return;
    if ((event.target as HTMLElement).closest("input,textarea,select")) return;
    if ((event.target as HTMLElement).closest('[role="separator"]')) return;
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "j", "k"].includes(event.key)) return;
    if (!keyboardRows.length) return;
    event.preventDefault();
    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-key]")?.dataset.treeKey || selected?.id;
    const index = keyboardRows.findIndex(row => row.key === focused);
    const row = keyboardRows[index];
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const open = row?.node && Boolean(searchExpanded || uiState.openNodes[row.key]);
      if (row?.node && ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open))) toggleNode(row.key, row.node);
      else if (event.key === "ArrowLeft" && row?.parent) { const parent = keyboardRows.find(item => item.key === row.parent); if (parent) focusRow(parent); }
      else if (event.key === "ArrowRight" && open && keyboardRows[index+1]?.parent === row.key) focusRow(keyboardRows[index+1]);
      return;
    }
    const next = event.key === "Home" ? 0 : event.key === "End" ? keyboardRows.length - 1 : index + (["ArrowDown", "j"].includes(event.key) ? 1 : -1);
    focusRow(keyboardRows[Math.max(0, Math.min(keyboardRows.length-1, next))]);
  };

  return (
    <div className={`capture-workspace ${inlineOpen ? "with-inline-ai" : ""} ${detailExpanded ? "detail-expanded" : ""}`} style={{"--tree-row-height": `${rowHeight}px`} as React.CSSProperties}>
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
          <button className="button ghost compact" onClick={() => setDetailExpanded(current => !current)}><Columns3 size={14} />{detailExpanded ? "返回请求列表" : "详情全宽"}</button>
          <span className="toolbar-separator" />
          <button className="button ghost compact" onClick={() => setScenarioOpen((value) => !value)}>
            <Tags size={14} /> {activeScenario ? `结束 ${activeScenario.name}` : "开始场景"}
          </button>
          <button className="button ghost compact" onClick={onScenarioCompare}><GitCompareArrows size={14} /> 场景对比</button>
          <button className="button ghost compact" onClick={() => void onNewBatch()}><Database size={14} /> 新批次</button>
          <button className="button ghost compact" onClick={() => void onClearBatch(false)}><Trash2 size={14} /> 清空</button>
        </div>
        <div className="capture-meta">
          <span className={`capture-beacon ${capture.running && !capture.paused ? "active" : ""}`} />
          <span>{capture.running ? (capture.paused ? "仍转发 · 不记录" : `${capture.requestCount} 条事件`) : "未监听"}</span>
          <span className="toolbar-divider" />
          <button className={`meta-action ${decryptAll ? "active" : ""}`} onClick={() => void onDecrypt("*", !decryptAll)}>
            {decryptAll ? <UnlockKeyhole size={14} /> : <LockKeyhole size={14} />}
            {decryptAll ? "HTTPS 解密中" : "HTTPS 解密"}
          </button>
          <button className={`meta-action ${capture.lan ? "active" : ""}`} onClick={onPhone}>
            <Wifi size={14} /> {capture.lan ? `${capture.localIp}:${capture.port}` : "连接手机"}
          </button>
          <button className={`meta-action ${throttle.enabled ? "active" : ""}`} onClick={onThrottle}>
            <Clock3 size={14} /> {throttle.enabled ? `弱网 ${throttle.downKbPerSecond || "∞"} KB/s` : "弱网关闭"}
          </button>
          <button className="meta-action" onClick={() => onOpenWorkbench("environments")}><Tags size={14} /> 项目配置</button>
          <button className="meta-action" onClick={() => onOpenWorkbench("imports")}><Download size={14} /> 导入</button>
          <button className={`meta-action ai-inline-trigger ${inlineOpen ? "active" : ""}`} onClick={inlineOpen ? onInlineClose : onInlineOpen}>
            {inlineOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />} AI 面板
          </button>
        </div>
      </section>

      {scenarioOpen && (
        <div className="scenario-strip">
          {activeScenario ? (
            <>
              <span className="scenario-live"><Tags size={13} /> 场景「{activeScenario.name}」正在记录 · {activeScenario.requestCount} 条</span>
              <span className="spacer" />
              <button className="button ghost compact" onClick={() => void analyze("分析当前场景中的关键失败点、缺失证据和验证顺序。", false)}>
                <Sparkles size={13} /> 分析场景
              </button>
              <button className="button primary compact" onClick={() => void onScenarioEnd(activeScenario.id)}>结束场景</button>
            </>
          ) : (
            <>
              <Tags size={14} />
              <input value={scenarioName} placeholder="场景名称，例如：提交订单失败" onChange={(event) => setScenarioName(event.target.value)} />
              <Select value={filters.sourceIp} onChange={(event) => onFilters({ ...filters, sourceIp: event.target.value })}>
                <option value="">全部设备</option>
                {filterOptions.devices.map((device) => <option key={device}>{device}</option>)}
              </Select>
              <button className="button primary compact" disabled={!scenarioName.trim()} onClick={async () => {
                await onScenarioStart(scenarioName.trim(), filters.sourceIp);
                setScenarioName("");
                setScenarioOpen(false);
              }}>开始记录</button>
              <button className="icon-action small" title="关闭场景设置" aria-label="关闭场景设置" onClick={() => setScenarioOpen(false)}><X size={14} /></button>
            </>
          )}
        </div>
      )}

      <section className="filterbar">
        <div className="filter-search"><Search size={14} /><input value={filters.query} placeholder="网址 / 主机 / 路径" onChange={(event) => onFilters({ ...filters, query: event.target.value })} /></div>
        <div className="filter-select"><Filter size={13} /><Select value={filters.method} onChange={(event) => onFilters({ ...filters, method: event.target.value })}><option value="">全部方法</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>CONNECT</option></Select></div>
        <div className="filter-select"><Select value={filters.status} onChange={(event) => onFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option><option value="2xx">2xx</option><option value="3xx">3xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option></Select></div>
        <div className="filter-select"><Select value={filters.host} onChange={(event) => onFilters({ ...filters, host: event.target.value })}><option value="">全部 Host</option>{filterOptions.hosts.map((host) => <option key={host}>{host}</option>)}</Select></div>
        <div className="filter-select device-filter"><Select value={filters.sourceIp} onChange={(event) => onFilters({ ...filters, sourceIp: event.target.value })}><option value="">全部设备</option>{filterOptions.devices.map((ip) => <option key={ip}>{ip}</option>)}</Select></div>
        <label className="filter-check"><input type="checkbox" checked={filters.errorsOnly} onChange={(event) => onFilters({ ...filters, errorsOnly: event.target.checked })} /> 仅异常</label>
        <div className="batch-picker"><History size={13} /><Select value={currentBatch.id} onChange={(event) => void onBatchSelect(event.target.value)}>{batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.label} · {batch.request_count ?? batch.requestCount ?? 0}</option>)}</Select></div>
      </section>

      <section className="capture-subbar">
        <div className="view-tabs">
          <button className={uiState.view === "structure" ? "active" : ""} onClick={() => updateUi({ view: "structure" })}><ListTree size={13} /> 结构</button>
          <button className={uiState.view === "directories" ? "active" : ""} onClick={() => updateUi({ view: "directories" })}><Folder size={13} /> 目录折叠</button>
          <button className={uiState.view === "timeline" ? "active" : ""} onClick={() => updateUi({ view: "timeline" })}><Columns3 size={13} /> 时序</button>
          <button className={uiState.view === "relations" ? "active" : ""} onClick={() => updateUi({ view: "relations" })}><Link2 size={13} /> 关联</button>
        </div>
        <div className="time-range-filter">
          <Clock3 size={12} />
          <input
            type="datetime-local"
            title="开始时间"
            value={toDateTimeLocal(filters.startedAfter)}
            onChange={(event) => onFilters({ ...filters, startedAfter: fromDateTimeLocal(event.target.value) })}
          />
          <span>→</span>
          <input
            type="datetime-local"
            title="结束时间"
            value={toDateTimeLocal(filters.startedBefore)}
            onChange={(event) => onFilters({ ...filters, startedBefore: fromDateTimeLocal(event.target.value) })}
          />
          {(filters.startedAfter || filters.startedBefore) && (
            <button title="清除时间范围" onClick={() => onFilters({ ...filters, startedAfter: null, startedBefore: null })}><X size={11} /></button>
          )}
        </div>
        <div className="coverage-readout">
          <span><b>{(treeRoot.matchedCount || requestPage.matchCount).toLocaleString()}</b> 匹配</span>
          <span><b>{requests.length.toLocaleString()}</b> 已加载</span>
          <span><b>{(treeRoot.batchCount || requestPage.batchCount).toLocaleString()}</b> 批次总数</span>
          {requestPage.newSinceScope > 0 && <span className="new-capture-pill"><Sparkles size={11} /> 快照后新增 {requestPage.newSinceScope}</span>}
        </div>
        <div className="saved-filter-controls">
          <Select
            value={savedFilterId}
            onChange={(event) => {
              const id = event.target.value;
              setSavedFilterId(id);
              const saved = savedFilters.find((item) => item.id === id);
              if (saved) onFilters({ ...filters, ...(saved.config.filters || {}) });
            }}
          >
            <option value="">常用筛选</option>
            {savedFilters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
          <button
            title="保存当前筛选"
            onClick={() => setSavingFilter(value => !value)}
          >保存</button>
          {savingFilter && <form className="saved-filter-name" onSubmit={async event => {
            event.preventDefault();
            if (!savedFilterName.trim()) return;
            await onSaveFilter(savedFilterName.trim());
            setSavingFilter(false);
          }}><input autoFocus aria-label="筛选名称" value={savedFilterName} onChange={event => setSavedFilterName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setSavingFilter(false); } }} /><button type="submit" disabled={!savedFilterName.trim()}>确认保存</button><button type="button" onClick={() => setSavingFilter(false)}>取消</button></form>}
          {savedFilterId && (
            <button
              title="删除已保存筛选"
              onClick={() => {
                void onDeleteFilter(savedFilterId);
                setSavedFilterId("");
              }}
            ><X size={11} /></button>
          )}
        </div>
        <div className="tree-actions">
          {multiSelected.length > 0 && (
            <>
              <span className="selected-counter">{multiSelected.length} 选中</span>
              <button onClick={onCompare} disabled={multiSelected.length !== 2}><GitCompareArrows size={12} /> 对比</button>
              <button onClick={() => void onAddRelation(multiSelected[0], multiSelected[1])} disabled={multiSelected.length !== 2}><Link2 size={12} /> 人工归组</button>
              <button onClick={() => void analyze("对比当前选中的请求，按字段列出关键差异、候选原因和待验证项。")}><Bot size={12} /> 交给 AI</button>
              <button onClick={() => onMultiSelected([])}>清除</button>
            </>
          )}
          {uiState.view !== "directories" && <><button onClick={collapseAll}>全部收起</button>
          <button onClick={() => void expandLevel("host")}>展开 Host</button></>}
          <button onClick={onAggregate}><Database size={12} /> 聚合</button>
          <button onClick={onDuplicates}><RotateCcw size={12} /> 重复模式</button>
          <button onClick={() => void onExportHar()}><Download size={12} /> HAR</button>
        </div>
      </section>

      {error && <div className="capture-error"><Ban size={14} /> {error}</div>}

      <div className="capture-body">
        <aside className="request-tree" onKeyDown={onKeyDown} tabIndex={0}>
          <PanelResize name="调整请求树宽度" variable="--tree-width" initial={36} />
          <div className="tree-head">
            <span>{uiState.view === "structure" ? "主机 / 请求" : uiState.view === "directories" ? "主机 / 目录 / 请求" : uiState.view === "timeline" ? "时间顺序" : "关联请求"}</span>
            <span>{requestPage.matchCount}</span>
          </div>
          <div
            className={`tree-scroll ${uiState.view === "directories" ? "directory-container" : ""}`}
            ref={treeScroll}
            onWheel={() => { restoreState.current.done = true; }}
            onPointerDown={() => { restoreState.current.done = true; }}
            onScroll={(event) => {
              const top = event.currentTarget.scrollTop;
              setTreeViewport(current => ({ ...current, top }));
              if (restoreState.current.done) updateUi({ scrollTop: top });
            }}
          >
            {uiState.view === "directories" ? <DirectoryTree key={treeScopeKey} batchId={currentBatch.id} filters={filters} running={capture.running} revision={requestPage.matchCount} rowHeight={rowHeight} selected={selected} seekNonce={evidenceTarget?.requestId === selected?.id ? evidenceTarget?.nonce || 0 : 0} ui={uiState} onUi={updateUi} renderRequest={renderRequest} /> : treeError ? (
              <div className="tree-empty" role="alert"><h3>结构树加载失败</h3><p>{treeError}</p><button className="button ghost compact" onClick={() => void loadTreeRoot()}>重试</button></div>
            ) : requestPage.matchCount === 0 && !treeBusy ? (
              <div className="tree-empty">
                <div className="tree-empty-mark"><ArrowUpRight size={20} /></div>
                <h3>{requestPage.batchCount > 0 && requestPage.matchCount === 0 ? "当前筛选没有匹配请求" : capture.running ? "等待第一个请求" : "抓包工作区还未启动"}</h3>
                <p>{requestPage.batchCount > 0 ? `批次中有 ${requestPage.batchCount} 条请求，当前筛选范围为空。` : "启动代理不会自动修改系统设置。"}</p>
                {requestPage.batchCount > 0 ? (
                  <button className="button ghost compact" onClick={() => onFilters({ query: "", method: "", status: "", sourceIp: "", host: "", environment: "", traceId: "", errorsOnly: false, startedAfter: null, startedBefore: null })}>清除筛选</button>
                ) : !capture.running ? (
                  <button className="button primary compact" onClick={onStart}><Play size={14} /> 开始抓包</button>
                ) : null}
              </div>
            ) : uiState.view === "structure" ? (
              <>
                {treeBusy && treeRoot.nodes.length === 0 && (
                  <div className="tree-empty"><LoaderCircle className="spin" size={18} /><p>正在按当前筛选聚合结构树…</p></div>
                )}
                <div className="virtual-capture-tree" style={{ height: treeHeight }}>
                  {virtualRows.map(row => (
                    <div className="virtual-tree-block" key={row.key} style={{ top: row.top, height: row.height }}>
                      {row.kind === "node" ? renderLazyNode(row.node, row.depth)
                        : row.kind === "request" && row.request ? renderRequest(row.request, 0)
                        : row.kind === "pager" ? renderNodePager(row.node)
                        : <div className="tree-node-loading"><LoaderCircle className="spin" size={12} /> 正在加载请求…</div>}
                    </div>
                  ))}
                </div>
                {(rootPage.offset > 0 || rootPage.nextOffset != null) && <div className="qa-actions"><button className="button ghost compact" disabled={rootPage.offset === 0} onClick={() => void loadTreeRoot(Math.max(0, rootPage.offset-600))}>上一页节点</button><span>{rootPage.offset+1}–{Math.min(rootPage.offset+600, rootPage.count)} / {rootPage.count}</span><button className="button ghost compact" disabled={rootPage.nextOffset == null} onClick={() => void loadTreeRoot(rootPage.nextOffset!)}>下一页节点</button></div>}
                {rootPage.partial && <p className="boundary-note">结构聚合已达10万组预算，部分节点未检查；请缩小筛选范围。</p>}
              </>
            ) : uiState.view === "timeline" ? (
              <div className="timeline-tree">
                <button className="timeline-sort" onClick={() => setTimelineDescending((value) => !value)}>
                  <TimerReset size={12} /> {timelineDescending ? "最新在前" : "最早在前"}
                </button>
                <VirtualRequestList key={`${currentBatch.id}:${timelineDescending}`} items={timeline} selectedId={selected?.id}
                  position={uiState.listPositions?.[`timeline:${timelineDescending}`]}
                  onPosition={position => updateUi({ listPositions: { ...uiRef.current.listPositions, [`timeline:${timelineDescending}`]: position } })}
                  renderRow={(request) => (
                  <button
                    className={`timeline-row ${selected?.id === request.id ? "active" : ""}`}
                    key={request.id}
                    data-tree-key={request.id}
                    onClick={(event) => event.metaKey || event.ctrlKey ? toggleMulti(request.id) : onSelect(request)}
                  >
                    <span className="mono timeline-time">{formatTime(request.startedAt)}</span>
                    <span className={`method-badge ${methodTone(request.method)}`}>{request.method}</span>
                    <span className="timeline-host">{request.host}</span>
                    <span className="timeline-path">{request.path}</span>
                    <span className={`status-code ${statusTone(request.status)}`}>{request.status || (request.requestState === "in_progress" ? "…" : "—")}</span>
                    <span className="timeline-duration">{formatDuration(request.durationMs)}</span>
                  </button>
                )} />
              </div>
            ) : (
              <div className="relation-panel">
                {!relations ? (
                  <div className="tree-empty">
                    {relationsLoading ? <><LoaderCircle className="spin" /><p>正在计算 Trace、业务键和候选关系…</p></>
                      : <><p role="alert">{relationsError || "尚未计算关联"}</p><button className="button ghost compact" onClick={() => void onLoadRelations()}>重新计算</button></>}
                  </div>
                ) : (
                  <>
                    <div className="relation-summary">
                      <b>{relations.traceGroups.length}</b> 个有效 Trace
                      <span>·</span>
                      <b>{relations.edges.length}</b> 条关系
                      <span>·</span>
                      <button onClick={() => void onLoadRelations()}>刷新</button>
                      <button onClick={() => onWaterfall()}><Activity size={11} /> 跨服务瀑布</button>
                    </div>
                    {relations.traceGroups.map((group) => (
                      <div className="trace-group-card" key={group.traceId}>
                        <div className="trace-head">
                          <Link2 size={12} /><code>{group.traceId.slice(0, 12)}…</code><span>{group.requestIds.length}</span>
                          <button onClick={() => onWaterfall(group.traceId)}><Activity size={11} /> 瀑布</button>
                        </div>
                        <p>同 Trace 的代理可见请求，不代表完整服务端 Span 链。</p>
                        {group.requestIds.slice(0, 8).map((id) => {
                          const request = requests.find((item) => item.id === id);
                          return request ? <button key={id} onClick={() => onSelect(request)}>{request.method} {request.host}{request.path}</button> : null;
                        })}
                      </div>
                    ))}
                    {relations.edges.slice(0, 80).map((edge, index) => {
                      const source = requests.find((item) => item.id === edge.sourceId);
                      const target = requests.find((item) => item.id === edge.targetId);
                      if (!source || !target) return null;
                      return (
                        <div className="relation-edge" key={`${edge.sourceId}-${edge.targetId}-${index}`}>
                          <span className={`relation-kind ${edge.confidence}`}>{edge.type}</span>
                          <button onClick={() => onSelect(source)}>{source.method} {source.host}{source.path}</button>
                          <span className="relation-arrow">→</span>
                          <button onClick={() => onSelect(target)}>{target.method} {target.host}{target.path}</button>
                          <small>{edge.boundary}</small>
                        </div>
                      );
                    })}
                    {relations.approximateGroups.slice(0, 20).map((group) => (
                      <div className="approximate-group" key={group.key}>
                        <span className="relation-kind candidate">附近请求</span>
                        <b>{group.key}</b>
                        <small>{group.boundary}</small>
                      </div>
                    ))}
                    {relations.edges.length === 0 && relations.traceGroups.length === 0 && (
                      <div className="empty-detail">没有可证实的关联。可开启 Trace 采集、配置业务关联字段或人工归组。</div>
                    )}
                  </>
                )}
              </div>
            )}
            {uiState.view !== "structure" && uiState.view !== "directories" && requestPage.nextCursor && (
              <button className="load-more" onClick={() => void onLoadMore()}>
                加载更多 · 已加载 {requests.length} / {requestPage.matchCount}
              </button>
            )}
          </div>
          <div className="tree-footer">
            <span>{uiState.view === "structure" ? "Host 分组 · 最新在前" : uiState.view === "directories" ? "目录可折叠 · 每次请求独立保留" : uiState.view === "timeline" ? timelineDescending ? "时间倒序" : "时间正序" : "关联视图"}</span>
            <span className={capture.captureLoss ? "capture-loss" : ""}>
              {capture.captureLoss ? `记录写入丢失 ${capture.captureLoss} 次 · ${capture.lastRecordLossReason === "persist-failed" ? "持久化失败" : capture.lastRecordLossReason === "queue-full" ? "队列已满" : "请看错误通知"}` : agentBusy ? "Agent 运行中" : capture.paused ? "记录已暂停" : `写入队列 ${capture.recordQueueDepth ?? 0} / ${capture.recordQueueLimit ?? 1000}`}
            </span>
          </div>
        </aside>

        <main className="request-detail">
          {!selected ? (
            <div className="detail-placeholder">
              <div className="detail-grid-mark" />
              <div className="eyebrow">请求详情</div>
              <h2>选择一条请求查看细节</h2>
              <p>支持多选、字段证据跳转、成功/失败对比和就地 AI 分析。</p>
              <button className="button ghost compact" onClick={onInlineOpen}><Sparkles size={13} /> 打开就地 AI 面板</button>
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
                    <button className="button ghost compact" onClick={() => onAddToAI(selected)}><Bot size={14} /> 附加</button>
                    <button className="button ghost compact" onClick={() => void analyze(`分析这条请求为什么异常，先读取状态、规则影响、Header 和必要正文，再给出证据。`)}><Sparkles size={14} /> 分析</button>
                    <button className="button ghost compact" onClick={() => onRule("local", selected.url)}>本地映射</button>
                    <button className="button ghost compact" onClick={() => onOpenWorkbench("debug")}>预览变更</button>
                  </div>
                </div>
                <div className="request-facts">
                  <span className={`status-fact ${statusTone(selected.status)} ${activeLocator?.kind === "status" ? "evidence-target" : ""}`}>{selected.status || "—"} {selected.status ? "状态" : ""}</span>
                  <span><Clock3 size={12} /> {formatDuration(selected.durationMs)}</span>
                  <span><Database size={12} /> {formatBytes(selected.size)}</span>
                  <span><Wifi size={12} /> {selected.sourceIp || "本机"}</span>
                  <span>{selected.httpVersion || "HTTP"}</span>
                  <span>v{selected.version}</span>
                  {selected.businessState?.state && <span className={`business-pill ${selected.businessState.state}`}>{selected.businessState.state}</span>}
                </div>
                <div className="rule-traces">
                  {selected.traceValid && <span className="trace-chip"><Link2 size={12} /> Trace {selected.traceId?.slice(0, 12)}…</span>}
                  {selected.requestState === "in_progress" && <span className="trace-chip rule"><LoaderCircle className="spin" size={12} /> 请求进行中</span>}
                  {selected.encrypted && <span className="trace-chip locked"><LockKeyhole size={12} /> HTTPS 已透传</span>}
                  {selected.matchedRule && <span className="trace-chip rule"><RotateCcw size={12} /> 命中规则 {selected.matchedRule.slice(-6)}</span>}
                  {selected.actualUrl && <span className="trace-chip">实际上游 {selected.actualUrl}</span>}
                  {selected.tlsError && <span className="trace-chip error"><ShieldOff size={12} /> {selected.tlsError}</span>}
                  {selected.ruleError && <span className="trace-chip error">规则错误：{selected.ruleError}</span>}
                  {selected.error && <span className="trace-chip error">{selected.error}</span>}
                  <BodyStateBadge state={selected.requestBodyState} />
                  <BodyStateBadge state={selected.responseBodyState} />
                </div>
              </div>

              <div className="detail-tabs">
                {(["overview", "request", "response", "timing", "rules", "relations"] as const).map((key) => (
                  <button className={uiState.detailTab === key ? "active" : ""} key={key} onClick={() => updateUi({ detailTab: key })}>
                    {{ overview: "概要", request: "请求", response: "响应", timing: "耗时", rules: "规则影响", relations: "关联" }[key]}
                  </button>
                ))}
              </div>

              <div className="detail-scroll">
                {detailLoading && <div className="detail-loading"><span className="spinner" /> 正在读取请求正文…</div>}
                {!detailLoading && !detail && <div className="empty-detail">详情读取失败</div>}
                {detail && activeEvidence && (
                  <div className="evidence-focus-banner" key={activeEvidence.nonce}>
                    <span>证据位置</span>
                    <code>{activeEvidence.locator || activeEvidence.direction}</code>
                    <small>请求 v{detail.version}{activeEvidence.expectedVersion && activeEvidence.expectedVersion !== detail.version ? `（来源 v${activeEvidence.expectedVersion} 已失效，当前内容仅供参考）` : ""}；正文证据单独读取脱敏字段或分段；缺失与截断会明确显示。</small>
                  </div>
                )}
                {detail && uiState.detailTab === "overview" && (
                  <div className="overview-grid">
                    <section className="overview-block full">
                      <div className="block-head"><span>概要</span><small>{detail.environment || "未设置环境"}</small></div>
                      <dl className="fact-list">
                        <dt>请求 URL</dt><dd className="break"><QueryHighlight url={detail.url} queryKey={activeQueryKey} /></dd>
                        <dt>实际上游</dt><dd className="break">{detail.actualUrl || detail.url}</dd>
                        <dt>连接</dt><dd className="break">{detail.connectionId || "—"} · {detail.clientPeer || "—"}</dd>
                        <dt>协议</dt><dd>{detail.scheme.toUpperCase()} · {detail.httpVersion || "HTTP/1.1"}</dd>
                        <dt>内容类型</dt><dd>{detail.contentType || "—"}</dd>
                        <dt>App 版本</dt><dd>{detail.appVersion || "—"} {detail.buildNumber ? `(${detail.buildNumber})` : ""}</dd>
                        <dt>正文状态</dt><dd>请求 {detail.bodyStates.request} / 响应 {detail.bodyStates.response}</dd>
                        <dt>业务状态</dt><dd>{detail.businessState?.state || "unknown"} {detail.businessState?.ruleName ? `· ${detail.businessState.ruleName}` : ""}</dd>
                      </dl>
                    </section>
                    <section className="overview-block">
                      <div className="block-head"><span>请求</span><small>{formatBytes(detail.requestBodySize)}</small></div>
                      <div className="mini-code">{detail.requestBodyText ? detail.requestBodyText.slice(0, 900) : "无可用正文"}</div>
                    </section>
                    <section className="overview-block">
                      <div className="block-head"><span>响应</span><small>{formatBytes(detail.responseBodySize)}</small></div>
                      <div className="mini-code">{detail.responseBodyText ? detail.responseBodyText.slice(0, 900) : "无可用正文"}</div>
                    </section>
                    {selectedEvidence.length > 0 && (
                      <section className="overview-block full evidence-mini-list">
                        <div className="block-head"><span>当前分析中的证据</span></div>
                        {selectedEvidence.map((item) => (
                          <button key={item.id} onClick={() => onEvidenceSelect(item.requestId, item.direction, item.locator)}>
                            <span>{item.summary}</span><code>{item.locator}</code>
                          </button>
                        ))}
                      </section>
                    )}
                  </div>
                )}
                {detail && uiState.detailTab === "request" && (
                  <div className="detail-section">
                    <div className="section-heading"><h3>请求头</h3><span>{detail.requestHeaders.length}</span></div>
                    <HeadersTable
                      headers={detail.requestHeaders}
                      highlightedName={activeDirection === "request" ? activeHeaderName : null}
                      evidenceNonce={activeEvidence?.nonce}
                    />
                    <div className="section-heading spaced"><h3>请求正文</h3><BodyStateBadge state={detail.bodyStates.request} /></div>
                    <BodyPanel
                      key={`${detail.id}:${detail.version}:request`}
                      requestId={detail.id}
                      direction="request"
                      text={detail.requestBodyText}
                      body={detail.requestBody}
                      state={detail.bodyStates.request}
                      locator={activeDirection === "request" ? activeBodyLocator : null}
                      evidenceNonce={activeEvidence?.nonce || 0}
                    />
                  </div>
                )}
                {detail && uiState.detailTab === "response" && (
                  <div className="detail-section">
                    <div className="section-heading"><h3>响应头</h3><span>{detail.responseHeaders.length}</span></div>
                    <HeadersTable
                      headers={detail.responseHeaders}
                      highlightedName={activeDirection === "response" ? activeHeaderName : null}
                      evidenceNonce={activeEvidence?.nonce}
                    />
                    <div className="section-heading spaced"><h3>响应正文</h3><BodyStateBadge state={detail.bodyStates.response} /></div>
                    <BodyPanel
                      key={`${detail.id}:${detail.version}:response`}
                      requestId={detail.id}
                      direction="response"
                      text={detail.responseBodyText}
                      body={detail.responseBody}
                      state={detail.bodyStates.response}
                      locator={activeDirection === "response" ? activeBodyLocator : null}
                      evidenceNonce={activeEvidence?.nonce || 0}
                    />
                  </div>
                )}
                {detail && uiState.detailTab === "timing" && (
                  <div className="timing-panel">
                    <div className="timing-hero"><span>{formatDuration(detail.durationMs)}</span><small>代理观测</small></div>
                    <div className="timing-track"><div className="timing-fill" style={{ width: "100%" }} /></div>
                    <div className="timing-grid">
                      <div><span>开始</span><b>{formatTime(detail.startedAt)}</b></div>
                      <div><span>请求完成</span><b>{formatTime(detail.requestFinishedAt)}</b></div>
                      <div><span>响应头</span><b>{formatTime(detail.responseHeadersAt)}</b></div>
                      <div><span>最终完成</span><b>{formatTime(detail.finishedAt)}</b></div>
                      <div><span>来源</span><b>{detail.sourceIp}</b></div>
                      <div><span>响应大小</span><b>{formatBytes(detail.size)}</b></div>
                      <div><span>状态</span><b>{detail.status ?? "无响应"}</b></div>
                      <div><span>连接</span><b>{detail.connectionId?.slice(-10) || "—"}</b></div>
                    </div>
                    <p className="timing-note">只展示代理可观测的阶段。响应头时间不是严格 TTFB，连接复用也不会被重复算成每次请求的新建连。</p>
                  </div>
                )}
                {detail && uiState.detailTab === "rules" && (
                  <div className="rule-impact-panel">
                    <section>
                      <div className="section-heading"><h3>命中规则</h3></div>
                      <pre>{JSON.stringify(detail.ruleEvidence || {}, null, 2)}</pre>
                    </section>
                    <div className="rule-impact-note">
                      <ExternalLink size={14} />
                      规则修改后的 Header 与命中 ID 会保留；默认不复制多份大正文。标记为未知的主体差异不能从当前记录恢复。
                    </div>
                  </div>
                )}
                {detail && uiState.detailTab === "relations" && (
                  <div className="detail-relations">
                    <div className="section-heading"><h3>关联请求</h3><button className="link-button" onClick={() => void onLoadRelations()}>刷新</button></div>
                    {!relations ? <div className="empty-detail">正在读取关系…</div> : (
                      <>
                        {relations.edges.filter((edge) => edge.sourceId === detail.id || edge.targetId === detail.id).map((edge, index) => (
                          <div className="detail-relation-row" key={index}>
                            <span className={`relation-kind ${edge.confidence}`}>{edge.type}</span>
                            <code>{edge.sourceId === detail.id ? edge.targetId : edge.sourceId}</code>
                            <small>{edge.boundary}</small>
                          </div>
                        ))}
                        {activeScenario && (
                          <div className="scenario-membership">
                            <span>人工场景：{activeScenario.name}</span>
                            <button onClick={() => void onAddScenarioRequest(activeScenario.id, detail.id, "include")}>加入场景</button>
                            <button onClick={() => void onAddScenarioRequest(activeScenario.id, detail.id, "exclude")}>排除</button>
                          </div>
                        )}
                        <button className="button ghost compact" onClick={() => void onLoadRelations()}>重新计算候选</button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>

        {inlineOpen && (
          <aside ref={inlinePanel} className="inline-ai" aria-label="就地 AI 分析" tabIndex={-1}>
            <PanelResize name="调整就地分析宽度" variable="--inline-width" initial={29} reverse />
            <div className="inline-ai-head">
              <div><span className="eyebrow">本地分析</span><h3>就地分析</h3></div>
              <div className="inline-ai-actions">
                <button title="打开完整 AI 工作区" onClick={onFullAI}><ArrowUpRight size={14} /></button>
                <button title="收起" onClick={onInlineClose}><X size={14} /></button>
              </div>
            </div>
            <div className="scope-card compact-scope">
              <div><span>固定范围</span><b>{scope?.requestCount ?? (multiSelected.length || requestPage.matchCount)} 条</b></div>
              <div><span>批次总量</span><b>{scope?.batchCount ?? requestPage.batchCount}</b></div>
              <div><span>设备</span><b>{scope?.devices?.join("、") || filters.sourceIp || "全部"}</b></div>
              <div><span>快照</span><b>{scope?.snapshotAt ? new Date(scope.snapshotAt).toLocaleTimeString("zh-CN") : "启动时固定"}</b></div>
              {scope?.unfinishedCount ? <p>{scope.unfinishedCount} 条请求在快照时尚未完成。</p> : null}
            </div>
            <div className="inline-quick-actions">
              <button onClick={() => void analyze("定位当前范围中的失败请求，区分网络、TLS、HTTP、规则和业务错误。")}><Ban size={12} /> 定位失败</button>
              <button onClick={() => void analyze("分析当前范围中的慢接口，给出 P95、样本量、弱网/Mock影响和观测限制。")}><Clock3 size={12} /> 慢接口</button>
              <button disabled={multiSelected.length !== 2} onClick={() => void analyze("对比当前选中请求，列出 Header、Query 和 JSON 字段差异。")}><GitCompareArrows size={12} /> 对比选中</button>
              <button onClick={() => void analyze("识别重复请求、轮询和重试候选，不要直接宣布前端缺陷。")}><RotateCcw size={12} /> 重复模式</button>
            </div>
            <div className="inline-process">
              {!live && events.length === 0 && <div className="inline-empty"><Sparkles size={18} /><b>选择一个快捷分析或直接提问</b><span>工具步骤、证据和回答都会保留在当前会话中。</span></div>}
              {live?.tools.map((tool) => (
                <div className={`inline-step ${tool.status}`} key={tool.callId || tool.id}>
                  {tool.status === "running" ? <LoaderCircle className="spin" size={12} /> : tool.status === "done" ? <Check size={12} /> : <X size={12} />}
                  <span>{tool.name}</span>
                  {tool.durationMs != null && <small>{tool.durationMs} ms</small>}
                </div>
              ))}
              {live?.content && <div className="inline-answer">{live.content}</div>}
              {evidence.length > 0 && (
                <div className="inline-evidence">
                  <div className="section-heading"><h3>证据</h3><span>{evidence.length}</span></div>
                  {evidence.slice(-12).map((item) => (
                    <button
                      key={item.id}
                      className={item.state}
                      onClick={() => onEvidenceSelect(item.requestId, item.direction, item.locator)}
                    >
                      <span>{item.summary}</span>
                      <code>{item.requestId} · {item.locator}</code>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="inline-composer">
              <textarea
                value={prompt}
                placeholder="就当前抓包范围继续追问…"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void analyze(prompt);
                  }
                }}
              />
              <div>
                <span>{multiSelected.length ? `${multiSelected.length} 条选中` : "当前筛选范围"}</span>
                <button disabled={!prompt.trim() || agentBusy} onClick={() => void analyze(prompt)}>
                  {agentBusy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
