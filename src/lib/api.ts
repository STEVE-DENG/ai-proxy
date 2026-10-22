import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("engine_call", { method, params });
}

export function onEngine<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (message) => handler(message.payload));
}

export async function pickLocalFile(): Promise<string | null> {
  return invoke<string | null>("pick_local_file");
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
