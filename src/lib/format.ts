export function formatBytes(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

export function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function shortPath(path: string): string {
  try {
    const url = new URL(path, "https://local.invalid");
    return url.pathname + url.search;
  } catch {
    return path;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function statusTone(status: number | null): string {
  if (!status) return "pending";
  if (status >= 500) return "bad";
  if (status >= 400) return "warn";
  if (status >= 300) return "redirect";
  return "good";
}

export function methodTone(method: string): string {
  const value = method.toUpperCase();
  if (value === "GET") return "get";
  if (value === "POST") return "post";
  if (value === "PUT" || value === "PATCH") return "put";
  if (value === "DELETE") return "delete";
  return "other";
}

export function ruleLabel(type: string): string {
  return type === "local" ? "Map Local" : type === "remote" ? "Map Remote" : "Rewrite";
}
