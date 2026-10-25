import { version } from "../../package.json";
import { Select } from "./Select";
import { useState } from "react";
import { Dialog } from "./Dialogs";
import { setDensity, setTextScale, textScale, useTheme, type Theme } from "../lib/display";
import { call } from "../lib/api";

export const FEATURE_HELP = [
  { name: "上下文与压缩", keywords: "context compress 上下文 Token 历史 new stop help", steps: "输入 / 搜索本地命令，方向键选择、Tab或Enter填入，再发送。/compress（别名/compact）压缩、/new新会话、/help帮助、/stop停止、/context上下文、/sessions会话、/models模型。普通斜杠文本用 // 开头。上下文面板可计算包含输入/指令/工具/范围的完整估算，不调用模型。", impact: "完整估算仍采用UTF-8字节启发式，协议开销未知；模型窗口须自行配置核实，未知时不显示比例。压缩保留完整轮次和固定摘要，原记录保留，可能损失旧细节。", route: "ai" },
  { name: "Compose与高级重复", keywords: "compose new repeat 并发 间隔 直连 代理 弱网", steps: "工作台→QA→编辑重放，从空白或所选抓包载入，选择链路与次数/并发/间隔/总时限。预览后核对整组再确认发送；结果区可停止、核对状态和打开新抓包。", impact: "次数1–20、并发1–3、间隔0–10000ms、总时限5–60秒；HTTPS代理链路需先开启目标Host解密。失败/未知停止派发，已发送不可撤销，不自动重试。", route: "qa:replay" },
  { name: "Agent抓包调试工具", keywords: "shell compose repeat 手机 自动代理 弱网 tools", steps: "切到调试模式，描述代理管理、手机接入、Compose编辑或Repeat次数。核对工具预览并批准；Shell逐条核对命令。", impact: "新代理/Shell/设备/批量发送工具始终人工批准，自动执行模式也不跳过。Shell20秒/64KiB，本机用户权限且非沙箱；手机设置和证书信任仍需人工操作。", route: "ai" },
  { name: "目录折叠与逐条请求", keywords: "Path Charles 目录 树 一行", steps: "抓包左栏默认结构视图每个请求一行；切到目录折叠可逐层展开Host/目录/方法路径，保留每次实例。关注Host后其余地址进入其他Host分组。", impact: "每层200节点/请求分页、虚拟滚动，搜索临时展开最多200节点，清除搜索恢复折叠；不合并或删除采集记录。", route: "capture" },
  { name: "连接手机", keywords: "iPhone Android 局域网 Wi-Fi 证书 CA", steps: "开启局域网 HTTP 代理 → 手机扫码并设置手动代理 → Mac 允许来源地址，在手机验证 HTTP；HTTPS 按需安装信任 CA 后单独验证。", impact: "只抓手机无需挂载 Mac 系统代理。结束后关闭手机 Wi-Fi 代理。", route: "phone" },
  { name: "抓本机", keywords: "系统代理 开始 停止 暂停", steps: "开始抓包 → 设置中挂到本机（或仅让指定应用手动使用代理）→ 发起请求并在抓包页查看。", impact: "挂到本机会修改系统代理并请求管理员授权；暂停只停止记录，停止监听后需核对恢复结果。", route: "local" },
  { name: "导入与离线体验", keywords: "HAR OpenAPI OTLP 示例", steps: "导入与互操作 → 导入 HAR → 切换新批次，筛选并查看详情。无需开启代理或配置模型。", impact: "导入只处理本地数据；原始 HAR 可能含隐私。OpenAPI 和 OTLP JSON 支持范围见页面说明。", route: "imports" },
  { name: "筛选、请求列表与时序", keywords: "搜索 状态 method Host 设备 时间 空列表", steps: "选择批次 → 搜索或组合筛选 → 展开 Host 查看逐条请求或切换时序；点请求查看正文与关联。", impact: "每个请求一行，路径包含查询串。每Host分页；筛选改变可见集合，没有匹配不代表没有采集。", route: "capture" },
  { name: "存储健康检查", keywords: "数据库 保存失败 磁盘 权限 persist loading", steps: "设置 → 存储 → 检查存储健康，核对磁盘余量、目录读写、数据库与最近采集保存。恢复目录或空间后重新检查。", impact: "只读数据库，独立临时文件验证写入；不会删库修复，也无法恢复已丢失响应。", route: "storage" },
  { name: "超时与HTTP/2", keywords: "一直等待 loading 慢请求 SSE WebSocket", steps: "设置 → 抓包 → 分别填写请求总时限和流空闲时限并保存。修改HTTP/2前先停止代理。", impact: "超时值用于新请求；共享HTTP/2连接关闭可能影响并行请求，关闭HTTP/2会改变协商协议。", route: "local" },
  { name: "任务与等待", keywords: "超时 重试 取消 回执未知", steps: "展开底部任务与等待，查看开始时间、已等待时间和回执时限。读取失败回原功能重试；写结果未知先查看操作历史。", impact: "关闭面板不会取消后台；只有原功能支持取消时才可停止。不会自动重复发送写操作。", route: "qa:history" },
  { name: "缓存与耗时比较", keywords: "性能 缓存 Token 首输出 对比", steps: "执行记录 → 选择2–10条已有Run → 读取并比较，核对模型、端点、样本版本和规则条件，再看单次用量。", impact: "仅读已有数据，不调用模型；缺失指标保留未知，不估算无来源费用。", route: "runs" },
  { name: "AI 调查", keywords: "Agent 模型 scope 只读 缓存 证据", steps: "设置供应商 → 选择请求、筛选范围或场景 → 描述目标并发送。查看事实/候选/待查和证据，点证据回到请求。", impact: "脱敏后的上下文会发给所选供应商并可能收费。默认只读；停止保留证据，写结果未知时先查历史。", route: "ai" },
  { name: "供应商与密钥", keywords: "Provider API Key 密码 本地 auth", steps: "设置 → 添加供应商，填写协议、地址、模型与 Key → 保存；按需主动检查连接。编辑时留空保留已有 Key；展开账户与密钥详情，主动显示/隐藏已保存密钥，30秒或切出窗口自动隐藏。", impact: "密钥保存在本地凭据文件，未加密且仅当前用户可读写；重启无需钥匙串授权。旧 Keychain Key 请重新输入一次。", route: "settings" },
  { name: "Map Local / Remote 与 Rewrite", keywords: "规则 mock 重定向 改写", steps: "规则页新增匹配规则 → 选择本地响应、远端映射或请求/响应字段改写 → 启用后发新请求，查看命中证据。", impact: "影响所有经过代理的匹配流量；结束后禁用规则，历史请求不会自动改写。", route: "rules" },
  { name: "弱网", keywords: "限速 延迟 网络", steps: "打开弱网 → 选择预设或填写上行/下行/延迟 → 应用并发起新请求。", impact: "只影响经过本代理的流量，带宽共享；结束后关闭弱网。", route: "throttle" },
  { name: "场景与关联", keywords: "步骤 trace 瀑布图 因果", steps: "抓包页开始场景 → 操作目标 App → 结束场景；查看关联和瀑布图，并核对关联依据。", impact: "时间相邻不是因果证明；Trace 采样和缺失 Span 会明确留下缺口。", route: "capture" },
  { name: "聚合、对比与字段证据", keywords: "P95 失败率 JSON Pointer diff", steps: "选定筛选范围进行聚合，或选择两条请求对比 → 展开差异/字段 → 定位证据来源。", impact: "缺失、截断正文不等于字段不存在；版本变化后需重新分析。", route: "capture" },
  { name: "编辑重放", keywords: "replay 请求 发送", steps: "先选请求 → QA 工作台编辑 URL/Header/正文 → 预览目标与差异，再确认发送。", impact: "会真实请求服务并可能产生订单等副作用；超时或未知先核对操作历史。", route: "qa:replay" },
  { name: "步骤复现", keywords: "recipe 变量 提取", steps: "保存多个步骤 → 设置提取与后续变量 → 预览逐步执行，失败后检查已执行步骤。", impact: "步骤可写真实业务；缺变量/缺来源时先修复，不能盲目整段重跑。", route: "qa:scenario" },
  { name: "基线回归", keywords: "配对 业务键", steps: "先保存成功场景为基线 → 选择候选场景与业务键/步骤映射 → 阅读配对、未配对与字段变化。", impact: "证据不足、未配对和未覆盖应单独检查，不能作为全部通过。", route: "qa:baseline" },
  { name: "故障矩阵", keywords: "空值 错误码 延迟", steps: "选请求创建故障用例 → 预览规则影响 → 应用后手动操作目标 App，再核对命中与恢复。", impact: "会修改代理行为；预览没有执行，结束后恢复原配置。", route: "qa:matrix" },
  { name: "鉴权诊断", keywords: "401 Token Cookie", steps: "选择请求 → 鉴权诊断 → 查看 Token/Header/Cookie 线索和缺口。", impact: "本地只读分析不会主动刷新 Token 或修复账户；不要把明文凭据放进报告。", route: "qa:auth" },
  { name: "文件与流", keywords: "SSE WebSocket 上传 下载", steps: "采集前按需开启流记录 → 重新操作目标 App → 查看文件/事件/分帧及保存状态。", impact: "存在体积/帧数上限；历史未保存内容无法补造，需补采。", route: "qa:files" },
  { name: "人工验证", keywords: "checklist 通过 失败 待查", steps: "从选定样本生成清单 → 编辑步骤和预期 → 手动执行并记录状态与证据，保存或导出。", impact: "生成清单不等于验证已通过；结果需人工填写。", route: "qa:checklist" },
  { name: "证据交接与报告", keywords: "脱敏 导出 缺陷", steps: "从 Run 生成报告草稿 → 核对事实/限制与脱敏预览 → 保存报告或证据包，接收方只读导入。", impact: "脱敏不保证清除所有自由文本隐私；预览后再分享。凭据文件不包含在证据包中。", route: "qa:package" },
  { name: "操作历史", keywords: "结果未知 重试 恢复", steps: "QA 操作历史或执行记录 → 按时间核对重放/配置变更结果 → 必要时恢复或创建新预览。", impact: "查看历史不会重新发送；未知写结果先核对真实业务。", route: "qa:history" },
  { name: "项目与数据清理", keywords: "切换 重置 隔离", steps: "项目入口创建/切换 → 核对当前项目与 CA → 存储页按范围清理。", impact: "切换会停止采集和 Agent；清理保留账户凭据，导出文件/备份/设备 CA 需分别处理。", route: "projects" },
  { name: "环境、业务规则与关联规则", keywords: "变量 错误码 业务成功", steps: "工作台选择对应配置 → 编辑并保存/启用 → 在新请求或新分析中核对规则命中。", impact: "配置变化会影响证据版本与分析范围；旧范围需重新创建。", route: "environments" },
  { name: "现有 MCP / 平台 / 工单入口", keywords: "集成 HTTP Trace GET Webhook", steps: "工作台打开集成入口 → 核对端点和允许的工具/报告 → 显式预览或调用，再检查返回证据。", impact: "目前是有限 HTTP 工具调用、Trace GET 与 Webhook，不是完整标准 MCP 客户端；本轮不接入新平台。写入外部平台前需确认。", route: "integrations" },
  { name: "业务成功判定", keywords: "错误码 JSON Pointer success", steps: "工作台业务规则 → 设置成功状态码和错误字段/值 → 新分析中核对命中依据。", impact: "HTTP 200 不一定是业务成功；配置变化后旧 Scope 需要重建。", route: "business" },
  { name: "关联与动态字段", keywords: "Trace 业务键 忽略字段", steps: "工作台关联与动态字段 → 配置关联键或对比忽略项 → 查看命中依据与对比结果。", impact: "关联规则只提供线索；忽略动态字段可能掩盖业务变化，请核对范围。", route: "associations" },
  { name: "调试操作与恢复", keywords: "预览 版本 恢复", steps: "工作台调试与重放 → 核对预览和配置版本 → 执行后用新请求验证，再按需恢复。", impact: "配置已变化时需要重新预览；停止 Agent 不会撤销已经生效的修改。", route: "debug" },
  { name: "预算、缓存与执行记录", keywords: "耗时 Token 压缩 停止", steps: "执行记录设置步骤/工具/时间/Token 预算 → 发起分析 → 查看阶段、单次用量与上下文移出提示。", impact: "供应商未报告的缓存用量显示未知；本地工具缓存与供应商缓存不同，不保证固定命中率。", route: "runs" },
];

export function HelpDialog({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (route: string) => void }) {
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [scale, setScale] = useState(textScale);
  const [density, updateDensity] = useState(() => localStorage.getItem("ai-proxy-density") || "comfortable");
  const [cache, setCache] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState("");
  const matches = FEATURE_HELP.filter(item => `${item.name} ${item.keywords} ${item.steps}`.toLowerCase().includes(query.toLowerCase()));
  return <Dialog open={open} title="开始使用与功能帮助" wide onClose={onClose}>
    <div className="help-start">{[["phone", "连接手机"], ["local", "抓本机"], ["imports", "离线导入数据"]].map(([route, name]) => <button key={route} className="button primary" onClick={() => onNavigate(route)}>{name}</button>)}</div>
    <p>抓包无需配置 AI。窗口顶栏空白和品牌可拖动；面板分隔条可拖动、方向键微调，双击恢复。</p>
    <div className="display-settings"><label>外观 <Select aria-label="外观" value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></Select></label><label>文字大小 <Select value={scale} onChange={event => { const next = Number(event.target.value); setTextScale(next); setScale(next); }}>{[1, 1.25, 1.5, 1.75, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}</Select></label><label>显示密度 <Select value={density} onChange={event => { setDensity(event.target.value); updateDensity(event.target.value); }}><option value="comfortable">舒适</option><option value="compact">紧凑</option></Select></label><button className="button ghost compact" onClick={() => { setTheme("system"); setTextScale(1); setScale(1); setDensity("comfortable"); updateDensity("comfortable"); }}>恢复默认显示</button></div>
    <label className="field"><span>搜索功能 / 操作</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="例如：手机连不上、Key、缓存、重放" /></label>
    {!matches.length && <p>没有匹配说明。试试功能名称，或清空搜索查看全部。</p>}
    <div className="help-topics">{matches.map(item => <details key={item.name} open={query ? true : undefined}><summary>{item.name}</summary><p>{item.steps}</p><p className="boundary-note">{item.impact}</p><button className="button ghost compact" onClick={() => onNavigate(item.route)}>打开{item.name}</button></details>)}</div>
    <details><summary>本地只读工具缓存</summary><p>只缓存固定范围内成功的读取，最多128项/8 MiB，有效期2分钟；清理不会删除调查证据或影响供应商缓存。</p><div className="qa-actions"><button className="button ghost compact" onClick={() => void call<Record<string, number>>("agent.cache-status").then(setCache).catch(reason => setError(String(reason)))}>查看用量</button><button className="button ghost compact" onClick={() => void call<Record<string, number>>("agent.cache-clear").then(setCache).catch(reason => setError(String(reason)))}>清理本地工具缓存</button></div>{cache && <p>条目 {cache.entries} · 大小 {cache.bytes} 字节 · 命中 {cache.hits} · 未命中 {cache.misses}</p>}{error && <p role="alert">{error}</p>}</details>
    <p className="small">AI Proxy {version} · 开发预览 · 本地工作区</p>
    <p>快捷键：⌘/Ctrl + / 打开帮助；输入区 Enter 发送，Shift + Enter 换行，中文输入法确认不会误发送。Tab 导航，弹窗 Esc 返回。</p>
  </Dialog>;
}
