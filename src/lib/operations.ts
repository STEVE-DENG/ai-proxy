// In-memory metadata only. Never retain params, credentials, errors or results.
export interface Operation {
  id: number;
  method: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  timeoutMs: number;
  readOnly: boolean;
  status: "running" | "completed" | "failed" | "timeout" | "unknown";
}

const readMethods = new Set([
  "agent.history", "agent.context.preview", "agent.rebuild-preview", "agent.context", "agent.evidence", "agent.runs", "agent.run", "agent.events", "agent.status", "agent.budget", "agent.cache-status", "agent.performance-compare",
  "sessions.get", "sessions.list", "reports.get", "reports.list", "storage.info", "storage.health",
  "agent.original-task", "agent.context.identity", "reports.history", "compose.status", "compose.list", "connections.status", "capture.status", "certificate.info", "qa.catalog", "qa.get", "qa.auth", "qa.file-info", "qa.packages", "qa.operations", "projects.list", "providers.available",
  "batches.list", "rules.list", "throttle.get", "decrypt.list", "providers.list", "evidence.get", "reports.export",
  "scenarios.list", "scenarios.get", "scenarios.compare", "configs.list", "debug.actions", "imports.list",
  "exports.har", "openapi.validate", "openapi.templates", "mcp.servers", "checklist.generate", "qa.body-export", "qa.compare-baseline",
]);
export const isReadMethod = (method: string) => (method.startsWith("requests.") && method !== "requests.add-relation") || readMethods.has(method);
export const usesShortTimeout = (method: string) => (method.startsWith("requests.") && method !== "requests.add-relation") || ["agent.original-task", "agent.context.identity", "reports.history", "compose.status", "compose.list", "agent.history", "agent.context.preview", "agent.rebuild-preview", "agent.context", "agent.evidence", "agent.runs", "agent.run", "agent.events", "agent.status", "sessions.get", "sessions.list", "reports.get", "reports.list", "storage.health", "agent.performance-compare"].includes(method);

const names: Record<string, string> = {
  compose: "Compose与重复请求", requests: "读取抓包", agent: "Agent操作", sessions: "会话", reports: "报告", storage: "存储", connections: "连接诊断", capture: "抓包控制", qa: "QA任务", providers: "供应商", imports: "导入数据", replay: "请求重放", debug: "调试变更", configs: "项目配置", projects: "项目", tickets: "缺陷交接", mcp: "工具调用", observability: "关联查询", checklist: "验证清单",
};
const labels: Record<string, string> = {
  "storage.health": "检查存储健康", "agent.performance-compare": "比较缓存与耗时", "capture.timeouts.set": "保存抓包超时策略", "providers.test": "检查供应商连接",
  "requests.detail": "读取请求详情", "requests.tree": "读取请求列表", "requests.relations": "读取关联", "replay.execute": "发送重放请求", "qa.recipe-step": "预览或执行步骤", "imports.har": "导入HAR", "agent.start": "创建调查", "agent.continue": "继续调查",
};
let serial = 0;
let entries: Operation[] = [];
const subscribers = new Set<() => void>();
const notify = () => { for (const fn of subscribers) fn(); };
export const subscribeOperations = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
export const getOperations = () => entries;
export function beginOperation(method: string, timeoutMs: number): number {
  const id = ++serial;
  entries = entries.filter(item => item.status === "running" || Date.now() - (item.finishedAt || item.startedAt) < 600_000);
  if (entries.length >= 100) {
    // Polling must not evict a long-running operation or preferentially erase errors.
    let discard = entries.findIndex(item => item.status === "completed");
    if (discard < 0) discard = entries.findIndex(item => item.status !== "running");
    if (discard < 0) return 0; // At capacity: preserve all already tracked active tasks.
    entries = entries.filter((_, index) => index !== discard);
  }
  entries = [...entries,
    { id, method, label: labels[method] || names[method.split(".")[0]] || "应用操作", startedAt: Date.now(), timeoutMs, readOnly: isReadMethod(method), status: "running" }];
  // Fast background polling never needs to re-render the whole application.
  return id;
}
export function finishOperation(id: number, status: Operation["status"]) {
  const item = entries.find(item => item.id === id);
  entries = entries.map(item => item.id === id ? { ...item, status, finishedAt: Date.now() } : item);
  if (item && (status !== "completed" || Date.now() - item.startedAt >= 1500)) notify();
}
export function dismissOperation(id: number) { entries = entries.filter(item => item.id !== id); notify(); }
export function dismissFinishedOperations() { entries = entries.filter(item => item.status === "running"); notify(); }
export function pruneOperations() {
  const next = entries.filter(item => item.status === "running" || Date.now() - (item.finishedAt || item.startedAt) < 600_000);
  if (next.length !== entries.length) { entries = next; notify(); }
}
export function resetOperations() { entries = []; notify(); }
