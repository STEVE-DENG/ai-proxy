import { useState } from "react";

export function DiagnosticCopy({ area, runId, status }: { area: string; runId?: string | null; status?: string }) {
  const [message, setMessage] = useState("");
  return <button className="button ghost compact" onClick={async () => {
    // Copy only selected metadata; errors and captured content can contain secrets.
    const diagnostic = { app: "AI Proxy", version: "0.1.0", at: new Date().toISOString(), area, runId: runId || null, status: status || "unknown" };
    try { await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2)); setMessage("已复制诊断摘要"); }
    catch { setMessage("复制失败，请手动记录任务 ID"); }
  }}>{message || "复制诊断摘要（不含正文或凭据）"}</button>;
}
