import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { beginOperation, finishOperation, isReadMethod, resetOperations, usesShortTimeout } from "./operations";

export class OperationError extends Error {
  constructor(message: string, public readonly outcomeUnknown: boolean, public readonly timedOut: boolean, public readonly code = "internal") { super(message); }
}

export interface AgentIssue { message: string; code: string; outcomeUnknown?: boolean }
export function agentIssue(reason: unknown): AgentIssue {
  if (reason instanceof OperationError) return { message: reason.message, code: reason.code, outcomeUnknown: reason.outcomeUnknown };
  if (reason && typeof reason === "object" && "message" in reason && "code" in reason) return reason as AgentIssue;
  const message = reason instanceof Error ? reason.message : String(reason);
  try {
    const value = JSON.parse(message);
    if (typeof value.message === "string" && typeof value.code === "string") return value;
  } catch { /* Native transport failures use plain text. */ }
  return { message, code: "internal" };
}

export async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const readOnly = isReadMethod(method);
  const timeoutMs = usesShortTimeout(method) ? 25000 : method.startsWith("qa.") ? 125000 : 95000;
  const operation = beginOperation(method, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      invoke<T>("engine_call", { method, params }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OperationError(readOnly
          ? `读取超时（${timeoutMs / 1000} 秒），请重试：${method}`
          : `操作回执超时，请先检查实际结果后再重试：${method}`, !readOnly, true)), timeoutMs);
      }),
    ]);
    finishOperation(operation, "completed");
    if (method === "projects.select" || method === "storage.clear-all") resetOperations();
    return result;
  } catch (reason) {
    const issue = agentIssue(reason);
    const message = issue.message;
    const timeout = reason instanceof OperationError ? reason.timedOut : /超时|timed out/i.test(message);
    const transport = timeout || /引擎已退出|引擎未运行|写入引擎失败|channel.*closed/i.test(message);
    const unknown = !readOnly && transport;
    finishOperation(operation, unknown ? "unknown" : timeout ? "timeout" : "failed");
    throw new OperationError(unknown ? `${message}。回执未知，请先核对操作历史和实际结果，不要直接重复执行。` : message, unknown, timeout, unknown ? "receipt_unknown" : timeout ? "timeout" : issue.code);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let confirmationOpen = false;

export async function confirmAction(message: string): Promise<boolean> {
  if (confirmationOpen) return false;
  confirmationOpen = true;
  try {
    return await invoke<boolean>("confirm_action", { message });
  } finally {
    confirmationOpen = false;
  }
}

export async function clearProjectData(scope: "analysis" | "project"): Promise<void> {
  const result = await call<{ clearedLocalState: { projectId: string; batchIds: string[]; sessionIds: string[]; reportIds: string[] } }>("storage.clear-all", { scope });
  const cleared = result.clearedLocalState;
  window.dispatchEvent(new Event("ai-proxy-project-cleared"));
  const keys = [
    `ai-proxy-qa-draft:${cleared.projectId}`,
    ...cleared.sessionIds.flatMap(id => [`ai-proxy-draft:${id}`, `ai-proxy-active-run:${id}`, `ai-proxy-pending-send:${id}`]),
    ...cleared.reportIds.map(id => `ai-proxy-report-draft:${id}`),
  ];
  keys.forEach(key => localStorage.removeItem(key));
  for (const key of Object.keys(localStorage)) {
    if (cleared.batchIds.some(id => key === `ai-proxy-capture-ui:${id}` || key.startsWith(`ai-proxy-capture-ui:${id}:`))) localStorage.removeItem(key);
  }
  sessionStorage.removeItem(`ai-proxy-evidence-return:${cleared.projectId}`);
  sessionStorage.removeItem("ai-proxy-evidence-return");
}

export function onEngine<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (message) => handler(message.payload));
}

export async function pickLocalFile(): Promise<string | null> {
  return invoke<string | null>("pick_local_file");
}

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function saveTextFile(fileName: string, content: string): Promise<string | null> {
  return invoke<string | null>("save_text_file", { fileName, content });
}

export async function credentialStatus(account: string): Promise<{ saved: boolean; storage: string }> {
  return invoke("credential_status", { account });
}

export interface HostProxyStatus {
  active: boolean;
  service: string | null;
  server: string | null;
  port: number | null;
  canRestore: boolean;
}

export async function localProxyStatus(): Promise<HostProxyStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<HostProxyStatus>("local_proxy_status"),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("读取本机代理状态超时（10秒），请主动重试")), 10000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function enableLocalProxy(port: number): Promise<HostProxyStatus> {
  return invoke<HostProxyStatus>("local_proxy_enable", { port });
}

export async function restoreLocalProxy(): Promise<HostProxyStatus> {
  return invoke<HostProxyStatus>("local_proxy_restore");
}

export async function saveBinaryFile(fileName: string, base64: string): Promise<string | null> {
  const raw = atob(base64);
  return invoke<string | null>("save_bytes_file", { fileName, content: Array.from(raw, character => character.charCodeAt(0)) });
}

// Explicit UI reveal only; never used for model calls or persisted in JS storage.
export async function revealCredential(account: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<string>("credential_reveal", { account }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("密钥读取超时（10秒），请主动重试查看")), 10000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
