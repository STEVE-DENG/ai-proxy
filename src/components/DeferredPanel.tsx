import { Component, Suspense, type ReactNode } from "react";
import { Dialog } from "./Dialogs";
class PanelLoadBoundary extends Component<{children: ReactNode; open: boolean; onClose: () => void}, {failed: boolean}> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <Dialog open={this.props.open} title="面板未能载入" onClose={this.props.onClose}><p>本地界面资源未能载入。已保存的数据保留，请关闭面板后保存当前草稿，再重新打开应用。</p><button className="button" onClick={this.props.onClose}>返回工作区</button></Dialog> : this.props.children;
  }
}
export function DeferredPanel({children, open, onClose}: {children: ReactNode; open: boolean; onClose: () => void}) {
  return <PanelLoadBoundary open={open} onClose={onClose}><Suspense fallback={<Dialog open={open} title="正在载入工作台" onClose={onClose}><p role="status">正在读取本地界面资源，不会启动代理或发送请求。</p></Dialog>}>{children}</Suspense></PanelLoadBoundary>;
}
