import { Select } from "./Select";
import { ComposePanel } from "./ComposePanel";
import { HeaderFields } from "./HeaderFields";
import { ResultSummary } from "./ResultSummary";
import { TaskProgress } from "./OperationFeedback";
import { FEATURE_HELP } from "./HelpDialog";
import { useEffect, useRef, useState } from "react";
import { confirmAction, call, pickLocalFile, readTextFile, saveTextFile, saveBinaryFile } from "../lib/api";
import type { ConfigItem, RequestSummary } from "../types";

type Data = Record<string, any>;
type Section = "replay" | "scenario" | "baseline" | "matrix" | "auth" | "files" | "checklist" | "package" | "history";
const sections: Array<[Section, string]> = [["replay", "编辑重放"], ["scenario", "步骤复现"], ["baseline", "基线回归"], ["matrix", "故障矩阵"], ["auth", "鉴权诊断"], ["files", "文件与流"], ["checklist", "人工验证"], ["package", "证据交接"], ["history", "操作历史"]];
const json = (value: unknown) => JSON.stringify(value, null, 2);

export function QAWorkspace({ selected, onSelectRequest, onChanged, initialSection }: { initialSection?: string; selected: RequestSummary | null; onSelectRequest: (id: string) => void; onChanged: () => Promise<void> }) {
  const draftKey = `ai-proxy-qa-draft:${localStorage.getItem("ai-proxy-active-project") || "default"}`;
  const [draft] = useState<Data>(() => { try { return JSON.parse(localStorage.getItem(draftKey) || "{}"); } catch { return {}; } });
  const draftConsumed = useRef(false);
  const [section, setSection] = useState<Section>(draft.section ?? "replay");
  useEffect(() => { if (initialSection && sections.some(([id]) => id === initialSection)) setSection(initialSection as Section); }, [initialSection]);
  const [catalog, setCatalog] = useState<Data>({ items: [], scenarios: [], reports: [], sessions: [] });
  const [busy, setBusy] = useState(false);
  const [taskLabel, setTaskLabel] = useState("处理QA任务");
  const performing = useRef(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState<any>(null);
  const [outputContext, setOutputContext] = useState("");
  const [url, setUrl] = useState(draft.url ?? "");
  const [method, setMethod] = useState(draft.method ?? "GET");
  const [headers, setHeaders] = useState(draft.headers ?? "[]");
  const [body, setBody] = useState(draft.body ?? "");
  const [editBody, setEditBody] = useState(draft.editBody ?? false);
  const selectionKey = `${selected?.id || ""}:${selected?.version || 0}`;
  const [previewEntry, setPreviewEntry] = useState<{ key: string; value: Data } | null>(null);
  const preview = previewEntry?.key === selectionKey ? previewEntry.value : null;
  const setPreview = (value: Data | null) => setPreviewEntry(value ? { key: selectionKey, value } : null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  const [steps, setSteps] = useState<Data[]>(draft.steps ?? []);
  const [name, setName] = useState(draft.name ?? "");
  const [recipeId, setRecipeId] = useState(draft.recipeId ?? "");
  const [runId, setRunId] = useState(draft.runId ?? "");
  const [stepPreview, setStepPreview] = useState<Data | null>(null);
  const [extractName, setExtractName] = useState(draft.extractName ?? "");
  const [extractPath, setExtractPath] = useState(draft.extractPath ?? "/data/token");
  const [scenarioId, setScenarioId] = useState<string>(draft.scenarioId ?? "");
  const [baselineId, setBaselineId] = useState(draft.baselineId ?? "");
  const [keyKind, setKeyKind] = useState(draft.keyKind ?? "pointer");
  const [keyDirection, setKeyDirection] = useState(draft.keyDirection ?? "response");
  const [stepMap, setStepMap] = useState<string>(draft.stepMap ?? "{}");
  const [keyPath, setKeyPath] = useState(draft.keyPath ?? "");
  const [matrixId, setMatrixId] = useState(draft.matrixId ?? "");
  const [matrixCase, setMatrixCase] = useState(draft.matrixCase ?? "empty-list");
  const [matrixEntry, setMatrixEntry] = useState<{ key: string; value: Data } | null>(null);
  const matrixPreview = matrixEntry?.key === selectionKey ? matrixEntry.value : null;
  const setMatrixPreview = (value: Data | null) => setMatrixEntry(value ? { key: selectionKey, value } : null);
  const [sessionId, setSessionId] = useState<string>(draft.sessionId ?? "");
  const [direction, setDirection] = useState("response");
  const [checklist, setChecklist] = useState<ConfigItem | null>(null);
  const [reportId, setReportId] = useState<string>(draft.reportId ?? "");
  const [packagePreview, setPackagePreview] = useState<Data | null>(null);
  const items: ConfigItem[] = catalog.items || [];
  const byKind = (kind: string) => items.filter(item => item.kind === kind);
  const refresh = async () => {
    const data = await call<Data>("qa.catalog");
    setCatalog(data);
    setSessionId(current => current || data.sessions[0]?.id || "");
    setScenarioId(current => current || data.scenarios[0]?.id || "");
    setReportId(current => current || data.reports[0]?.id || "");
  };
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, []);
  useEffect(() => {
    setOutput(null); setPreview(null); setDetailsLoading(false); setDetailError("");
    if (!draftConsumed.current && draft.requestId === selected?.id) { draftConsumed.current = true; return; }
    draftConsumed.current = true;
    setEditBody(false);
    setUrl(""); setHeaders("[]"); setBody("");
    if (!selected) return;
    setDetailsLoading(true);
    let live = true;
    void call<Data>("requests.detail", { requestId: selected.id }).then(detail => {
      if (!live) return;
      setUrl(detail.url); setMethod(detail.method); setHeaders(json(detail.requestHeaders || [])); setBody(detail.requestBodyText || "");
    }).catch(reason => { if (live) setDetailError(String(reason)); }).finally(() => { if (live) setDetailsLoading(false); });
    return () => { live = false; };
  }, [selected?.id, detailRevision]);
  useEffect(() => {
    const value = json({ requestId: selected?.id, section, url, method, headers, body, editBody, steps, name, recipeId, runId, extractName, extractPath, scenarioId, baselineId, keyKind, keyDirection, keyPath, stepMap, matrixId, matrixCase, sessionId, reportId });
    try { if (value.length <= 1_000_000) localStorage.setItem(draftKey, value); } catch { /* Storage quota leaves the current draft editable. */ }
  }, [draftKey, selected?.id, section, url, method, headers, body, editBody, steps, name, recipeId, runId, extractName, extractPath, scenarioId, baselineId, keyKind, keyDirection, keyPath, stepMap, matrixId, matrixCase, sessionId, reportId]);
  const perform = async (operation: () => Promise<any>, reload = false) => {
    if (performing.current || detailsLoading) return;
    performing.current = true;
    setBusy(true); setError("");
    setTaskLabel(`处理${sections.find(([key]) => key === section)?.[1] || "QA任务"}`);
    const context = `${sections.find(([key]) => key === section)?.[1]} · ${selected?.id || "无选定请求"}`;
    try { const result = await operation(); setOutputContext(context); if (result !== undefined) setOutput(result); if (reload) { setTaskLabel("操作已有回执，正在更新目录与页面"); await refresh(); await onChanged(); } return result; }
    catch (reason) { setError(String(reason)); return null; }
    finally { performing.current = false; setBusy(false); }
  };
  const edits = () => ({ url, method, headers: JSON.parse(headers), ...(editBody ? { body } : {}) });
  const selector = () => keyPath ? { kind: keyKind, direction: keyDirection, path: keyPath } : null;
  const selection = <p className="boundary-note">{selected ? `${selected.method} ${selected.url}` : "先在抓包页选择一个请求，再打开工作台。"}</p>;
  const renderItems = (kind: string, value: string, set: (value: string) => void) => <Select value={value} onChange={event => set(event.target.value)}><option value="">请选择</option>{byKind(kind).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>;
  return <section className="qa-workspace">
    <div className="settings-heading"><div><span className="eyebrow">QA WORKFLOWS</span><h3>复现、验证与交接</h3></div><button className="button ghost compact" disabled={busy} onClick={() => void perform(refresh)}>刷新</button></div>
    <nav className="qa-tabs">{sections.map(([key, label]) => <button key={key} disabled={busy} className={`button compact ${section === key ? "primary" : "ghost"}`} onClick={() => { setSection(key); setOutput(null); }}>{label}</button>)}</nav>
    <details className="qa-help"><summary>这一功能怎么用？</summary>{FEATURE_HELP.filter(item => item.name === sections.find(([key]) => key === section)?.[1] || (section === "auth" && item.name === "鉴权诊断") || (section === "files" && item.name === "文件与流") || (section === "package" && item.name === "证据交接与报告")).map(item => <div key={item.name}><p>{item.steps}</p><p className="boundary-note">{item.impact}</p></div>)}</details>
    {error && <div className="error-banner" role="alert">{error}<p>输入已保留。检查前置条件与预览；发送结果未知时先查看操作历史，不要重复发送。</p></div>}
    <TaskProgress busy={busy} label={taskLabel} />
    {detailsLoading && <p role="status">正在读取所选请求，读取结束后可以编辑和预览。</p>}
    {detailError && <div className="error-banner" role="alert">所选请求读取失败：{detailError}<button className="button ghost compact" disabled={busy} onClick={() => setDetailRevision(value => value + 1)}>重新读取所选请求</button></div>}
    <fieldset className="task-fields" disabled={busy || detailsLoading}>
    {section === "replay" && <ComposePanel selected={selected} onSelectRequest={onSelectRequest} />}
    {section === "scenario" && <>
      {selection}<label className="field"><span>场景名称</span><input value={name} onChange={event => setName(event.target.value)} placeholder="登录 → 获取 token → 下单" /></label>
      <div className="form-grid two"><label className="field"><span>从本步骤响应提取变量名（可选）</span><input value={extractName} onChange={event => setExtractName(event.target.value)} placeholder="token" /></label><label className="field"><span>响应 JSON Pointer</span><input value={extractPath} onChange={event => setExtractPath(event.target.value)} /></label></div>
      <p>在「编辑重放」里准备请求，后续步骤可在 URL、Header 或正文里引用 {"${token}"}。每一步均先预览，再人工确认；前置条件失败即停止。</p>
      <button className="button ghost compact" disabled={!selected || !!detailError || busy} onClick={() => { try { setSteps([...steps, { requestId: selected!.id, name: `${selected!.method} ${selected!.path}`, edits: edits(), expectedStatus: 200, extract: extractName ? [{ name: extractName, kind: "pointer", direction: "response", path: extractPath }] : [] }]); setError(""); } catch (reason) { setError(String(reason)); } }}>将当前编辑请求加入步骤</button>
      {steps.map((step, index) => <div className="qa-step" key={index}><b>{index + 1}. {step.name}</b><label>预期状态 <input type="number" value={step.expectedStatus} onChange={event => setSteps(steps.map((value, i) => i === index ? { ...value, expectedStatus: Number(event.target.value) } : value))} /></label><button className="button ghost compact" onClick={() => setSteps(steps.filter((_, i) => i !== index))}>移除</button></div>)}
      <div className="qa-actions"><button className="button primary compact" disabled={!name || !steps.length || busy} onClick={() => void perform(() => call("qa.save", { kind: "qa_recipe", name, config: { steps } }), true)}>保存步骤</button>{renderItems("qa_recipe", recipeId, setRecipeId)}<button className="button ghost compact" disabled={!recipeId || busy} onClick={() => void perform(async () => { const run = await call<Data>("qa.recipe-start", { recipeId }); setRunId(run.id); setStepPreview(null); return run; }, true)}>新建暂停的运行</button></div>
      <label className="field"><span>恢复已保存的场景运行</span>{renderItems("qa_run", runId, value => { setRunId(value); setStepPreview(null); })}</label>
      <div className="qa-actions"><button className="button ghost compact" disabled={!runId || busy} onClick={() => void perform(async () => { const result = await call<Data>("qa.recipe-step", { runId }); setStepPreview(result); return result; })}>预览下一步</button><button className="button primary compact" disabled={!stepPreview || busy} onClick={async () => { if (await confirmAction("确认只执行此步骤一次？")) void perform(async () => { const result = await call("qa.recipe-step", { runId, execute: true, actionId: stepPreview!.preview.id }); setStepPreview(null); return result; }, true); }}>确认此步骤并暂停</button></div>
    </>}
    {section === "baseline" && <>
      <label className="field"><span>业务场景</span><Select value={scenarioId} onChange={event => setScenarioId(event.target.value)}><option value="">请选择场景</option>{catalog.scenarios.map((item: Data) => <option key={item.id} value={item.id}>{item.name} · {item.requestCount} 条</option>)}</Select></label>
      <label className="field"><span>基线名称</span><input value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="form-grid two"><label className="field"><span>业务键来源（可选）</span><Select value={keyKind} onChange={event => setKeyKind(event.target.value)}><option value="pointer">JSON Pointer</option><option value="header">Header</option><option value="query">Query</option></Select></label><label className="field"><span>方向</span><Select value={keyDirection} onChange={event => setKeyDirection(event.target.value)}><option value="response">响应</option><option value="request">请求</option></Select></label></div>
      <label className="field"><span>字段路径 / Header / Query 名称</span><input value={keyPath} onChange={event => setKeyPath(event.target.value)} placeholder="/data/orderId；留空仅配对唯一接口" /></label>
      <label className="field"><span>人工步骤映射 JSON（两侧请求 ID → 相同业务步骤名称，可选）</span><textarea value={stepMap} onChange={event => setStepMap(event.target.value)} placeholder={'{"req_a":"下单","req_b":"下单"}'} /></label>
      <div className="qa-actions"><button className="button primary compact" disabled={!scenarioId || !name || busy} onClick={() => void perform(() => call("qa.baseline", { scenarioId, name, selector: selector(), steps: JSON.parse(stepMap) }), true)}>保存成功基线</button><button className="button ghost compact" disabled={(!keyPath && stepMap === "{}") || busy} onClick={() => void perform(() => call("qa.save", { kind: "qa_pairing", name: "当前业务键配对", config: { selector: selector(), steps: JSON.parse(stepMap) } }), true)}>用于跨场景配对</button></div>
      <div className="qa-actions">{renderItems("qa_baseline", baselineId, setBaselineId)}<button className="button ghost compact" disabled={!baselineId || !scenarioId || busy} onClick={() => void perform(() => call("qa.compare-baseline", { baselineId, scenarioId, steps: JSON.parse(stepMap) }))}>与所选新场景比较</button></div>
      <p className="boundary-note">只配对唯一的接口/步骤/业务键。重复键、未覆盖步骤与新增接口会单独列出；样本版本变化后基线失效。</p>
    </>}
    {section === "matrix" && <>
      <label className="field"><span>恢复已保存矩阵</span>{renderItems("qa_matrix", matrixId, value => { setMatrixId(value); setMatrixPreview(null); })}</label>
      {matrixId && <div className="qa-actions"><button className="button ghost compact" disabled={busy} onClick={() => void perform(() => call("qa.get", { id: matrixId }))}>查看本组结果</button><button className="button ghost compact" disabled={busy} onClick={async () => { if (await confirmAction("恢复本矩阵所有已应用场景？冲突时保留当前配置。")) void perform(() => call("qa.matrix-restore", { matrixId }), true); }}>一次恢复本组</button></div>}
      {selection}<label className="field"><span>共享 Mock 文件所属会话</span><Select value={sessionId} onChange={event => setSessionId(event.target.value)}>{catalog.sessions.map((item: Data) => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></label>
      <label className="field"><span>故障模板</span><Select value={matrixCase} onChange={event => { setMatrixCase(event.target.value); setMatrixPreview(null); }}>{[["empty-list", "空列表"], ["missing-field", "缺字段"], ["business-error", "业务错误"], ["401", "401"], ["429", "429"], ["500", "500"], ["delay", "延迟3秒"], ["disconnect", "连接中断"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      <div className="qa-actions"><button className="button ghost compact" disabled={!selected || !!detailError || !sessionId || busy} onClick={() => void perform(async () => { const result = await call<Data>("qa.matrix-preview", { requestId: selected!.id, sessionId, case: matrixCase, matrixId: matrixId || null }); setMatrixId(result.matrixId); setMatrixPreview(result); return result; }, true)}>生成本地 Mock 并预览</button><button className="button primary compact" disabled={!matrixPreview || busy} onClick={async () => { if (await confirmAction("应用此故障场景到经过代理的匹配请求？")) void perform(() => call("debug.apply", { actionId: matrixPreview!.action.id }), true); }}>启用此场景</button><button className="button ghost compact" disabled={!matrixPreview || busy} onClick={() => void perform(() => call("qa.matrix-record", { matrixId, actionId: matrixPreview!.action.id }))}>查看人工执行结果</button><button className="button ghost compact" disabled={!matrixPreview || busy} onClick={() => void perform(() => call("debug.restore", { actionId: matrixPreview!.action.id }), true)}>恢复此场景</button></div>
      <p className="boundary-note">启用后，用设备人工执行业务。每次只启用一项，恢复后再切换；配置冲突时保留当前配置。历史矩阵与动作保存在操作记录中。</p>
    </>}
    {section === "auth" && <><p>按设备与 Host 查看凭据变化、刷新接口、401/403、重定向和业务错误的候选时间线。</p><button className="button primary compact" disabled={busy} onClick={() => void perform(() => call("qa.auth"))}>分析当前批次（最多5000条，显示覆盖范围）</button></>}
    {section === "files" && <>
      {selection}<div className="form-grid two"><label className="field"><span>正文方向</span><Select value={direction} onChange={event => setDirection(event.target.value)}><option value="response">响应 / 下载</option><option value="request">请求 / 上传</option></Select></label><div className="qa-actions"><button className="button primary compact" disabled={!selected || !!detailError || busy} onClick={() => void perform(() => call("qa.file-info", { requestId: selected!.id, direction }))}>文件与流详情</button><button className="button ghost compact" disabled={!selected || !!detailError || busy} onClick={async () => { if (await confirmAction("导出本地原始正文？文件可能包含敏感信息，且只包含已保存部分。")) void perform(async () => { const data = await call<Data>("qa.body-export", { requestId: selected!.id, direction }); const path = await saveBinaryFile(`${selected!.id}-${direction}.bin`, data.base64); return { path, notice: data.notice }; }); }}>导出原始正文</button></div></div>
      <label><input type="checkbox" checked={Boolean(catalog.streamCapture)} onChange={event => void perform(async () => setCatalog(await call("qa.stream-settings", { sse: event.target.checked, websocket: catalog.websocketCapture })))} /> 为之后的新流保存 SSE 事件（最多500条/256 KiB）</label><br />
      <label><input type="checkbox" checked={Boolean(catalog.websocketCapture)} onChange={event => void perform(async () => setCatalog(await call("qa.stream-settings", { sse: catalog.streamCapture, websocket: event.target.checked })))} /> 为之后的新连接保存 WebSocket 消息（最多500条/256 KiB；分片已由协议层合并）</label>
      <p className="boundary-note">历史未保存的流无法补全；显示结束状态、限额、方向、时间与摘要，不编辑或重发 WebSocket 消息。</p>
    </>}
    {section === "checklist" && <>
      {selection}<div className="qa-actions"><button className="button primary compact" disabled={!selected || !!detailError || busy} onClick={() => void perform(async () => { const result = await call<ConfigItem>("qa.checklist", { requestIds: [selected!.id] }); setChecklist(result); return result; }, true)}>从所选请求生成人工清单</button><Select value={checklist?.id || ""} onChange={event => setChecklist(byKind("qa_checklist").find(item => item.id === event.target.value) || null)}><option value="">打开已保存清单</option>{byKind("qa_checklist").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
      {checklist && <><label className="field"><span>清单名称</span><input value={checklist.name} onChange={event => setChecklist({ ...checklist, name: event.target.value })} /></label>{(checklist.config.items || []).map((item: Data, index: number) => {
        const update = (patch: Data) => setChecklist({ ...checklist, config: { ...checklist.config, items: checklist.config.items.map((value: Data, i: number) => i === index ? { ...value, ...patch } : value) } });
        return <div className="qa-check" key={item.id}><label className="field"><span>操作步骤</span><textarea value={item.step} onChange={event => update({ step: event.target.value })} /></label><label className="field"><span>预期结果</span><textarea value={item.expected} onChange={event => update({ expected: event.target.value })} /></label><div className="form-grid two"><label className="field"><span>结果</span><Select value={item.status} onChange={event => update({ status: event.target.value })}><option value="pending">待验证</option><option value="passed">通过</option><option value="failed">失败</option><option value="investigate">待查</option></Select></label><label className="field"><span>记录与观察</span><input value={item.note} onChange={event => update({ note: event.target.value })} /></label></div><label className="field"><span>证据请求 ID（逗号分隔）</span><input value={(item.requestIds || []).join(",")} onChange={event => update({ requestIds: event.target.value.split(",").map(value => value.trim()).filter(Boolean) })} /></label><div className="qa-actions">{(item.requestIds || []).map((id: string) => <button key={id} className="button ghost compact" onClick={() => onSelectRequest(id)}>查看 {id}</button>)}<button className="button ghost compact" onClick={() => setChecklist({ ...checklist, config: { ...checklist.config, items: checklist.config.items.filter((_: Data, i: number) => i !== index) } })}>移除步骤</button></div></div>;
      })}<div className="qa-actions"><button className="button ghost compact" onClick={() => setChecklist({ ...checklist, config: { ...checklist.config, items: [...checklist.config.items, { id: crypto.randomUUID(), step: "", expected: "", status: "pending", requestIds: [], note: "" }] } })}>增加步骤</button><button className="button primary compact" disabled={busy} onClick={() => void perform(async () => { const saved = await call<ConfigItem>("qa.save", { ...checklist, expectedUpdated: checklist.updatedAt }); setChecklist(saved); return saved; }, true)}>保存验证记录</button><button className="button ghost compact" onClick={() => void perform(() => saveTextFile(`${checklist.name}.json`, json(checklist)))}>导出清单</button></div></>}
    </>}
    {section === "package" && <>
      <label className="field"><span>调查报告</span><Select value={reportId} onChange={event => { setReportId(event.target.value); setPackagePreview(null); }}><option value="">请选择报告</option>{catalog.reports.map((item: Data) => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></label>
      <div className="qa-actions"><button className="button primary compact" disabled={!reportId || busy} onClick={() => void perform(async () => { const result = await call<Data>("qa.package-preview", { reportId }); setPackagePreview(result); return result; })}>生成并预览脱敏证据包</button><button className="button ghost compact" disabled={!packagePreview || busy} onClick={() => void perform(() => saveTextFile("ai-proxy-evidence.json", json(packagePreview)))}>确认保存预览副本</button><button className="button ghost compact" disabled={busy} onClick={() => void perform(async () => { const path = await pickLocalFile(); if (!path) return; return call("qa.package-import", { json: await readTextFile(path) }); }, true)}>导入证据包（只读）</button><button className="button ghost compact" disabled={busy} onClick={() => void perform(() => call("qa.packages"))}>阅读导入的证据包</button></div>
      <p className="boundary-note">保存前请检查预览。包含固定脱敏样本、报告、验证清单和相关动作；缺失、失效与未包含部分会明确标注。</p>
    </>}
    {section === "history" && <><p>重放、工单与调试动作均可在重启后查看。结果未知时先核对真实业务，再创建一个新的预览；此处不会重新发送。</p><button className="button primary compact" disabled={busy} onClick={() => void perform(() => call("qa.operations"))}>查看操作历史</button></>}
    </fieldset>
    {output != null && <><p className="boundary-note">此结果来自：{outputContext}</p><ResultSummary key={section} value={output} onRequest={onSelectRequest} /></>}
  </section>;
}

export function ProjectWorkspace() {
  const [projects, setProjects] = useState<Data>({ active: "", items: [] });
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => setProjects(await call("projects.list"));
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, []);
  return <section className="qa-workspace"><h3>独立项目空间</h3><p>项目隔离抓包、场景、规则、环境、契约、模型会话与连接配置。切换会停止采集和当前 Agent，并等待后台操作收束。</p>{error && <p role="alert">{error}</p>}<label className="field"><span>新项目名称</span><input value={name} onChange={event => setName(event.target.value)} /></label><button className="button primary compact" disabled={!name || busy} onClick={async () => { setBusy(true); try { await call("projects.create", { name }); setName(""); await refresh(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } }}>创建项目</button>{projects.items.map((item: Data) => <div className="qa-step" key={item.id}><b>{item.name}</b><button className="button ghost compact" disabled={busy || item.id === projects.active} onClick={async () => { if (!await confirmAction("切换项目会停止采集与 Agent。系统代理设置请在系统代理入口核对；确认切换？")) return; setBusy(true); try { await call("projects.select", { projectId: item.id }); localStorage.setItem("ai-proxy-active-project", item.id); window.location.reload(); } catch (reason) { setError(String(reason)); setBusy(false); } }}>{item.id === projects.active ? "当前项目" : "切换"}</button></div>)}</section>;
}
