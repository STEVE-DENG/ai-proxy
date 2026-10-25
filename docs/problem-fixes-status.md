# 问题修复RF01–RF56交付对照

用户随后指出原问题仍未完成：此前错误归档的三份TODO已恢复，当前以[未完成事项总表](/Users/dengxurui/Documents/日常/开源项目/ai_proxy/todo/todo 未完成事项总表.md)及原TODO为待办入口。下述源码交付记录不代表问题已经解决或任务已经关闭；未确认项继续保留，不能全部归类为仅待人工验收。

后续二次复核的18项补修已补齐源码，异步/异常边界以[本轮交付](improvement-status.md)为准；各历史条目继续保留人工验收。

来源：[用户批准的56项清单](/Users/dengxurui/Documents/日常/开源项目/ai_proxy/调研/2026-10-24-21-35-问题修复TODO调研与逐项功能清单.md)。本表按原编号列出实现入口和仍待执行的验收，不累计历史重叠功能。

本轮已完成9项补齐和5项扩展；RF01–RF55具备源码入口，RF56的布局保护也已补充，但该条本身是实际桌面验收任务，仍待用户执行。所有真实手机、Provider、Shell/网络发送及桌面交互验收均未由本轮执行，不能按构建成功标记通过。

保持用户约束：单Agent，不接外部平台，不创建/运行测试套件，不启动应用/代理/Provider，不读取实际密钥或旧Keychain，不提交推送或覆盖运行中的安装包。

| ID | 功能 | 当前交付状态 | 源码入口 |
| --- | --- | --- | --- |
| RF01 | 创建分析范围时排除仍在进行中的请求，并展示原匹配数、排除数、实际纳入数 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/domain.py](../engine/ai_proxy_engine/domain.py#L124) |
| RF02 | 手动勾选包含进行中样本时，在发送前阻止并告知处理办法 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/domain.py](../engine/ai_proxy_engine/domain.py#L168) |
| RF03 | 版本变化、请求删除、配置变化时明确判定失效，保留历史证据 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/domain.py](../engine/ai_proxy_engine/domain.py#L267) |
| RF04 | 区分“继续原快照”与“按原条件创建新快照” | 源码已复核；待人工验收 | [src/App.tsx](../src/App.tsx#L1313) |
| RF05 | 新快照分析完整复用原用户问题，并显示范围变化 | 本轮已补齐源码；待人工验收 | [engine/ai_proxy_engine/app.py](../engine/ai_proxy_engine/app.py#L78) |
| RF06 | 按错误类别展示恢复动作 | 本轮已补齐源码；待人工验收 | [engine/ai_proxy_engine/errors.py](../engine/ai_proxy_engine/errors.py#L13) |
| RF07 | 重建快照期间切会话时隔离迟到失败和结果 | 本轮已补齐源码；待人工验收 | [src/App.tsx](../src/App.tsx#L1313) |
| RF08 | 当前会话显示历史消息数和历史大小估算 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L320) |
| RF09 | 设置并保存历史预算、消息预算 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L305) |
| RF10 | 发送前说明下一轮预计保留的历史量和预算异常 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1770) |
| RF11 | 增加完整输入构成和模型窗口余量展示 | 本轮已补齐源码；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L355) |
| RF12 | 压缩覆盖层和原始历史分离，按会话与来源Run绑定 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L312) |
| RF13 | 上下文面板操作的异步结果隔离 | 本轮已补齐源码；待人工验收 | [src/components/AgentContextPanel.tsx](../src/components/AgentContextPanel.tsx#L48) |
| RF14 | `/compress`和面板按钮执行同一压缩动作 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L396) |
| RF15 | 按完整用户轮次保留工具调用与返回关系 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1770) |
| RF16 | 显示压缩说明并保留原始Run、证据 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1796) |
| RF17 | `/new`、`/help`、`/stop`执行本地操作 | 源码已复核；待人工验收 | [src/components/AIWorkspace.tsx](../src/components/AIWorkspace.tsx#L357) |
| RF18 | 对未知命令、参数错误给出本地说明 | 本轮已补齐源码；待人工验收 | [src/lib/agentCommands.ts](../src/lib/agentCommands.ts#L10) |
| RF19 | 输入`/`展示可用命令、说明、禁用原因和键盘选择 | 本轮已补齐源码；待人工验收 | [src/components/AIWorkspace.tsx](../src/components/AIWorkspace.tsx#L325) |
| RF20 | 统一常见命令别名及现有面板快捷入口 | 本轮已补齐源码；待人工验收 | [src/lib/agentCommands.ts](../src/lib/agentCommands.ts#L1) |
| RF21 | 展开账户名、协议、模型、Base URL、保存状态等详情 | 源码已复核；待人工验收 | [src/components/Dialogs.tsx](../src/components/Dialogs.tsx#L695) |
| RF22 | 用户主动显示/隐藏已保存Key | 源码已复核；待人工验收 | [src/components/Dialogs.tsx](../src/components/Dialogs.tsx#L518) |
| RF23 | 已保存Key与待替换的新Key独立 | 源码已复核；待人工验收 | [src/components/Dialogs.tsx](../src/components/Dialogs.tsx#L526) |
| RF24 | 自动收起敏感内容 | 源码已复核；待人工验收 | [src/components/Dialogs.tsx](../src/components/Dialogs.tsx#L507) |
| RF25 | 限制密钥进入其他输出 | 源码已复核；待人工验收 | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs#L470) |
| RF26 | 跨启动复用凭据并说明本地文件位置 | 源码已复核；待人工验收 | [src-tauri/src/credentials.rs](../src-tauri/src/credentials.rs#L35) |
| RF27 | 明确切换逐请求与目录视图 | 源码已复核；待人工验收 | [src/components/CaptureWorkspace.tsx](../src/components/CaptureWorkspace.tsx#L1124) |
| RF28 | Host→路径目录→方法/路径组→真实请求实例 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/domain.py](../engine/ai_proxy_engine/domain.py#L275) |
| RF29 | 单子目录合并并保留路径语义 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/domain.py](../engine/ai_proxy_engine/domain.py#L275) |
| RF30 | 折叠/逐层展开并保存目录状态 | 源码已复核；待人工验收 | [src/components/DirectoryTree.tsx](../src/components/DirectoryTree.tsx#L81) |
| RF31 | 搜索临时展开匹配路径 | 源码已复核；待人工验收 | [src/components/DirectoryTree.tsx](../src/components/DirectoryTree.tsx#L30) |
| RF32 | 未加载请求与证据深分页定位 | 源码已复核；待人工验收 | [src/components/DirectoryTree.tsx](../src/components/DirectoryTree.tsx#L47) |
| RF33 | 虚拟滚动、有限刷新和键盘导航 | 源码已复核；待人工验收 | [src/components/DirectoryTree.tsx](../src/components/DirectoryTree.tsx#L38) |
| RF34 | 弱网读取、上下行限速/延迟预览、应用、恢复 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1400) |
| RF35 | Map Local/Map Remote/Rewrite的预览、应用与恢复 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1416) |
| RF36 | 抓包启停/暂停/恢复、端口/LAN及Mac系统代理管理 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1537) |
| RF37 | 手机接入准备：局域网监听、10分钟配对、打开引导 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1561) |
| RF38 | 查询分层连接状态、核对来源地址并授权/撤销 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1577) |
| RF39 | Compose编辑已有请求并生成固定预览 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1487) |
| RF40 | Repeat按1–10个独立预览顺序发送并记录结果 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1521) |
| RF41 | 显式本机Shell执行及停止、超时、输出限制 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/shell.py](../engine/ai_proxy_engine/shell.py#L14) |
| RF42 | 调试模式权限、强制审批和动作审计 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L552) |
| RF43 | 从零Compose新请求 | 本轮已补齐源码；待人工验收 | [engine/ai_proxy_engine/agent.py](../engine/ai_proxy_engine/agent.py#L1495) |
| RF44 | 重放的直连/经过本地代理模式选择 | 本轮已补齐源码；待人工验收 | [engine/ai_proxy_engine/composer.py](../engine/ai_proxy_engine/composer.py#L52) |
| RF45 | 有限Advanced Repeat | 本轮已补齐源码；待人工验收 | [engine/ai_proxy_engine/composer.py](../engine/ai_proxy_engine/composer.py#L183) |
| RF46 | 抓包页与Agent页外层常驻紧凑状态条 | 源码已复核；待人工验收 | [src/components/DeviceStatusBar.tsx](../src/components/DeviceStatusBar.tsx#L7) |
| RF47 | 外层直接允许一次、记住地址、拒绝/撤销 | 源码已复核；待人工验收 | [src/components/DeviceStatusBar.tsx](../src/components/DeviceStatusBar.tsx#L33) |
| RF48 | 外层区分连接许可和HTTP/HTTPS诊断结果 | 本轮已补齐源码；待人工验收 | [src/components/DeviceStatusBar.tsx](../src/components/DeviceStatusBar.tsx#L43) |
| RF49 | 有限轮询、暂停后台刷新及读取失败提示 | 源码已复核；待人工验收 | [src/components/DeviceStatusBar.tsx](../src/components/DeviceStatusBar.tsx#L20) |
| RF50 | 来源IP、许可、最近活动和真实在线概念分开 | 源码已复核；待人工验收 | [src/components/DeviceStatusBar.tsx](../src/components/DeviceStatusBar.tsx#L52) |
| RF51 | 撤销、停机、切网、睡眠、配对过期后的状态收尾 | 源码已复核；待人工验收 | [engine/ai_proxy_engine/connections.py](../engine/ai_proxy_engine/connections.py#L63) |
| RF52 | 压缩会话标题栏、移除装饰性技术副标题 | 源码已复核；待人工验收 | [src/styles.css](../src/styles.css#L1136) |
| RF53 | 分析记录/报告默认折叠，会话侧栏可收起 | 源码已复核；待人工验收 | [src/components/RunHistory.tsx](../src/components/RunHistory.tsx#L19) |
| RF54 | 历史记录超出显示数量时有明确“查看更多”入口 | 本轮已补齐源码；待人工验收 | [engine/ai_proxy_engine/storage.py](../engine/ai_proxy_engine/storage.py#L1442) |
| RF55 | 历史条目显示有辨识度的任务摘要和状态 | 本轮已补齐源码；待人工验收 | [src/components/RunHistory.tsx](../src/components/RunHistory.tsx#L21) |
| RF56 | 小窗、低高度、200%字体和长标题的布局验收 | 待用户桌面验收；已补充布局保护 | [src/styles.css](../src/styles.css#L1154) |

## 使用方式与边界

快照恢复先读取原任务（续查会追溯原问题），按原条件固定新版本，列出新增/移出/版本变化、排除进行中和引用变化，再确认创建新分析。确认后仍进行版本校验；原时间上界保留。错误按结构化code提示范围、供应商、超时或未知回执，不再使用中文正则识别。

输入`/`选择命令，方向键移动、Tab或Enter填入，随后发送执行。支持`/compress`、`/compact`、`/new`、`/help`、`/stop`、`/context`、`/sessions`、`/models`。未知命令和多余参数在本地报错；普通斜杠文本以`//`开头。中文输入法组合期间不发送。

上下文面板显示历史与下一轮保留量，手动计算完整发送预览时才构建范围和本地工具Schema，不创建Run、不请求模型。估算分为历史、指令与兼容历史、工具定义、下一条输入、范围与引用，使用UTF-8字节启发式；供应商包装开销未知，不是精确Tokenizer。窗口及输出预留由用户核实配置，按端点/协议/模型隔离，未知不显示比例。输出预留不改变真实模型输出参数。输入或范围改变后重新计算。压缩保留至多最近2个完整轮次与固定摘要，原始消息和证据保留，可能损失旧细节；单轮或摘要超限需调整预算/新会话。

QA→编辑重放提供空白Compose、载入已有抓包、重复Header、正文文本/Base64、直连/本地代理，以及次数1–20、并发1–3、全局派发间隔0–10000ms、整组总时限5–60秒。单条响应最多5MiB预览/保存、单条请求正文5MiB、整组请求正文20MiB。代理HTTPS必须先显式开启目标Host解密；仅额外信任本项目CA，不修改系统信任。拒绝直接发送到本代理监听/引导端口，不跟随重定向、不使用系统环境代理。预览绑定请求版本、配置、监听实例和CA，变化后需重新预览。

批量发送前批准整组固定参数；HTTP失败、截断、传输失败或未知后停止后续派发。并发中已发请求可能继续产生业务副作用，停止关闭仍等待的客户端连接，不能撤销服务端操作。每条动作先claim，已发送的预览不再发送，服务端不一定支持幂等Header。任务和动作持久化，进程中断标为interrupted/unknown，不自动恢复发送。代理链路由真实代理创建唯一抓包行并记录Compose关联，不重复伪造一条；capturePending表示保存尚未确认，需核对存储与实际记录。

Agent工具增加`compose_new_request`、`preview_advanced_repeat`、`execute_advanced_repeat`、`get_composed_request_status`，保留`compose_request`的1–10次便捷入口。整组执行工具始终人工批准，即使autoApply开启；审批中显示目标、链路、次数/并发/间隔/时限及脱敏固定预览。只分析模式不注册写工具。Shell沿用20秒/64KiB、本机用户权限非沙箱、逐条批准；本轮没有执行Shell工具。

外层状态条分开显示许可、直达、HTTP和HTTPS解密证据，绑定当前配对及来源地址；配对过期、拒绝撤销、切网/停机等会失效。轮询失败时不继续宣称验证通过。IP不是设备身份，浏览器通过不证明目标App成功。历史记录按原问题摘要和中文状态展示，分页读取完整Run历史；报告可翻页。

## 验收与交付

按原调研每行的验收标准执行；重点保留RF07/RF13异步切换、RF24密钥迟到隐藏、RF32深分页、RF40/RF45取消/超时/部分失败、RF48配对过期、RF54旧历史和RF56窄窗/200%字体场景。原TODO保留，避免把源码交付误写成故障已实机闭环。构建和签名结果见[验证记录](validation.md)。
