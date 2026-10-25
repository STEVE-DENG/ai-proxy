# 第一轮119项历史复核映射

[返回README](../README.md) · [总复核](checklist-audit.md) · [第二轮](roadmap.md) · [人工验收](validation.md)

2026-10-24逐项核对源码入口，补齐119项对应的函数/界面。此表是源码证据映射，不是119项实机通过记录。历史“沿用现有实现”的泛化表述已改为可追踪入口；发现的目录视图回归已在本轮恢复。用户后续决策优先：本地凭据替代Keychain、默认每请求一行并提供可选目录、外部平台暂缓、真实验收由用户执行。第一轮与第二轮/UX有大量重叠，不累加功能数量。

| 原编号 | 原功能 | 当前源码状态 | 具体源码入口 | 第二轮追踪 |
| --- | --- | --- | --- | --- |
| 1 | 抓包页内嵌 AI 分析面板。 | 源码已有实现；待实机验收 | [CaptureWorkspace.tsx · export function CaptureWorkspace](../src/components/CaptureWorkspace.tsx#L658) | 参照对应模块及 D07 |
| 2 | 抓包页与 AI 工作区状态恢复。 | 源码已有实现；待实机验收 | [App.tsx · ai-proxy-capture-ui:](../src/App.tsx#L232) | B17 |
| 3 | 多选请求并附加到 AI 对话。 | 源码已有实现；待实机验收 | [App.tsx · setScopeChoice"selection")](../src/App.tsx#L1090) | 参照对应模块及 D07 |
| 4 | 按当前筛选结果发起分析。 | 源码已有实现；待实机验收 | [App.tsx · analyzeFromCapture](../src/App.tsx#L1268) | 参照对应模块及 D07 |
| 5 | 固定分析批次、设备和时间范围。 | 源码已有实现；待实机验收 | [domain.py · build_scope](../engine/ai_proxy_engine/domain.py#L123) | A03 |
| 6 | 固定请求版本和分析快照。 | 源码已有实现；待实机验收 | [domain.py · build_scope](../engine/ai_proxy_engine/domain.py#L123) | A04、B11 |
| 7 | 展示分析范围与数据覆盖量。 | 源码已有实现；待实机验收 | [domain.py · build_scope](../engine/ai_proxy_engine/domain.py#L123) | B08 |
| 8 | 扩大范围后创建新一轮分析。 | 源码已有实现；待实机验收 | [App.tsx · analyzeFromCapture](../src/App.tsx#L1268) | 参照对应模块及 D07 |
| 9 | 提示快照之外的新增请求。 | 源码已有实现；待实机验收 | [storage.py · query_requests](../engine/ai_proxy_engine/storage.py#L859) | 参照对应模块及 D07 |
| 10 | 按设备、时间、接口和状态检索请求。 | 源码已有实现；待实机验收 | [domain.py · query](../engine/ai_proxy_engine/domain.py#L236) | 参照对应模块及 D07 |
| 11 | 请求分页查询与加载更多。 | 源码已有实现；待实机验收 | [domain.py · query](../engine/ai_proxy_engine/domain.py#L236) | 参照对应模块及 D07 |
| 12 | 展示匹配总数、已加载数和批次总数。 | 源码已有实现；待实机验收 | [storage.py · query_requests](../engine/ai_proxy_engine/storage.py#L859) | 参照对应模块及 D07 |
| 13 | 按接口、状态和业务错误聚合。 | 源码已有实现；待实机验收 | [domain.py · aggregate](../engine/ai_proxy_engine/domain.py#L771) | B08 |
| 14 | 统计失败率、耗时分位数和样本量。 | 源码已有实现；待实机验收 | [domain.py · aggregate](../engine/ai_proxy_engine/domain.py#L771) | B08 |
| 15 | 按需读取请求与响应 Header。 | 源码已有实现；待实机验收 | [domain.py · read_content](../engine/ai_proxy_engine/domain.py#L610) | B01 |
| 16 | 按需读取 URL、Query 和表单字段。 | 源码已有实现；待实机验收 | [domain.py · read_content](../engine/ai_proxy_engine/domain.py#L610) | B03 |
| 17 | 按 JSON 字段路径读取正文。 | 源码已有实现；待实机验收 | [domain.py · read_content](../engine/ai_proxy_engine/domain.py#L610) | B02 |
| 18 | 正文分段读取与继续读取。 | 源码已有实现；待实机验收 | [domain.py · read_content](../engine/ai_proxy_engine/domain.py#L610) | B01 |
| 19 | 区分正文缺失、采集截断和预览截断。 | 源码已有实现；待实机验收 | [domain.py · read_content](../engine/ai_proxy_engine/domain.py#L610) | B01、B13 |
| 20 | 展示 CONNECT、流式和解码失败状态。 | 源码已有实现；待实机验收 | [CaptureWorkspace.tsx · export function CaptureWorkspace](../src/components/CaptureWorkspace.tsx#L658) | 参照对应模块及 D07 |
| 21 | 统一脱敏工具结果与报告。 | 源码已有实现；待实机验收 | [privacy.py · class Redactor](../engine/ai_proxy_engine/privacy.py#L51) | A05 |
| 22 | 支持稳定脱敏值用于字段比较。 | 源码已有实现；待实机验收 | [privacy.py · class Redactor](../engine/ai_proxy_engine/privacy.py#L51) | 参照对应模块及 D07 |
| 23 | 完整执行 ReAct 工具调用循环。 | 工具循环代码具备；真实Provider待用户验收 | [agent.py · async _run](../engine/ai_proxy_engine/agent.py#L538) | A11 |
| 24 | 流式展示分析进度与回答。 | 源码已有实现；待实机验收 | [agent.py · async _run](../engine/ai_proxy_engine/agent.py#L538) | 参照对应模块及 D07 |
| 25 | 展示工具参数、结果、耗时和错误。 | 源码已有实现；待实机验收 | [agent.py · async _handle_stream_event](../engine/ai_proxy_engine/agent.py#L849) | A07 |
| 26 | 区分工具成功、失败、拒绝、超时和取消。 | 源码已有实现；待实机验收 | [agent.py · async _handle_stream_event](../engine/ai_proxy_engine/agent.py#L849) | A07 |
| 27 | 持久化 Agent 执行事件。 | 源码已有实现；待实机验收 | [storage.py · list_events](../engine/ai_proxy_engine/storage.py#L1550) | 参照对应模块及 D07 |
| 28 | 持久化完整模型消息。 | 源码已有实现；待实机验收 | [agent.py · _checkpoint](../engine/ai_proxy_engine/agent.py#L843) | A06 |
| 29 | 按完整轮次压缩历史上下文。 | 源码已有实现；待实机验收 | [agent.py · _trim_complete_turns](../engine/ai_proxy_engine/agent.py#L1667) | B07 |
| 30 | 重启后查看历史执行过程。 | 源码已有实现；待实机验收 | [AIWorkspace.tsx · function InvestigationTrace](../src/components/AIWorkspace.tsx#L176) | 参照对应模块及 D07 |
| 31 | 中断后保留已有结果与证据。 | 源码已有实现；待实机验收 | [agent.py · _checkpoint](../engine/ai_proxy_engine/agent.py#L843) | A06 |
| 32 | 从中断记录发起继续分析。 | 源码已有实现；待实机验收 | [agent.py · async start_run](../engine/ai_proxy_engine/agent.py#L353) | A06 |
| 33 | 前端重连后补读执行事件。 | 源码已有实现；待实机验收 | [storage.py · list_events](../engine/ai_proxy_engine/storage.py#L1550) | 参照对应模块及 D07 |
| 34 | 限制模型轮次、工具次数和 Token 用量。 | 源码已有实现；待实机验收 | [agent.py · async _run](../engine/ai_proxy_engine/agent.py#L538) | A07、B07 |
| 35 | 设置模型、工具、审批和整体超时。 | 源码已有实现；待实机验收 | [agent.py · async _run](../engine/ai_proxy_engine/agent.py#L538) | 参照对应模块及 D07 |
| 36 | 展示预算耗尽及未检查范围。 | 源码已有实现；待实机验收 | [agent.py · async _run](../engine/ai_proxy_engine/agent.py#L538) | B08 |
| 37 | 停止运行并清理待审批操作。 | 源码已有实现；待实机验收 | [agent.py · stop](../engine/ai_proxy_engine/agent.py#L408) | A07 |
| 38 | 默认只读分析模式。 | 源码已有实现；待实机验收 | [agent.py · _build_agent](../engine/ai_proxy_engine/agent.py#L989) | 参照对应模块及 D07 |
| 39 | 按模式限制后端工具权限。 | 源码已有实现；待实机验收 | [agent.py · async start_run](../engine/ai_proxy_engine/agent.py#L353) | 参照对应模块及 D07 |
| 40 | 校验工具参数与数据访问范围。 | 源码已有实现；待实机验收 | [agent.py · version_matches](../engine/ai_proxy_engine/agent.py#L101) | A03、A08、A10 |
| 41 | 隔离模型调用与业务抓包流量。 | 源码已有实现；待实机验收 | [agent.py · _build_model](../engine/ai_proxy_engine/agent.py#L1586) | 参照对应模块及 D07 |
| 42 | 定位网络、TLS 和 HTTP 错误。 | 源码已有实现；待实机验收 | [proxy.py · _record](../engine/ai_proxy_engine/proxy.py#L406) | 参照对应模块及 D07 |
| 43 | 定位代理规则执行错误。 | 源码已有实现；待实机验收 | [proxy.py · _record](../engine/ai_proxy_engine/proxy.py#L406) | 参照对应模块及 D07 |
| 44 | 对比成功与失败请求。 | 源码已有实现；待实机验收 | [domain.py · compare](../engine/ai_proxy_engine/domain.py#L828) | 参照对应模块及 D07 |
| 45 | 展示 Header、Query 和正文字段差异。 | 源码已有实现；待实机验收 | [domain.py · compare](../engine/ai_proxy_engine/domain.py#L828) | B02、B04 |
| 46 | 配置动态字段忽略规则。 | 源码已有实现；待实机验收 | [domain.py · compare](../engine/ai_proxy_engine/domain.py#L828) | 参照对应模块及 D07 |
| 47 | 分析慢接口与异常耗时。 | 源码已有实现；待实机验收 | [domain.py · aggregate](../engine/ai_proxy_engine/domain.py#L771) | B08、B11 |
| 48 | 配置业务成功码与错误字段。 | 源码已有实现；待实机验收 | [domain.py · business_state](../engine/ai_proxy_engine/domain.py#L561) | 参照对应模块及 D07 |
| 49 | 识别 HTTP 200 中的业务失败。 | 源码已有实现；待实机验收 | [domain.py · business_state](../engine/ai_proxy_engine/domain.py#L561) | 参照对应模块及 D07 |
| 50 | 分开展示事实、候选原因和待验证项。 | 源码已有实现；待实机验收 | [app.py · _generate_report](../engine/ai_proxy_engine/app.py#L915) | B15 |
| 51 | 生成带来源的证据卡片。 | 源码已有实现；待实机验收 | [domain.py · evidence](../engine/ai_proxy_engine/domain.py#L750) | B04 |
| 52 | 从证据跳转到原请求与具体字段。 | 源码已有实现；待实机验收 | [App.tsx · openEvidence](../src/App.tsx#L923) | B04、B05 |
| 53 | 标记已删除或失效的证据。 | 源码已有实现；待实机验收 | [storage.py · get_evidence](../engine/ai_proxy_engine/storage.py#L1697) | B04、B16 |
| 54 | 生成可编辑的缺陷报告。 | 源码已有实现；待实机验收 | [app.py · _generate_report](../engine/ai_proxy_engine/app.py#L915) | 参照对应模块及 D07 |
| 55 | 报告记录环境、范围和数据缺口。 | 源码已有实现；待实机验收 | [app.py · _generate_report](../engine/ai_proxy_engine/app.py#L915) | B15 |
| 56 | 导出 Markdown 和 JSON 报告。 | 源码已有实现；待实机验收 | [app.py · reports.export](../engine/ai_proxy_engine/app.py#L660) | A05、B15 |
| 57 | 采集连接标识与 HTTP 版本。 | 源码已有实现；待实机验收 | [proxy.py · _record](../engine/ai_proxy_engine/proxy.py#L406) | 参照对应模块及 D07 |
| 58 | 分别记录请求开始和完成顺序。 | 源码已有实现；待实机验收 | [proxy.py · _record](../engine/ai_proxy_engine/proxy.py#L406) | 参照对应模块及 D07 |
| 59 | 展示请求进行中状态。 | 源码已有实现；待实机验收 | [CaptureWorkspace.tsx · export function CaptureWorkspace](../src/components/CaptureWorkspace.tsx#L658) | 参照对应模块及 D07 |
| 60 | 展示代理可观测的分阶段耗时。 | 源码已有实现；待实机验收 | [CaptureWorkspace.tsx · export function CaptureWorkspace](../src/components/CaptureWorkspace.tsx#L658) | 参照对应模块及 D07 |
| 61 | 提取并校验 W3C Trace 上下文。 | 源码已有实现；待实机验收 | [domain.py · parse_trace_context](../engine/ai_proxy_engine/domain.py#L50) | 参照对应模块及 D07 |
| 62 | 按有效 Trace ID 分组请求。 | 源码已有实现；待实机验收 | [domain.py · trace_groups](../engine/ai_proxy_engine/domain.py#L931) | 参照对应模块及 D07 |
| 63 | 展示 Agent 自身执行链路。 | 源码已有实现；待实机验收 | [AIWorkspace.tsx · function InvestigationTrace](../src/components/AIWorkspace.tsx#L176) | 参照对应模块及 D07 |
| 64 | 展示已观测请求时间线。 | 源码已有实现；待实机验收 | [CaptureWorkspace.tsx · TIMELINE](../src/components/CaptureWorkspace.tsx#L1323) | 参照对应模块及 D07 |
| 65 | 展示链路关联依据与可见边界。 | 源码已有实现；待实机验收 | [domain.py · relations](../engine/ai_proxy_engine/domain.py#L950) | B10、D04 |
| 66 | 按协议、域名和端口组织结构树。 | 源码已有实现；待实机验收 | [domain.py · _directory_nodes](../engine/ai_proxy_engine/domain.py#L451) | A01 |
| 67 | 按 URL 目录逐级展示请求。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [domain.py · _directory_nodes](../engine/ai_proxy_engine/domain.py#L451) | A01 |
| 68 | 合并单子节点目录。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [domain.py · _directory_nodes](../engine/ai_proxy_engine/domain.py#L451) | A01 |
| 69 | 按方法和路径组织请求组。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [domain.py · _directory_nodes](../engine/ai_proxy_engine/domain.py#L451) | A01 |
| 70 | 默认折叠重复请求实例。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [domain.py · _directory_nodes](../engine/ai_proxy_engine/domain.py#L451) | A01 |
| 71 | 展示请求组数量、失败数和最近状态。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [domain.py · _directory_nodes](../engine/ai_proxy_engine/domain.py#L451) | A01、B08 |
| 72 | 保留每次请求的独立记录。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [storage.py · save_request](../engine/ai_proxy_engine/storage.py#L648) | 参照对应模块及 D07 |
| 73 | 支持关注域名与 Other Hosts 分组。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [DirectoryTree.tsx · export function DirectoryTree](../src/components/DirectoryTree.tsx#L17) | A01 |
| 74 | 支持结构视图与时序视图切换。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [CaptureWorkspace.tsx · TIMELINE](../src/components/CaptureWorkspace.tsx#L1323) | A01 |
| 75 | 支持全部收起和按层级展开。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [DirectoryTree.tsx · export function DirectoryTree](../src/components/DirectoryTree.tsx#L17) | A01、B09 |
| 76 | 保存展开状态、选中项和滚动位置。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [App.tsx · ai-proxy-capture-ui:](../src/App.tsx#L232) | B17 |
| 77 | 搜索时临时展开匹配路径。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [DirectoryTree.tsx · export function DirectoryTree](../src/components/DirectoryTree.tsx#L17) | A01、B09 |
| 78 | 证据跳转时自动定位目标实例。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [App.tsx · openEvidence](../src/App.tsx#L923) | B05 |
| 79 | 新请求到来时保持用户折叠状态。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [App.tsx · ai-proxy-capture-ui:](../src/App.tsx#L232) | B17 |
| 80 | 树节点按需加载与列表虚拟化。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [DirectoryTree.tsx · export function DirectoryTree](../src/components/DirectoryTree.tsx#L17) | A01、B09 |
| 81 | 统一实时请求和历史请求的筛选规则。 | 源码已有实现；待实机验收 | [domain.py · query](../engine/ai_proxy_engine/domain.py#L236) | A01 |
| 82 | 提供树与列表键盘导航。 | 本轮恢复可选目录入口；默认仍逐条请求，待实机验收 | [DirectoryTree.tsx · export function DirectoryTree](../src/components/DirectoryTree.tsx#L17) | B18 |
| 83 | 支持窄窗口 AI 抽屉。 | 源码已有实现；待实机验收 | [CaptureWorkspace.tsx · export function CaptureWorkspace](../src/components/CaptureWorkspace.tsx#L658) | 参照对应模块及 D07 |
| 84 | 创建、命名和结束 QA 场景。 | 源码已有实现；待实机验收 | [storage.py · start_scenario](../engine/ai_proxy_engine/storage.py#L1809) | 参照对应模块及 D07 |
| 85 | 场景内人工添加与排除请求。 | 源码已有实现；待实机验收 | [storage.py · set_scenario_request](../engine/ai_proxy_engine/storage.py#L1853) | 参照对应模块及 D07 |
| 86 | 配置业务关联字段与匹配规则。 | 源码已有实现；待实机验收 | [domain.py · relations](../engine/ai_proxy_engine/domain.py#L950) | B10 |
| 87 | 展示跳转、重试和时间邻近候选。 | 源码已有实现；待实机验收 | [domain.py · relations](../engine/ai_proxy_engine/domain.py#L950) | B10 |
| 88 | 区分明确关联、候选关联和人工归组。 | 源码已有实现；待实机验收 | [domain.py · relations](../engine/ai_proxy_engine/domain.py#L950) | 参照对应模块及 D07 |
| 89 | 识别重复提交、轮询和重试模式。 | 源码已有实现；待实机验收 | [domain.py · duplicate_patterns](../engine/ai_proxy_engine/domain.py#L1313) | C04、C09 |
| 90 | 对比成功与失败场景。 | 源码已有实现；待实机验收 | [qa.py · pair](../engine/ai_proxy_engine/qa.py#L56) | C09 |
| 91 | 展示跨场景样本配对结果。 | 源码已有实现；待实机验收 | [qa.py · pair](../engine/ai_proxy_engine/qa.py#L56) | C09 |
| 92 | 配置项目环境、App 版本和构建信息。 | 源码已有实现；待实机验收 | [WorkbenchDialog.tsx · export function WorkbenchDialog](../src/components/WorkbenchDialog.tsx#L97) | B11、C10 |
| 93 | 保存项目业务规则与常用筛选。 | 源码已有实现；待实机验收 | [WorkbenchDialog.tsx · export function WorkbenchDialog](../src/components/WorkbenchDialog.tsx#L97) | C10 |
| 94 | 生成 Mock 与 Rewrite 变更预览。 | 源码已有实现；待实机验收 | [domain.py · preview_debug_action](../engine/ai_proxy_engine/domain.py#L1857) | 参照对应模块及 D07 |
| 95 | 展示调试操作影响范围与配置差异。 | 源码已有实现；待实机验收 | [domain.py · preview_debug_action](../engine/ai_proxy_engine/domain.py#L1857) | B12 |
| 96 | 将审批绑定到具体变更版本。 | 源码已有实现；待实机验收 | [domain.py · assert_action_owner](../engine/ai_proxy_engine/domain.py#L2037) | A10 |
| 97 | 保存规则、弱网和操作版本记录。 | 源码已有实现；待实机验收 | [storage.py · save_debug_action](../engine/ai_proxy_engine/storage.py#L2041) | A09、B11 |
| 98 | 保存规则命中及修改前后证据。 | 源码已有实现；待实机验收 | [proxy.py · _record](../engine/ai_proxy_engine/proxy.py#L406) | B11 |
| 99 | 修改后通过新增抓包验证效果。 | 源码已有实现；待实机验收 | [domain.py · verify_debug_action](../engine/ai_proxy_engine/domain.py#L2041) | B12 |
| 100 | 恢复指定调试操作并检查配置冲突。 | 源码已有实现；待实机验收 | [domain.py · restore_debug_action](../engine/ai_proxy_engine/domain.py#L1982) | A09 |
| 101 | 防止写操作重复执行。 | 源码已有实现；待实机验收 | [storage.py · claim_replay_action](../engine/ai_proxy_engine/storage.py#L2259) | A10 |
| 102 | 提供弱网场景预设与恢复入口。 | 源码已有实现；待实机验收 | [Dialogs.tsx · export function ThrottleDialog](../src/components/Dialogs.tsx#L304) | 参照对应模块及 D07 |
| 103 | 生成人工测试点与验证清单。 | 源码已有实现；待实机验收 | [qa.py · checklist](../engine/ai_proxy_engine/qa.py#L112) | 参照对应模块及 D07 |
| 104 | 后台处理聚合、正文解析和关联计算。 | 源码已有实现；待实机验收 | [app.py · asyncio.to_thread](../engine/ai_proxy_engine/app.py#L165) | B01、B09 |
| 105 | 展示采集背压与记录丢失情况。 | 源码已有实现；待实机验收 | [proxy.py · _record_worker](../engine/ai_proxy_engine/proxy.py#L72) | B09 |
| 106 | 支持数据库版本迁移。 | 源码已有实现；待实机验收 | [storage.py · _initialize_with_recovery](../engine/ai_proxy_engine/storage.py#L84) | A02 |
| 107 | 清理抓包时处理关联报告与证据。 | 源码已有实现；待实机验收 | [storage.py · clear_batch](../engine/ai_proxy_engine/storage.py#L577) | A12 |
| 108 | 清空全部数据时覆盖新增持久记录。 | 源码已有实现；待实机验收 | [storage.py · clear_all](../engine/ai_proxy_engine/storage.py#L2335) | B16 |
| 109 | 导入指定格式的服务端 Trace（后续）。 | 源码已有实现；待实机验收 | [domain.py · import_otlp](../engine/ai_proxy_engine/domain.py#L1777) | 参照对应模块及 D07 |
| 110 | 关联抓包请求与服务端 Span（后续）。 | 源码已有实现；待实机验收 | [domain.py · waterfall](../engine/ai_proxy_engine/domain.py#L1114) | D04 |
| 111 | 展示跨服务瀑布和异步关联（后续）。 | 源码已有实现；待实机验收 | [domain.py · waterfall](../engine/ai_proxy_engine/domain.py#L1114) | D04 |
| 112 | 展示采样、时钟偏差和链路缺口（后续）。 | 源码已有实现；待实机验收 | [domain.py · waterfall](../engine/ai_proxy_engine/domain.py#L1114) | D04 |
| 113 | 接入实际使用的观测平台只读查询（后续）。 | 外部平台按用户决定暂缓；本地骨架不算完成 | [domain.py · query_observability](../engine/ai_proxy_engine/domain.py#L2152) | D03 |
| 114 | 导入 OpenAPI 并校验接口契约（后续）。 | 源码已有实现；待实机验收 | [domain.py · validate_openapi](../engine/ai_proxy_engine/domain.py#L1557) | B14 |
| 115 | 按接口规范聚合路径模板（后续）。 | 源码已有实现；待实机验收 | [domain.py · validate_openapi](../engine/ai_proxy_engine/domain.py#L1557) | B14 |
| 116 | 导入和导出 HAR（后续）。 | 源码已有实现；待实机验收 | [domain.py · import_har](../engine/ai_proxy_engine/domain.py#L1343) | B13 |
| 117 | 接入受限 MCP 工具（后续）。 | 外部平台按用户决定暂缓；本地骨架不算完成 | [domain.py · call_mcp_tool](../engine/ai_proxy_engine/domain.py#L2177) | D01、D02 |
| 118 | 预览确认后创建外部工单（后续）。 | 本地预览具备；真实缺陷平台暂缓 | [domain.py · create_ticket](../engine/ai_proxy_engine/domain.py#L2219) | A10、D05 |
| 119 | 主动请求重放与发送结果追踪（后续）。 | 源码已有实现；待实机验收 | [domain.py · replay](../engine/ai_proxy_engine/domain.py#L2148) | C01、D06 |
