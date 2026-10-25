# 历史清单总复核与本轮补齐

用户随后指出原问题仍未完成：此前错误归档的三份TODO已恢复，当前以[未完成事项总表](/Users/dengxurui/Documents/日常/开源项目/ai_proxy/todo/todo 未完成事项总表.md)及原TODO为待办入口。下述源码交付记录不代表问题已经解决或任务已经关闭；未确认项继续保留，不能全部归类为仅待人工验收。

后续二次复核的18项补修已补齐源码，异步/异常边界以[本轮交付](improvement-status.md)为准；各历史条目继续保留人工验收。

[第一轮119项逐条源码](first-round-status.md) · [第二轮49项](roadmap.md) · [UX01–60](ux-status.md) · [验收记录](validation.md)

核对范围：第一轮119项、第二轮49项、原UX48项及扩展UX60项，另含用户本轮明确批准的《todo 问题修复.md》8条。原UX48是UX60的子集，各轮有重叠，不把228个历史编号说成228套功能。

结论：历史计数不能证明产品完成。此次找到并补回目录视图入口回归、修正单子目录合并、搜索临时展开与深分页定位；修复进行中样本造成快照频繁失效、异步Scope更新污染当前会话、引用在快照外时仍读取摘要；新增8条均已有源码入口。所有条目继续保留真实环境验收状态。

保持用户已定边界：不接新平台；单Agent开发；不创建/运行测试套件；不启动应用、代理或调用真实Provider；不读旧Keychain/实际凭据；不自动提交推送。密钥仍为0700/0600本地明文文件，本轮仅增加用户主动查看；平台条目D01/D02/D03/D05暂缓，A11/D07/UX48实机待用户执行。

本轮新增工具：`get_phone_connection_status`、`compose_request`、`execute_composed_requests`、`manage_capture_proxy`、`prepare_phone_connection`、`authorize_proxy_address`、`run_local_shell`，沿用已有弱网/规则预览与恢复工具。Shell/代理/手机准备/许可/批量发送始终逐次人工批准，自动执行开关也不跳过；Shell是本机用户权限，工作目录不是沙箱，20秒/64KiB上限，只清理当前进程组，脱离组的后台程序不能保证收束。手机Wi-Fi代理、证书安装信任不可能由Mac工具代用户完成。此表初次复核时Compose/Repeat仅支持既有样本及10次顺序发送；后续RF43–45已扩展为空白/来源请求、直连/代理和最多20次/并发3/整组60秒，详见[RF交付对照](problem-fixes-status.md)。发送结果未知不自动重试。外部写操作不能保证撤销。

上下文估算采用序列化UTF-8字节数的保守估算，只覆盖历史，不含下条输入/系统指令/工具定义；不是供应商的精确Token或模型上下文窗口。手动压缩不请求模型，保留最近至多2个完整轮次及固定摘要，旧原始Run/消息不改写；下一轮的历史预算可在面板调整。

后续用户批准的RF01–RF56已补齐原问题恢复、结构化错误、输入估算、本地命令、完整历史和分层连接证据等缺口；本表为历史基础入口，当前细分实现与待验收以[RF清单](problem-fixes-status.md)为准。

## 本轮8条

| ID | 改进结果及边界 | 状态 | 源码入口 |
| --- | --- | --- | --- |
| FIX01 | 进行中请求不冻结进快照；手选样本有进行中则明确拒绝，筛选/场景显示排除数；旧快照失败可按原条件创建新Run | 源码已实现；待实机验收 | [domain.py · build_scope](../engine/ai_proxy_engine/domain.py#L123) |
| FIX02 | 上下文显示与项目级预算设置；显示保守历史估算、消息数及下一轮保留量 | 源码已实现；待实机验收 | [AgentContextPanel.tsx · export function AgentContextPanel](../src/components/AgentContextPanel.tsx#L14) |
| FIX03 | /compress 本地完整轮次压缩；/new、/help、/stop；历史原Run与证据保留 | 源码已实现；待实机验收 | [agent.py · compress_context](../engine/ai_proxy_engine/agent.py#L318) |
| FIX04 | 保存账户详情、新输入显隐、主动展开已存Key；30秒/切出窗口隐藏，不进入模型上下文 | 源码已实现；待实机验收 | [Dialogs.tsx · revealSavedKey](../src/components/Dialogs.tsx#L517) |
| FIX05 | 默认每请求一行；可选目录折叠、单子目录合并、方法组/重复实例、搜索/分页/定位 | 源码已实现；待实机验收 | [DirectoryTree.tsx · export function DirectoryTree](../src/components/DirectoryTree.tsx#L17) |
| FIX06 | Agent弱网及恢复、代理管理、Compose/Repeat、逐条批准Shell、手机接入及来源IP授权/诊断 | 源码已实现；待实机验收 | [agent.py · async manage_capture_proxy](../engine/ai_proxy_engine/agent.py#L1439) |
| FIX07 | 主界面设备地址/待授权/许可/最近活动、允许/记住/撤销；明确IP非设备身份 | 源码已实现；待实机验收 | [DeviceStatusBar.tsx · export function DeviceStatusBar](../src/components/DeviceStatusBar.tsx#L5) |
| FIX08 | 压缩会话标题、去掉技术副标题、分析记录/报告默认折叠，保留历史入口 | 源码已实现；待实机验收 | [AIWorkspace.tsx · <details className="run-history">](../src/components/AIWorkspace.tsx#L397) |

## 第一轮119项

119项独立行和具体函数链接见[第一轮最新对照](first-round-status.md)。113、117及118的真实平台部分按后续用户决定暂缓；23的真实模型执行仍待验收。67–80等目录项本轮恢复为可选入口，与UX50的默认逐条列表同时保留。

## 第二轮49项逐条源码入口

下表43条为源码具备，2条为真实环境验收，4条外部接入暂缓；旧记录中的局部核查不等于当前包全部实机验收。B09还需真实持续采集性能，B17/B18还需重启、键盘和窄窗实机操作。

| ID | 原功能 | 跟踪状态 | 本轮核对的入口 |
| --- | --- | --- | --- |
| A01 | 统一树查询参数与错误反馈 | 代码已落地；验收见右栏 | [domain.py · tree](../engine/ai_proxy_engine/domain.py#L274) |
| A02 | 修复旧库迁移顺序与恢复 | 代码已落地；验收见右栏 | [storage.py · _initialize_with_recovery](../engine/ai_proxy_engine/storage.py#L84) |
| A03 | 固定 Scope 类型与空范围行为 | 代码已落地；验收见右栏 | [domain.py · build_scope](../engine/ai_proxy_engine/domain.py#L123) |
| A04 | 全工具统一快照/版本校验 | 代码已落地；验收见右栏 | [domain.py · validate_scope](../engine/ai_proxy_engine/domain.py#L266) |
| A05 | 修复结构化脱敏出口绕过 | 代码已落地；验收见右栏 | [privacy.py · class Redactor](../engine/ai_proxy_engine/privacy.py#L51) |
| A06 | 持久化中断前模型 checkpoint | 代码已落地；验收见右栏 | [agent.py · _checkpoint](../engine/ai_proxy_engine/agent.py#L843) |
| A07 | 收束工具状态、超时与 Usage | 代码已落地；验收见右栏 | [agent.py · async _handle_stream_event](../engine/ai_proxy_engine/agent.py#L849) |
| A08 | 恢复 Map Local 会话文件授权约束 | 代码已落地；验收见右栏 | [domain.py · validate_shared_file](../engine/ai_proxy_engine/domain.py#L2023) |
| A09 | 修复弱网应用/恢复的状态与 Hash | 代码已落地；验收见右栏 | [domain.py · restore_debug_action](../engine/ai_proxy_engine/domain.py#L1982) |
| A10 | 绑定审批、动作所有权和发送对象 | 代码已落地；验收见右栏 | [domain.py · assert_action_owner](../engine/ai_proxy_engine/domain.py#L2037) |
| A11 | 完成真实 Provider 的人工工具循环验收 | 待真实环境验收 | [agent.py · async _run](../engine/ai_proxy_engine/agent.py#L538) |
| A12 | 协调运行中清理与后台采集 | 代码已落地；验收见右栏 | [app.py · async _quiesce](../engine/ai_proxy_engine/app.py#L160) |
| B01 | 真正按需读取正文与统一分段视图 | 代码已落地；验收见右栏 | [domain.py · read_content](../engine/ai_proxy_engine/domain.py#L610) |
| B02 | 完整 JSON Pointer 与路径状态 | 代码已落地；验收见右栏 | [domain.py · _json_pointer](../engine/ai_proxy_engine/domain.py#L71) |
| B03 | URL/Query/表单/multipart 字段工具 | 代码已落地；验收见右栏 | [domain.py · read_content](../engine/ai_proxy_engine/domain.py#L610) |
| B04 | 统一证据 locator 与版本跳转 | 代码已落地；验收见右栏 | [domain.py · evidence](../engine/ai_proxy_engine/domain.py#L750) |
| B05 | 按 ID 找到未加载实例并滚动 | 代码已落地；验收见右栏 | [DirectoryTree.tsx · targetPath:](../src/components/DirectoryTree.tsx#L47) |
| B06 | 修复历史 Run 选择与续查目标 | 代码已落地；验收见右栏 | [App.tsx · hydrateRun](../src/App.tsx#L490) |
| B07 | 按完整轮次与 Token 预算压缩历史 | 代码已落地；验收见右栏 | [agent.py · _trim_complete_turns](../engine/ai_proxy_engine/agent.py#L1667) |
| B08 | 统一业务失败率、最新状态与覆盖口径 | 代码已落地；验收见右栏 | [domain.py · aggregate](../engine/ai_proxy_engine/domain.py#L771) |
| B09 | SQL 计数/树索引/可取消后台作业 | 代码已落地；验收见右栏 | [storage.py · tree_summary:](../engine/ai_proxy_engine/storage.py#L884) |
| B10 | 带类型、约束和规模预算的关系计算 | 代码已落地；验收见右栏 | [domain.py · relations](../engine/ai_proxy_engine/domain.py#L950) |
| B11 | 保存捕获时配置与有限规则变更证据 | 代码已落地；验收见右栏 | [proxy.py · _prepare_flow](../engine/ai_proxy_engine/proxy.py#L180) |
| B12 | 基于目标与基线的调试效果验证 | 代码已落地；验收见右栏 | [domain.py · verify_debug_action](../engine/ai_proxy_engine/domain.py#L2041) |
| B13 | 修复标准 HAR 导入与往返保真 | 代码已落地；验收见右栏 | [domain.py · import_har](../engine/ai_proxy_engine/domain.py#L1343) |
| B14 | OpenAPI 契约匹配与支持子集说明 | 代码已落地；验收见右栏 | [domain.py · validate_openapi](../engine/ai_proxy_engine/domain.py#L1557) |
| B15 | 保存完整调查结论与环境化缺陷报告 | 代码已落地；验收见右栏 | [app.py · _generate_report](../engine/ai_proxy_engine/app.py#L915) |
| B16 | 明确数据清理与账户配置保留范围 | 代码已落地；验收见右栏 | [storage.py · clear_all](../engine/ai_proxy_engine/storage.py#L2335) |
| B17 | 恢复页面状态与草稿 | 代码已落地；验收见右栏 | [App.tsx · ai-proxy-capture-ui:](../src/App.tsx#L232) |
| B18 | 完整树/列表键盘与窄窗交互 | 代码已落地；验收见右栏 | [DirectoryTree.tsx · onKeyDown=](../src/components/DirectoryTree.tsx#L216) |
| C01 | 可编辑单请求重放与结果入库 | 代码已落地；验收见右栏 | [domain.py · replay](../engine/ai_proxy_engine/domain.py#L2148) |
| C02 | 有变量和前置条件的场景复现 | 代码已落地；验收见右栏 | [qa.py · recipe_step](../engine/ai_proxy_engine/qa.py#L129) |
| C03 | 成功基线与版本回归 | 代码已落地；验收见右栏 | [qa.py · compare_baseline](../engine/ai_proxy_engine/qa.py#L102) |
| C04 | 异常响应与网络场景矩阵 | 代码已落地；验收见右栏 | [qa.py · matrix_preview](../engine/ai_proxy_engine/qa.py#L260) |
| C05 | 登录/刷新/重定向诊断 | 代码已落地；验收见右栏 | [qa.py · auth](../engine/ai_proxy_engine/qa.py#L178) |
| C06 | 上传下载与二进制详情 | 代码已落地；验收见右栏 | [qa.py · file_info](../engine/ai_proxy_engine/qa.py#L209) |
| C07 | SSE 与 AI 流式接口分析 | 代码已落地；验收见右栏 | [proxy.py · responseheaders](../engine/ai_proxy_engine/proxy.py#L278) |
| C08 | WebSocket 帧级排查（可选） | 代码已落地；验收见右栏 | [proxy.py · websocket_message](../engine/ai_proxy_engine/proxy.py#L360) |
| C09 | 业务步骤与跨场景精确配对 | 代码已落地；验收见右栏 | [qa.py · pair](../engine/ai_proxy_engine/qa.py#L56) |
| C10 | 多项目/多环境隔离 | 代码已落地；验收见右栏 | [app.py · async _select_project](../engine/ai_proxy_engine/app.py#L173) |
| C11 | 可交接的脱敏证据包 | 代码已落地；验收见右栏 | [qa.py · evidence_package](../engine/ai_proxy_engine/qa.py#L220) |
| C12 | 可编辑、可勾选的人工验证清单 | 代码已落地；验收见右栏 | [qa.py · checklist](../engine/ai_proxy_engine/qa.py#L112) |
| D01 | 标准 MCP 客户端与能力发现 | 按用户要求暂缓 | [domain.py · call_mcp_tool](../engine/ai_proxy_engine/domain.py#L2177) |
| D02 | 把已授权外部读能力接入 Agent | 按用户要求暂缓 | [agent.py · _build_agent](../engine/ai_proxy_engine/agent.py#L989) |
| D03 | 真实观测平台适配与 Run 证据 | 按用户要求暂缓 | [domain.py · query_observability](../engine/ai_proxy_engine/domain.py#L2152) |
| D04 | 正确呈现跨服务与跨 Trace Links | 代码已落地；验收见右栏 | [domain.py · waterfall](../engine/ai_proxy_engine/domain.py#L1114) |
| D05 | 真实缺陷平台工单适配 | 按用户要求暂缓 | [domain.py · create_ticket](../engine/ai_proxy_engine/domain.py#L2219) |
| D06 | 外部操作历史和未知结果恢复入口 | 代码已落地；验收见右栏 | [qa.py · operations](../engine/ai_proxy_engine/qa.py#L250) |
| D07 | 桌面、供应商、真实数据和打包人工验收 | 待真实环境验收 | [app.py · async_main](../engine/ai_proxy_engine/app.py#L1112) |

## UX60项逐条核对

原UX01–48全部保留编号；UX49–60是后续追加。UX13旧要求“已存密钥不回前端”现由用户批准FIX04修订：默认不回填，只有主动查看才短暂进入当前组件内存，不写浏览器存储/报告，也不作为Agent工具。UX32增加可设置预算和手动压缩，UX50保留默认逐条请求并增加可选目录。下表详细边界沿用[UX状态表](ux-status.md)，有差异以本次用户批准后的实现为准。

| ID | 原改进项 | 当前状态 | 具体实现文件 |
| --- | --- | --- | --- |
| UX01 | 恢复窗口拖动 | 源码具备；待用户实机验收 | `src/components/TopBar.tsx、src-tauri/capabilities/default.json` |
| UX02 | 修复 Agent 底部被裁切 | 源码具备；待用户实机验收 | `src/styles.css、src/components/AIWorkspace.tsx` |
| UX03 | 修复抓包详情与就地 AI 滚动 | 源码具备；待用户实机验收 | `src/styles.css、src/components/CaptureWorkspace.tsx` |
| UX04 | 低高度与弹窗操作保障 | 源码具备；待用户实机验收 | `src/styles.css、src/components/Dialogs.tsx` |
| UX05 | 可调整面板宽度 | 源码具备；待用户实机验收 | `src/components/PanelResize.tsx` |
| UX06 | 统一窗口最小尺寸与响应式断点 | 源码具备；待用户实机验收 | `src-tauri/tauri.conf.json、src/styles.css` |
| UX07 | 统一字号、字重与文字对比 | 源码具备；待用户实机验收 | `src/styles.css` |
| UX08 | 文字缩放和显示密度 | 源码具备；待用户实机验收 | `src/lib/display.ts、src/components/CaptureWorkspace.tsx` |
| UX09 | 阅读时停止强制自动滚动 | 源码具备；待用户实机验收 | `src/components/AIWorkspace.tsx` |
| UX10 | 键盘与焦点完整性 | 源码具备；待用户实机验收 | `src/lib/focus.ts、src/components/Dialogs.tsx、src/styles.css` |
| UX11 | 凭据状态与读取错误分离 | 源码具备；待用户实机验收 | `src-tauri/src/credentials.rs、src/components/Dialogs.tsx` |
| UX12 | 配置与密钥保存一致性 | 源码具备；待用户实机验收 | `src-tauri/src/lib.rs、src-tauri/src/credentials.rs` |
| UX13 | 密钥默认不回填，主动查看 | 源码具备；待用户实机验收 | `src-tauri/src/lib.rs、src/components/Dialogs.tsx` |
| UX14 | 跨启动复用本地凭据 | 源码具备；待用户实机验收 | `src-tauri/Cargo.toml、src-tauri/src/credentials.rs` |
| UX15 | 已有账户的显式项目复用 | 源码具备；待用户实机验收 | `src/components/Dialogs.tsx、src-tauri/src/lib.rs` |
| UX16 | 分层连接与能力检查 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/app.py、src/components/Dialogs.tsx` |
| UX17 | 以手机局域网接入为主入口 | 源码具备；待用户实机验收 | `src/components/HelpDialog.tsx、src/App.tsx` |
| UX18 | 网络地址选择与变化反馈 | 源码具备；待用户实机验收 | `src/components/Dialogs.tsx、engine/ai_proxy_engine/proxy.py` |
| UX19 | 已接入设备与访问许可 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/connections.py、proxy.py` |
| UX20 | 本机就绪诊断 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/proxy.py、src/components/Dialogs.tsx` |
| UX21 | 手机直达引导页探测 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/connections.py、src/components/Dialogs.tsx` |
| UX22 | HTTP经过代理的验证 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/proxy.py` |
| UX23 | HTTPS解密验证 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/proxy.py、src/components/Dialogs.tsx` |
| UX24 | 目标App连接问题解释 | 源码具备；待用户实机验收 | `src/components/Dialogs.tsx` |
| UX25 | 暂停、停止与退出收尾 | 源码具备；待用户实机验收 | `src-tauri/src/lib.rs、engine/ai_proxy_engine/connections.py` |
| UX26 | 无设备/离线也能体验 | 源码具备；待用户实机验收 | `src/components/WorkbenchDialog.tsx、examples/capture.har.json` |
| UX27 | 当前CA与项目信任说明 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/app.py、src/components/Dialogs.tsx` |
| UX28 | 稳定可复用前缀 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/agent.py` |
| UX29 | 按协议/模型配置缓存 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/agent.py、src/components/Dialogs.tsx` |
| UX30 | 缓存、延迟和用量可见 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/agent.py、src/components/AIWorkspace.tsx` |
| UX31 | 有界只读工具结果缓存 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/agent.py、src/components/HelpDialog.tsx` |
| UX32 | 按预算压缩且可解释 | 源码具备；待用户实机验收 | `engine/ai_proxy_engine/agent.py、src/components/AgentContextPanel.tsx` |
| UX33 | 清楚的阶段与等待反馈 | 源码具备；待用户实机验收 | `src/components/AIWorkspace.tsx` |
| UX34 | 停止、超时和重试的下一步 | 源码具备；待用户实机验收 | `src/components/AIWorkspace.tsx、src/App.tsx` |
| UX35 | 发送失败不丢输入 | 源码具备；待用户实机验收 | `src/App.tsx、engine/ai_proxy_engine/app.py` |
| UX36 | 结论与证据易读可复核 | 源码具备；待用户实机验收 | `src/components/AIWorkspace.tsx、src/App.tsx` |
| UX37 | 正常渲染分析内容 | 源码具备；待用户实机验收 | `src/components/MarkdownText.tsx` |
| UX38 | 发送前范围与数据去向清楚 | 源码具备；待用户实机验收 | `src/App.tsx、src/components/AIWorkspace.tsx` |
| UX39 | 历史/续查状态一致 | 源码具备；待用户实机验收 | `src/App.tsx、src/components/AIWorkspace.tsx` |
| UX40 | 首次使用任务引导 | 源码具备；待用户实机验收 | `src/components/HelpDialog.tsx、src/App.tsx` |
| UX41 | 每个功能的统一用法说明 | 源码具备；待用户实机验收 | `src/components/HelpDialog.tsx、docs/user-guide.md` |
| UX42 | QA表单与结构化结果 | 源码具备；待用户实机验收 | `src/components/QAWorkspace.tsx、HeaderFields.tsx、ResultSummary.tsx` |
| UX43 | 可采取行动的错误反馈 | 源码具备；待用户实机验收 | `src/components/DiagnosticCopy.tsx、src/App.tsx` |
| UX44 | 长任务与重复点击处理 | 源码具备；待用户实机验收 | `src/components/WorkbenchDialog.tsx、QAWorkspace.tsx` |
| UX45 | 名称、状态与入口一致 | 源码具备；待用户实机验收 | `src/components/TopBar.tsx、Dialogs.tsx` |
| UX46 | 快捷操作与功能搜索 | 源码具备；待用户实机验收 | `src/components/HelpDialog.tsx、WorkbenchDialog.tsx` |
| UX47 | 空态、过滤和导入缺口说明 | 源码具备；待用户实机验收 | `src/components/CaptureWorkspace.tsx、WorkbenchDialog.tsx` |
| UX48 | 真实桌面与体验验收记录 | 用户实机验收待执行 | `docs/validation.md` |
| UX49 | 数据库连接与保存故障 | 源码具备；待用户实机验收 | `storage.py`、`proxy.py` |
| UX50 | 每个请求一行 | 源码具备；待用户实机验收 | `domain.py`、`CaptureWorkspace.tsx` |
| UX51 | 读取超时收尾 | 源码具备；待用户实机验收 | `app.py`、`lib.rs`、`api.ts` |
| UX52 | 请求终态和流空闲 | 源码具备；待用户实机验收 | `proxy.py`、`storage.py` |
| UX53 | 持续流量下的读取开销 | 源码具备；待用户实机验收 | `storage.py`、`CaptureWorkspace.tsx`、`App.tsx` |
| UX54 | 异步迟到结果隔离 | 源码具备；待用户实机验收 | `App.tsx`、`CaptureWorkspace.tsx` |
| UX55 | 底部信息占位 | 源码具备；待用户实机验收 | `styles.css` |
| UX56 | 证据有效性 | 源码具备；待用户实机验收 | `AIWorkspace.tsx` |
| UX57 | 存储健康与恢复入口 | 源码具备；待用户实机验收 | `experience.py`、`app.py`、`ExperiencePanels.tsx` |
| UX58 | 超时配置与HTTP/2选择 | 源码具备；待用户实机验收 | `proxy.py`、`app.py`、`ExperiencePanels.tsx` |
| UX59 | 统一任务等待和回执反馈 | 源码具备；待用户实机验收 | `operations.ts`、`api.ts`、`OperationFeedback.tsx`、`Dialogs.tsx` |
| UX60 | 缓存与性能比较 | 源码具备；待用户实机验收 | `experience.py`、`agent.py`、`ExperiencePanels.tsx` |

## 仍待完成的验收，而非开发缺口

1. 用新包实机核对所有FIX和UX操作，包括中文输入、键盘、短窗/200%文字、实时流量和迟到结果；不能仅凭构建成功打勾。
2. 真实Provider工具循环、审批、Shell停止/超时、缓存指标、上下文压缩/续查与新快照；开发期间没有调用模型或执行这些新Shell工具。
3. 手机直达/来源地址许可/HTTP/HTTPS/App分层验证，以及停机/切网/睡眠/项目切换收尾。
4. 历史持久化失败已丢失数据不能补造；新实现须由持续抓包确认丢失计数、内存和流畅性。
5. 当前仍是ad-hoc开发包，未公证；不把第一轮119项、第二轮49项、UX60和新8条都写成“实机完成”。原TODO保留。

Scope约束适用于注册的抓包读取工具；逐条批准的Shell具有本机用户访问能力，不能当作Scope内的只读工具。Shell工作目录中的用户文件不会随清分析或清项目自动递归删除，请手动管理。
