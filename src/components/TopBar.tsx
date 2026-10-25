import { Activity, CircleHelp, Bot, FileCode2, Radio, ShieldCheck, SlidersHorizontal, Smartphone, WifiOff } from "lucide-react";
import type { CaptureStatus, LocalProxyStatus, ThrottleStatus, View } from "../types";

interface Props {
  view: View;
  onView: (view: View) => void;
  capture: CaptureStatus;
  throttle: ThrottleStatus;
  hostProxy: LocalProxyStatus | null;
  onStart: () => void;
  onPause: () => void;
  onPhone: () => void;
  onThrottle: () => void;
  onRules: () => void;
  onSettings: () => void;
  onHelp: () => void;
  busy: boolean;
  projectName: string;
  onProject: () => void;
}

export function TopBar({
  view,
  onView,
  capture,
  throttle,
  hostProxy,
  onStart,
  onPause,
  onPhone,
  onThrottle,
  onRules,
  onSettings,
  onHelp,
  busy,
  projectName,
  onProject,
}: Props) {
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <div className="brand-mark" data-tauri-drag-region><img src="/brand/app-icon.png" alt="" draggable={false} /></div>
        <div data-tauri-drag-region>
          <div className="brand-name" data-tauri-drag-region>AI 抓包助手</div>
          <div className="brand-kicker" data-tauri-drag-region>本地网络调试</div>
        </div>
      </div>

      <nav className="view-switch" aria-label="工作区">
        <button className={view === "ai" ? "active" : ""} onClick={() => onView("ai")}>
          <Bot size={15} /> AI 分析
        </button>
        <button className={view === "capture" ? "active" : ""} onClick={() => onView("capture")}>
          <FileCode2 size={15} /> 抓包
        </button>
      </nav>

      <div className="topbar-status">
        <span className={`live-dot ${capture.running ? (capture.paused ? "paused" : "on") : ""}`} />
        <span>{capture.running ? (capture.paused ? "记录已暂停" : "正在抓包") : "代理未启动"}</span>
        {capture.running && <span className="mono status-port">:{capture.port}</span>}
      </div>

      <div className="topbar-actions">
        <button className="button ghost compact project-trigger" title="切换独立项目空间" onClick={onProject}>{projectName}</button>
        <button className="icon-action named-action" title="规则" onClick={onRules}>
          <SlidersHorizontal size={17} /><span>规则</span>
        </button>
        <button className={`icon-action named-action ${throttle.enabled ? "active" : ""}`} title="弱网" onClick={onThrottle}>
          <WifiOff size={17} /><span>弱网</span>
        </button>
        <button className={`icon-action named-action ${capture.lan ? "active" : ""}`} title="连接手机" onClick={onPhone}>
          <Smartphone size={17} /><span>连接手机</span>
        </button>
        <button className={`icon-action named-action ${hostProxy?.active ? "active" : ""}`} title="本机代理" onClick={onSettings}>
          <ShieldCheck size={17} /><span>本机代理</span>
        </button>
        <button className="icon-action named-action" title="功能帮助与显示设置" aria-label="功能帮助与显示设置" onClick={onHelp}><CircleHelp size={17} /><span>帮助</span></button>
        <span className="topbar-divider" />
        {capture.running ? (
          <button className="button ghost compact" onClick={onPause} disabled={busy}>
            <Radio size={14} /> {capture.paused ? "继续记录" : "暂停记录"}
          </button>
        ) : (
          <button className="button primary compact" onClick={onStart} disabled={busy}>
            <Activity size={14} /> {busy ? "启动中" : "开始抓包"}
          </button>
        )}
      </div>
    </header>
  );
}
