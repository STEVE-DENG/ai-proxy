import { useState } from "react";

const labels: Record<string, string> = {
  status: "状态", state: "状态", summary: "摘要", message: "说明", error: "错误", warnings: "提示", coverage: "覆盖范围",
  truncated: "已截断", unknown: "未知", missing: "缺失", unavailable: "不可用", gaps: "数据缺口", complete: "完整性",
  items: "结果条目", checks: "检查项", results: "结果", differences: "差异", unmatched: "未配对", matched: "已配对", pairs: "配对",
  requestId: "证据请求", requestIds: "证据请求", evidence: "证据", missingSections: "未包含部分", outcome: "结果",
  passed: "通过", failed: "失败", pending: "待验证", investigate: "待查", success: "成功", reason: "原因", note: "记录",
};

function Value({ value, depth, onRequest }: { value: unknown; depth: number; onRequest: (id: string) => void }) {
  const [limit, setLimit] = useState(12);
  if (value == null) return <span className="muted">未提供</span>;
  if (typeof value !== "object") {
    const text = typeof value === "boolean" ? value ? "是" : "否" : String(value);
    if (/^req_[a-zA-Z0-9_-]+$/.test(text)) return <button className="link-button" onClick={() => onRequest(text)}>{text}</button>;
    return <span>{labels[text] || text}</span>;
  }
  if (depth >= 3) return <details><summary>展开技术字段</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
  if (Array.isArray(value)) return <div className="result-items">
    {!value.length && <span className="muted">无条目</span>}
    {value.slice(0, limit).map((item, index) => <div className="result-item" key={index}><Value value={item} depth={depth + 1} onRequest={onRequest} /></div>)}
    {value.length > limit && <button className="button ghost compact" onClick={() => setLimit(limit + 12)}>继续显示（当前 {limit}/{value.length}）</button>}
  </div>;
  return <dl className="result-fields">{Object.entries(value).map(([name, item]) => <div key={name}><dt>{labels[name] || name}</dt><dd><Value value={item} depth={depth + 1} onRequest={onRequest} /></dd></div>)}</dl>;
}

export function ResultSummary({ value, onRequest }: { value: unknown; onRequest: (id: string) => void }) {
  return <div className="qa-output"><h4>结果与证据</h4><p className="boundary-note">请分别核对检查结果、未覆盖范围与数据缺口；操作完成不代表所有验证通过。</p><Value value={value} depth={0} onRequest={onRequest} /><details><summary>原始 JSON / 完整技术详情</summary><pre>{JSON.stringify(value, null, 2)}</pre></details></div>;
}
