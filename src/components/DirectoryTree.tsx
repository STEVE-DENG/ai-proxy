import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, LoaderCircle, Star } from "lucide-react";
import { call } from "../lib/api";
import type { CaptureFilters, CaptureTreeNode, CaptureTreePayload, CaptureUiState, RequestSummary } from "../types";

interface Props {
  batchId: string; filters: CaptureFilters; running: boolean; revision: number; rowHeight: number;
  selected: RequestSummary | null; seekNonce: number; ui: CaptureUiState; onUi: (patch: Partial<CaptureUiState>) => void;
  renderRequest: (request: RequestSummary, depth: number) => ReactNode;
}
interface Page { nodes: CaptureTreeNode[]; items: RequestSummary[]; offset: number; next: number | null; total: number; busy: boolean; error?: string; partial?: boolean }
type Row = { key: string; parent?: string; depth: number; node?: CaptureTreeNode; request?: RequestSummary; kind: "node" | "request" | "pager" | "loading" | "other"; top: number; height: number };
const ROOT = "directory-root";
const PAGE_SIZE = 200;

// Kept separate from the default Host → request view, with the same filters and IDs.
export function DirectoryTree({ batchId, filters, running, revision, rowHeight, selected, seekNonce, ui, onUi, renderRequest }: Props) {
  const [seekResult, setSeekResult] = useState("");
  const [seekRetry, setSeekRetry] = useState(0);
  const [pages, setPages] = useState<Record<string, Page>>({});
  const pagesRef = useRef(pages); pagesRef.current = pages;
  const uiRef = useRef(ui); uiRef.current = ui;
  const onUiRef = useRef(onUi); onUiRef.current = onUi;
  const patchUi = (patch: Partial<CaptureUiState>) => { uiRef.current = { ...uiRef.current, ...patch }; onUiRef.current(patch); };
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: ui.listPositions?.directories?.scrollTop || 0, height: 600 });
  const flights = useRef(new Map<string, Promise<Page | undefined>>());
  const alive = useRef(true);
  const rowsRef = useRef<Row[]>([]);
  const positioned = useRef(seekNonce ? "" : `${selected?.id || ""}:0`);
  const restored = useRef(false);
  const searchOpens = useRef(new Map<string, boolean>());
  const [, redrawSearch] = useState(0);
  const expanding = useRef(false);
  const refreshCursor = useRef(0);
  const searching = Boolean(filters.query.trim());
  const isOpen = (key: string) => key === "other-hosts"
    ? (searching ? searchOpens.current.get(key) : uiRef.current.openNodes[key]) !== false
    : searching ? searchOpens.current.get(key) === true : !!uiRef.current.openNodes[key];
  const load = useCallback((node?: CaptureTreeNode, offset?: number, target?: RequestSummary): Promise<Page | undefined> => {
    const key = node?.key || ROOT;
    if (flights.current.has(key)) {
      const flight = flights.current.get(key)!;
      return target ? flight.then(() => alive.current ? load(node, offset, target) : undefined) : flight;
    }
    const previous = pagesRef.current[key];
    const start = offset ?? previous?.offset ?? uiRef.current.treePageOffsets?.[`directories:${key}`] ?? 0;
    const parent = node ? { type: node.type, root: node.root, path: node.path, method: node.method, offset: start,
      targetPath: target?.path, targetId: target?.id } : { type: "hosts", offset: start, targetId: target?.id };
    const pending: Page = { ...(previous || { nodes: [], items: [], next: null, total: 0, offset: start }), busy: true, error: undefined };
    pagesRef.current = { ...pagesRef.current, [key]: pending }; setPages(pagesRef.current);
    const task = (async () => {
      try {
        const result = await call<CaptureTreePayload>("requests.tree", { batchId, filters, parent, limit: PAGE_SIZE });
        if (!alive.current) return;
        const page: Page = { nodes: result.nodes || [], items: result.items || [], offset: result.offset || 0,
          next: result.nextOffset ?? null, total: result.nodeCount ?? result.matchCount ?? 0, busy: false,
          partial: result.truncated || result.coverage.partial };
        pagesRef.current = { ...pagesRef.current, [key]: page }; setPages(pagesRef.current);
        patchUi({ treePageOffsets: { ...uiRef.current.treePageOffsets, [`directories:${key}`]: page.offset } });
        return page;
      } catch (reason) {
        if (alive.current) {
          pagesRef.current = { ...pagesRef.current, [key]: { ...pending, busy: false, error: String(reason) } };
          setPages(pagesRef.current);
        }
      } finally { flights.current.delete(key); }
    })();
    flights.current.set(key, task);
    return task;
  }, [batchId, filters]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(value => ({ ...value, height: element.clientHeight })));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const changeOpen = (key: string, value: boolean) => {
    if (searching) { searchOpens.current.set(key, value); redrawSearch(value => value + 1); }
    else patchUi({ openNodes: { ...uiRef.current.openNodes, [key]: value } });
  };
  const toggle = (node: CaptureTreeNode) => {
    const opening = !isOpen(node.key); changeOpen(node.key, opening);
    if (opening && !pagesRef.current[node.key]) void load(node);
  };
  const refreshVisible = useCallback(() => {
    if (document.hidden) return;
    const top = scroll.current?.scrollTop || 0, bottom = top + (scroll.current?.clientHeight || 600);
    const keys = new Set<string>();
    for (const row of rowsRef.current) {
      if (row.top + row.height < top || row.top >= bottom) continue;
      if (row.parent) keys.add(row.parent);
      if (row.node && pagesRef.current[row.key]) keys.add(row.key);
    }
    void load();
    const candidates = [...keys].filter(key => key !== ROOT);
    const start = refreshCursor.current % Math.max(1, candidates.length);
    refreshCursor.current += 3;
    [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 3).forEach(key => {
      const node = rowsRef.current.find(row => row.key === key)?.node;
      if (node && !pagesRef.current[key]?.error) void load(node);
    });
  }, [load]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) refreshVisible(); };
    document.addEventListener("visibilitychange", visible);
    const timer = running ? window.setInterval(refreshVisible, 2000) : undefined;
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [running, refreshVisible]);
  useEffect(() => { if (!running) refreshVisible(); }, [revision, running, refreshVisible]);

  const rows: Row[] = [];
  let height = 0;
  const append = (row: Omit<Row, "top" | "height">, size = rowHeight) => { rows.push({ ...row, top: height, height: size }); height += size; };
  const appendPage = (key: string, node: CaptureTreeNode | undefined, depth: number) => {
    if (rows.length >= 10000 || depth > 64) return;
    const page = pages[key];
    if (!page) { append({ key: `loading:${key}`, parent: key, node, depth, kind: "loading" }); return; }
    for (const child of page.nodes) {
      if (rows.length >= 10000) break;
      append({ key: child.key, parent: node?.key, node: child, depth, kind: "node" });
      if (searching && !searchOpens.current.has(child.key) && searchOpens.current.size < 200) searchOpens.current.set(child.key, true);
      if (isOpen(child.key)) appendPage(child.key, child, depth + 1);
    }
    for (const request of page.items) { if (rows.length >= 10000) break; append({ key: request.id, parent: key, request, depth, kind: "request" }); }
    if (page.error || page.partial || page.offset > 0 || page.next != null) append({ key: `pager:${key}`, parent: key, node, depth, kind: "pager" }, rowHeight * 2);
    if (page.busy && !page.nodes.length && !page.items.length) append({ key: `loading:${key}`, parent: key, node, depth, kind: "loading" });
  };
  const root = pages[ROOT];
  if (root) {
    const roots = root.nodes;
    const focused = roots.filter(node => ui.focusHosts.includes(node.root));
    const others = roots.filter(node => !ui.focusHosts.includes(node.root));
    const appendHost = (node: CaptureTreeNode) => {
      append({ key: node.key, node, depth: 0, kind: "node" });
      if (searching && !searchOpens.current.has(node.key) && searchOpens.current.size < 200) searchOpens.current.set(node.key, true);
      if (isOpen(node.key)) appendPage(node.key, node, 1);
    };
    focused.forEach(appendHost);
    if (focused.length && others.length) append({ key: "other-hosts", depth: 0, kind: "other" });
    if (!focused.length || isOpen("other-hosts")) others.forEach(appendHost);
    if (root.error || root.partial || root.offset > 0 || root.next != null) append({ key: `pager:${ROOT}`, depth: 0, kind: "pager" }, rowHeight * 2);
  }
  rowsRef.current = rows;
  const visible = rows.filter(row => row.top + row.height >= viewport.top - rowHeight * 5 && row.top < viewport.top + viewport.height + rowHeight * 5);
  const visibleKey = visible.map(row => row.key).join("\n");
  useEffect(() => {
    let count = 0;
    for (const row of rowsRef.current) {
      if (count >= 4) break;
      if ((row.kind === "node" && isOpen(row.key) || row.kind === "loading") && row.node && !pagesRef.current[row.node.key]) { count++; void load(row.node); }
    }
  }, [visibleKey, ui.openNodes, pages, load]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || restored.current) return;
    const target = ui.listPositions?.directories?.scrollTop || 0;
    element.scrollTop = target;
    setViewport(value => ({ ...value, top: element.scrollTop }));
    if (element.scrollTop >= target - 1) restored.current = true;
  }, [height]);

  useEffect(() => {
    const positionKey = `${selected?.id || ""}:${seekNonce}`;
    if (!selected || positioned.current === positionKey) return;
    let live = true;
    setSeekResult("正在定位所选请求…");
    const timer = window.setTimeout(() => { if (live) { live = false; setSeekResult("定位等待已超过25秒，请缩小筛选或切换逐请求视图后重试。"); } }, 25000);
    const finish = (message: string) => { if (live) { window.clearTimeout(timer); setSeekResult(message); } };
    void (async () => {
      const location = await call<{status: string; request?: RequestSummary}>("requests.locate", {batchId, filters, requestId: selected.id});
      if (!live) return;
      if (location.status !== "available" || !location.request) { finish(location.status === "deleted" ? "来源请求已删除，不能定位。" : "当前批次或筛选排除了目标，请调整范围。"); return; }
      const target = location.request;
      let page = await load(undefined, 0, target);
      if (!live) return;
      if (!page) { finish("目录读取失败，请重试定位或切换逐请求视图。"); return; }
      let node = page.nodes.find(item => item.host === target.host && item.scheme === target.scheme && item.port === target.port);
      const path = target.path.split("?")[0] || "/";
      for (let depth = 0; node && depth < 64; depth++) {
        changeOpen(node.key, true);
        if (!uiRef.current.focusHosts.includes(node.root)) changeOpen("other-hosts", true);
        page = await load(node, 0, target);
        if (!live) return;
        if (!page) { finish("目录读取失败，请重试定位。"); return; }
        if (page.items.some(item => item.id === target.id)) {
          requestAnimationFrame(() => {
            if (!live) return;
            const row = rowsRef.current.find(item => item.request?.id === target.id);
            if (row && scroll.current) {
              positioned.current = positionKey; restored.current = true;
              scroll.current.scrollTop = row.top; setViewport(value => ({ ...value, top: row.top })); finish("已定位所选请求。");
            } else finish("目标超出目录展开上限，请全部收起后重试或切换逐请求视图。");
          });
          return;
        }
        node = page.nodes.find(item => item.type === "group" ? item.path === path && item.method === target.method
          : item.type === "directory" && (item.path === path || path.startsWith(`${item.path}/`)));
      }
      finish(node ? "目标目录超过64层，请切换逐请求视图定位。" : "当前目录分页未找到目标，来源或筛选可能已变化，请重试定位或切换逐请求视图。");
    })().catch(reason => finish(`定位读取失败：${String(reason)}`));
    return () => { live = false; window.clearTimeout(timer); };
  }, [selected?.id, seekNonce, load, seekRetry]);

  const expandLevel = async () => {
    if (expanding.current) return;
    expanding.current = true;
    try {
    const frontier = rowsRef.current.filter(row => row.kind === "node" && row.node && !isOpen(row.key));
    const depth = Math.min(...frontier.map(row => row.depth));
    const nodes = frontier.filter(row => row.depth === depth).slice(0, 200);
    if (searching) { nodes.forEach(row => searchOpens.current.set(row.key, true)); redrawSearch(value => value + 1); }
    else patchUi({ openNodes: { ...uiRef.current.openNodes, ...Object.fromEntries(nodes.map(row => [row.key, true])) } });
    for (let i = 0; i < nodes.length && alive.current; i += 4) await Promise.all(nodes.slice(i, i + 4).map(row => load(row.node)));
    } finally { expanding.current = false; }
  };
  const focus = (row: Row) => {
    if (scroll.current) { restored.current = true; scroll.current.scrollTop = row.top; setViewport(value => ({ ...value, top: row.top })); }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = scroll.current?.querySelector<HTMLElement>(`[data-dir-key="${CSS.escape(row.key)}"]`);
      (element?.matches("button") ? element : element?.querySelector<HTMLElement>("button"))?.focus();
    }));
  };
  return <section className="directory-browser">
    {seekResult && <div className="boundary-note" role="status">{seekResult}<button onClick={() => { positioned.current = ""; setSeekRetry(value => value+1); }}>重试定位</button><button onClick={() => patchUi({view: "structure"})}>切换逐请求视图</button></div>}
    <div className="tree-actions"><button onClick={() => {
      if (searching) { for (const key of searchOpens.current.keys()) searchOpens.current.set(key, false); redrawSearch(value => value + 1); }
      else patchUi({ openNodes: {} });
    }}>全部收起</button><button onClick={() => void expandLevel()}>展开下一层（最多200节点）</button></div>
    <div className="directory-scroll" ref={scroll} tabIndex={0} aria-label="可折叠目录与逐次请求"
      onWheel={() => { restored.current = true; }} onPointerDown={() => { restored.current = true; }}
      onScroll={event => { const top = event.currentTarget.scrollTop; setViewport(value => ({ ...value, top })); if (restored.current) patchUi({ listPositions: { ...uiRef.current.listPositions, directories: { scrollTop: top } } }); }}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const navigable = rows.filter(row => row.kind === "node" || row.kind === "request" || row.kind === "other");
        if (!navigable.length) return;
        const key = (event.target as HTMLElement).closest<HTMLElement>('[data-dir-key]')?.dataset.dirKey;
        const index = navigable.findIndex(row => row.key === key), row = navigable[index];
        if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && row?.kind === "other") changeOpen(row.key, event.key === "ArrowRight");
        else if (event.key === "ArrowRight" && row?.node) { if (!isOpen(row.key)) toggle(row.node); else if (navigable[index + 1]?.parent === row.key) focus(navigable[index + 1]); }
        else if (event.key === "ArrowLeft" && row) { if (row.node && isOpen(row.key)) toggle(row.node); else { const parent = navigable.find(item => item.key === row.parent); if (parent) focus(parent); } }
        else { const next = event.key === "Home" ? 0 : event.key === "End" ? navigable.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1); focus(navigable[Math.max(0, Math.min(navigable.length - 1, next))]); }
      }}>
      {(!root || root.busy && !root.nodes.length) && <p role="status">正在读取目录…</p>}
      {root && !root.busy && !root.error && !root.nodes.length && <p>当前筛选没有可显示的目录。</p>}
      <div className="directory-virtual" style={{ height }}>{visible.map(row => <div key={row.key} className="directory-virtual-row" style={{ top: row.top, height: row.height, paddingLeft: Math.min(row.depth, 10) * 12 }}>
        {row.kind === "request" && row.request ? <div data-dir-key={row.key} tabIndex={-1}>{renderRequest(row.request, 0)}</div>
          : row.kind === "node" && row.node ? <div className="directory-node">
            <button data-dir-key={row.key} className={row.node.type === "host" ? "host-row" : row.node.type === "directory" ? "directory-row" : "group-row"} aria-expanded={!!isOpen(row.key)} onClick={() => toggle(row.node!)}>
              {isOpen(row.key) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {row.node.type === "directory" && <Folder size={13} />}
              <span className="directory-name">{row.node.type === "group" ? `${row.node.method} ${row.node.path}` : row.node.name}</span>
              {row.node.inProgressCount > 0 && <LoaderCircle size={12} className="spin" />}
              {row.node.failureCount > 0 && <span className="host-fail">{row.node.failureCount}失败</span>}
              <span className="host-count" title={`最近状态：${row.node.latestStatus ?? "未知"}`}>{row.node.count}</span>
            </button>
            {row.node.type === "host" && <button aria-label={`${ui.focusHosts.includes(row.node.root) ? "取消关注" : "关注"} ${row.node.name}`} onClick={() => patchUi({ focusHosts: ui.focusHosts.includes(row.node!.root) ? ui.focusHosts.filter(value => value !== row.node!.root) : [...ui.focusHosts, row.node!.root] })}><Star size={12} fill={ui.focusHosts.includes(row.node.root) ? "currentColor" : "none"} /></button>}
          </div> : row.kind === "other" ? <button className="other-hosts-label" data-dir-key={row.key} aria-expanded={isOpen(row.key)} onClick={() => changeOpen(row.key, isOpen(row.key) === false)}>其他Host · {isOpen(row.key) === false ? "展开" : "收起"}</button>
          : row.kind === "loading" ? <span role="status"><LoaderCircle className="spin" size={12} /> 正在读取…</span>
          : (() => { const page = pages[row.node?.key || ROOT]; if (!page) return null; return <div className="directory-pager">
            {page.error && <span role="alert">{page.error}</span>}{page.partial && <span>部分节点未检查，请缩小范围</span>}
            <button disabled={page.busy || !page.error && page.offset === 0} onClick={() => void load(row.node, page.error ? page.offset : Math.max(0, page.offset - PAGE_SIZE))}>{page.error ? "重试" : "上一页"}</button>
            <span>{page.total ? `${page.offset + 1}–${page.offset + page.nodes.length + page.items.length}/${page.total}` : "无匹配"}</span>
            <button disabled={page.busy || page.next == null} onClick={() => void load(row.node, page.next!)}>下一页</button>
          </div>; })()}
      </div>)}</div>
    </div>
    {searching && searchOpens.current.size >= 200 && <p className="boundary-note">搜索自动展开最多200节点，更多路径可手动展开；清除搜索后恢复原折叠状态。</p>}
    {rows.length >= 10000 && <p className="boundary-note">展开已达1万行，请收起部分目录或缩小筛选。</p>}
  </section>;
}
