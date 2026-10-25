import { AlertTriangle, Check, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

const steps = [
  ["engine", "启动本地引擎"], ["storage", "打开项目与数据"], ["workspace", "载入工作区"],
];
export function StartupScreen({ stage, error }: { stage: string; error: string | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const start = Date.now(); const timer = window.setInterval(() => setElapsed(Math.floor((Date.now()-start)/1000)), 1000); return () => window.clearInterval(timer); }, []);
  const at = Math.max(0, steps.findIndex(([key]) => key === stage));
  return <main className="boot-screen" data-tauri-drag-region>
    <img className="startup-icon" src="/brand/app-icon.png" alt="" />
    <h1>{error ? "工作区暂时无法打开" : "AI Proxy"}</h1>
    <p>{error ? "本地数据没有被清理。核对下方原因后重新连接。" : "首次启动会准备本地目录和证书；无需安装 Python 或额外服务。"}</p>
    <ol className="startup-steps" aria-label="启动进度">{steps.map(([key, label], index) => <li key={key} className={index === at ? "current" : ""}>
      {index < at ? <Check size={16} /> : index === at ? error ? <AlertTriangle size={16} /> : <LoaderCircle size={16} className="spin" /> : <span className="startup-step-dot" />}<span>{label}</span>
    </li>)}</ol>
    {error ? <><p className="startup-error" role="alert">{error}</p><button className="button primary" onClick={() => window.location.reload()}>重新连接</button></> : <>
      <p className="small" role="status">已等待 {elapsed} 秒 · 本轮连接最长等待 95 秒</p>
      {elapsed >= 10 && <p>旧数据升级或首次解包可能较慢。请等待当前结果；超时后会给出错误和重试入口。</p>}
    </>}
    <p className="startup-note">启动不会开启代理或请求模型。成功后可直接离线导入数据。</p>
  </main>;
}
