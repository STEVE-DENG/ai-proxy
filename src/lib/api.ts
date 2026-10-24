import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("engine_call", { method, params });
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
    ...cleared.sessionIds.flatMap(id => [`ai-proxy-draft:${id}`, `ai-proxy-active-run:${id}`]),
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

export async function saveSecret(account: string, secret: string): Promise<void> {
  return invoke("secret_set", { account, secret });
}

export async function getSecret(account: string): Promise<string | null> {
  return invoke<string | null>("secret_get", { account });
}

export async function deleteSecret(account: string): Promise<void> {
  return invoke("secret_delete", { account });
}

export interface HostProxyStatus {
  active: boolean;
  service: string | null;
  server: string | null;
  port: number | null;
  canRestore: boolean;
}

export async function localProxyStatus(): Promise<HostProxyStatus> {
  return invoke<HostProxyStatus>("local_proxy_status");
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
