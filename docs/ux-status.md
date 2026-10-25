# 用户体验实现与验收状态

用户随后指出原问题仍未完成：此前错误归档的三份TODO已恢复，当前以[未完成事项总表](/Users/dengxurui/Documents/日常/开源项目/ai_proxy/todo/todo 未完成事项总表.md)及原TODO为待办入口。下述源码交付记录不代表问题已经解决或任务已经关闭；未确认项继续保留，不能全部归类为仅待人工验收。

后续二次复核的18项补修已补齐源码，异步/异常边界以[本轮交付](improvement-status.md)为准；各历史条目继续保留人工验收。

[返回README](../README.md) · [使用指南](user-guide.md) · [人工验收](validation.md)

目前按60条UX改进与验收条目跟踪；UX01–47、UX49–60已有实现落点，均待真实操作验收；UX48本身为待用户执行的验收任务。UX49–56细化截图故障回归，与前48项有关联，不作为8套新功能重复计数。“已实现”只表示源码落地，不表示全部用户完成条件已通过。基线为 `599cc3a8c7668bee415d91425a6971bc4a3897a5`，分支 `codex/full-ai-agent-workflows`；本轮尚未提交，不复用基线commit标识新包。

## 开发完成度复核（2026-10-24）

用户要求继续检查遗漏后，重新对照原TODO、60条目标、界面入口与引擎实现，补齐以下源码缺口。清单中的独立功能均已有实现入口，仍有UX48真实验收未执行；未将以下补修另计成新增UX条目。

- UX10：弹窗与窄窗就地AI共用焦点层管理；只让最上层处理Esc/Tab，按打开顺序显示并恢复焦点。
- UX42/44/54：QA读取请求时不再允许使用旧表单；失败可重新读取。QA与旧工作台重放预览绑定请求ID/版本；改调试参数或工单目标即使旧预览失效。补齐环境/配置/契约/现有MCP与工单入口的防连点、忙碌状态和异常收尾，移除未接通的Header自动提取输入框，保留手工环境版本填写。
- UX57：真正的持久化失败、队列满丢弃和总缺口事件分别统计，不能混称写入失败或唯一丢失请求。
- UX59：高频轮询优先淘汰完成元数据，保留正在等待的记录；补齐本地读取分类，写操作内部超时不再显示“20秒读取超时”。最多100条；同时已有100条等待时不再追踪新增记录，实际请求仍按原时限收尾。
- UX60：比较结果绑定所选Run及其状态/用量；记录更新或删除后旧摘要失效，迟到结果不覆盖新选择。
- 知识库60条正文同步当前状态，修正UX57–60仍写“待开发”与顶部补记冲突的问题。初版55+1+4仅作为历史口径保留。

以上是源码复核和补修，编译/打包结果见[验证记录](validation.md)。叠加弹窗键盘、快速切换/改预览、队列压力、等待反馈和真实性能效果仍需实际桌面验收。

## 凭据方案与升级

按用户要求移除Keychain。参考[OpenCode官方凭据文档](https://opencode.ai/docs/providers/)的本地auth.json与[Aider官方配置](https://aider.chat/docs/config/api-keys.html)的环境变量/.env/YAML做法，选择独立本地文件；没有把“所有开源Agent都不用Keychain”当作事实。

本项目文件在 `~/Library/Application Support/com.nekoya.ai-proxy/credentials/auth.json`，目录0700、文件0600、原子替换；明文，同账户其它进程仍可读。已存Key默认不回填React；用户批准FIX04后新增主动临时查看，不写业务库或证据包。旧Keychain不自动读取/迁移/删除：在设置重新录入一次，以后复用。CA证书信任仍由系统管理。完整数据根备份含凭据，SQLite迁移备份不含。

## 逐项落点

下表UX01–47统一状态为**代码已落地，人工验收待执行**；UX48为**待执行**。构建、冻结、打包和最终严格签名检查均已通过；产物指纹与警告见人工验收文档。手动条件来自用户批准后的清单，重点回归在表后。

| ID | 功能 | 源码落点（仓库相对路径） | 实现及边界 |
| --- | --- | --- | --- |
| UX01 | 恢复窗口拖动 | `src/components/TopBar.tsx、src-tauri/capabilities/default.json` | 拖动命中区、拖动/双击缩放权限 |
| UX02 | 修复 Agent 底部被裁切 | `src/styles.css、src/components/AIWorkspace.tsx` | 可收缩高度链、消息滚动、输入与停止操作 |
| UX03 | 修复抓包详情与就地 AI 滚动 | `src/styles.css、src/components/CaptureWorkspace.tsx` | 树/详情/就地AI分别滚动 |
| UX04 | 低高度与弹窗操作保障 | `src/styles.css、src/components/Dialogs.tsx` | 低高度、长弹窗与换行/滚动工具栏 |
| UX05 | 可调整面板宽度 | `src/components/PanelResize.tsx` | 面板比例保存、钳制、方向键/Home/双击重置 |
| UX06 | 统一窗口最小尺寸与响应式断点 | `src-tauri/tauri.conf.json、src/styles.css` | 760×520下限、窄窗AI浮层与全宽详情/会话折叠 |
| UX07 | 统一字号、字重与文字对比 | `src/styles.css` | 主要文字14–15px、技术文字层级、对比色调整 |
| UX08 | 文字缩放和显示密度 | `src/lib/display.ts、src/components/CaptureWorkspace.tsx` | 100%–200%文字/密度、虚拟行高和滚动比例同步 |
| UX09 | 阅读时停止强制自动滚动 | `src/components/AIWorkspace.tsx` | 阅读暂停跟随、新内容按钮与阅读位置保存 |
| UX10 | 键盘与焦点完整性 | `src/lib/focus.ts、src/components/Dialogs.tsx、src/styles.css` | 最上层弹窗Tab循环/Esc/焦点返回、分隔条键盘、reduced-motion |
| UX11 | 凭据状态与读取错误分离 | `src-tauri/src/credentials.rs、src/components/Dialogs.tsx` | 独立状态/读取错误与供应商鉴权错误 |
| UX12 | 配置与密钥保存一致性 | `src-tauri/src/lib.rs、src-tauri/src/credentials.rs` | 原子文件、保存补偿、回执未知不删除可能已提交凭据 |
| UX13 | 密钥默认不回填，主动查看 | `src-tauri/src/lib.rs、src/components/Dialogs.tsx` | FIX04按用户批准增加主动显隐；30秒/切出窗口清空，不写表单/业务库/模型上下文 |
| UX14 | 跨启动复用本地凭据 | `src-tauri/Cargo.toml、src-tauri/src/credentials.rs` | 移除keyring，改用本地auth.json，无旧Keychain自动迁移 |
| UX15 | 已有账户的显式项目复用 | `src/components/Dialogs.tsx、src-tauri/src/lib.rs` | 显式来源账户复制到独立Provider ID |
| UX16 | 分层连接与能力检查 | `engine/ai_proxy_engine/app.py、src/components/Dialogs.tsx` | 本地格式校验、主动连接检查与最多3次请求的合成工具检查 |
| UX17 | 以手机局域网接入为主入口 | `src/components/HelpDialog.tsx、src/App.tsx` | 手机/本机/离线入口，LAN不自动修改系统代理/全量解密 |
| UX18 | 网络地址选择与变化反馈 | `src/components/Dialogs.tsx、engine/ai_proxy_engine/proxy.py` | 网卡/IP选择、地址复制、网络变化失效 |
| UX19 | 已接入设备与访问许可 | `engine/ai_proxy_engine/connections.py、proxy.py` | IP允许一次/记住/拒绝与关闭连接，非物理设备身份 |
| UX20 | 本机就绪诊断 | `engine/ai_proxy_engine/proxy.py、src/components/Dialogs.tsx` | 监听socket与内核task、本机就绪错误分层 |
| UX21 | 手机直达引导页探测 | `engine/ai_proxy_engine/connections.py、src/components/Dialogs.tsx` | 10分钟标识绑定来源IP，2分钟可停止轮询 |
| UX22 | HTTP经过代理的验证 | `engine/ai_proxy_engine/proxy.py` | 受控本地HTTP挑战，按配对/IP/时间记证据 |
| UX23 | HTTPS解密验证 | `engine/ai_proxy_engine/proxy.py、src/components/Dialogs.tsx` | CA安装/完全信任与实际HTTPS解密挑战分开 |
| UX24 | 目标App连接问题解释 | `src/components/Dialogs.tsx` | 浏览器成功不代表App；CA限制/固定证书/VPN/QUIC候选 |
| UX25 | 暂停、停止与退出收尾 | `src-tauri/src/lib.rs、engine/ai_proxy_engine/connections.py` | 切项目/清理前恢复Mac代理，停机/切网/睡眠间隔使证据失效，手机手动关闭 |
| UX26 | 无设备/离线也能体验 | `src/components/WorkbenchDialog.tsx、examples/capture.har.json` | 主动导入合成示例，无需代理/模型 |
| UX27 | 当前CA与项目信任说明 | `engine/ai_proxy_engine/app.py、src/components/Dialogs.tsx` | 当前项目CA SHA256指纹、安装/移除与切项目说明 |
| UX28 | 稳定可复用前缀 | `engine/ai_proxy_engine/agent.py` | 保留历史前缀，不再将动态Run来源摘要插到最前面 |
| UX29 | 按协议/模型配置缓存 | `engine/ai_proxy_engine/agent.py、src/components/Dialogs.tsx` | 官方/兼容端点auto/enabled/off；失败不自动再发收费请求 |
| UX30 | 缓存、延迟和用量可见 | `engine/ai_proxy_engine/agent.py、src/components/AIWorkspace.tsx` | 逐次模型用量/首输出/耗时，本地缓存独立，未知不作0% |
| UX31 | 有界只读工具结果缓存 | `engine/ai_proxy_engine/agent.py、src/components/HelpDialog.tsx` | Scope/版本/配置等绑定、LRU128项/序列化8MiB/TTL120秒，查看清理 |
| UX32 | 按预算压缩且可解释 | `engine/ai_proxy_engine/agent.py、src/components/AgentContextPanel.tsx` | 项目级上下文预算、历史估算与手动/自动完整轮次压缩；固定摘要/原Run/证据保留 |
| UX33 | 清楚的阶段与等待反馈 | `src/components/AIWorkspace.tsx` | 阶段、模型与工具事件、用量、等待批准与已完成结果 |
| UX34 | 停止、超时和重试的下一步 | `src/components/AIWorkspace.tsx、src/App.tsx` | 停止请求状态与错误入口，回执后补读真实Run状态 |
| UX35 | 发送失败不丢输入 | `src/App.tsx、engine/ai_proxy_engine/app.py` | 确认创建才清输入，提交operationId重试/续查映射 |
| UX36 | 结论与证据易读可复核 | `src/components/AIWorkspace.tsx、src/App.tsx` | 证据定位、限制说明和返回阅读位置 |
| UX37 | 正常渲染分析内容 | `src/components/MarkdownText.tsx` | GFM表格/列表/代码块；跳过HTML、不加载远程图片 |
| UX38 | 发送前范围与数据去向清楚 | `src/App.tsx、src/components/AIWorkspace.tsx` | 本次发送条件与所选Run快照分开，Provider/模式/费用可见 |
| UX39 | 历史/续查状态一致 | `src/App.tsx、src/components/AIWorkspace.tsx` | 历史Run数据绑定、会话草稿与阅读位置、续查沿用原Scope |
| UX40 | 首次使用任务引导 | `src/components/HelpDialog.tsx、src/App.tsx` | 首次任务三入口，可跳过/返回 |
| UX41 | 每个功能的统一用法说明 | `src/components/HelpDialog.tsx、docs/user-guide.md` | 约26组功能说明、前置/步骤/影响/失败恢复与入口 |
| UX42 | QA表单与结构化结果 | `src/components/QAWorkspace.tsx、HeaderFields.tsx、ResultSummary.tsx` | 重复Header表单、QA结果分层、原始JSON高级详情 |
| UX43 | 可采取行动的错误反馈 | `src/components/DiagnosticCopy.tsx、src/App.tsx` | 错误常驻、草稿/检查/历史入口、仅元数据诊断复制 |
| UX44 | 长任务与重复点击处理 | `src/components/WorkbenchDialog.tsx、QAWorkspace.tsx` | keepMounted保留已访问QA/预览，busy/提交ref防连点，取消仅已有可取消作业 |
| UX45 | 名称、状态与入口一致 | `src/components/TopBar.tsx、Dialogs.tsx` | 中文任务名与可见名称、关闭按钮aria、监听/代理/解密分开 |
| UX46 | 快捷操作与功能搜索 | `src/components/HelpDialog.tsx、WorkbenchDialog.tsx` | 快捷帮助/功能搜索，qa:section直达对应页 |
| UX47 | 空态、过滤和导入缺口说明 | `src/components/CaptureWorkspace.tsx、WorkbenchDialog.tsx` | 清除全部筛选字段、导入失败/遗漏计数、正文缺口说明 |
| UX48 | 真实桌面与体验验收记录 | `docs/validation.md` | 本轮只完成构建/冻结/打包检查；真实桌面、手机、Provider验收待用户 |

## UX49–60补充落点

下列12项均为源码已落地、待人工验收；UX49–56承接截图故障修复，UX57–60为用户批准60条清单后的增强。UX48仍待用户执行，不将构建结果当作体验通过。

| ID | 改进项 | 源码落点 | 边界 |
| --- | --- | --- | --- |
| UX49 | 数据库连接与保存故障 | `storage.py`、`proxy.py` | 连接关闭；其他磁盘/权限原因待真实采集排除，历史丢失响应不可补造 |
| UX50 | 每个请求一行 | `domain.py`、`CaptureWorkspace.tsx` | 默认Host→逐条请求，每Host200条分页，路径含查询串；FIX05恢复可选目录视图 |
| UX51 | 读取超时收尾 | `app.py`、`lib.rs`、`api.ts` | 请求和选定只读方法20/23/25秒兜底，错误后可主动重试 |
| UX52 | 请求终态和流空闲 | `proxy.py`、`storage.py` | 总时限/流空闲默认120秒，停止/重开收束，HTTP/2共享承载连接有连带影响 |
| UX53 | 持续流量下的读取开销 | `storage.py`、`CaptureWorkspace.tsx`、`App.tsx` | SQL Host聚合、虚拟滚动、分页/限频/去重；无实测帧率承诺 |
| UX54 | 异步迟到结果隔离 | `App.tsx`、`CaptureWorkspace.tsx` | 当前对象/版本校验、正文分段隔离、关联加载收尾 |
| UX55 | 底部信息占位 | `styles.css` | 正常流布局、换行与限高滚动；小窗口仍需人工检查 |
| UX56 | 证据有效性 | `AIWorkspace.tsx` | 有效与失效分开，删除来源保留历史引用且禁用跳转 |
| UX57 | 存储健康与恢复入口 | `experience.py`、`app.py`、`ExperiencePanels.tsx` | 设置→存储；磁盘/目录临时文件探测/只读SQLite；时间与写入失败计数仅本次项目打开，诊断复制去除路径 |
| UX58 | 超时配置与HTTP/2选择 | `proxy.py`、`app.py`、`ExperiencePanels.tsx` | 两种时限5–3600秒、按项目保存、新请求生效；停止后可关闭HTTP/2，未实现可靠的单个HTTP/2流取消 |
| UX59 | 统一任务等待和回执反馈 | `operations.ts`、`api.ts`、`OperationFeedback.tsx`、`Dialogs.tsx` | 主窗口和弹窗入口；等待起点/时长/回执上限、失败/读取超时/写回执未知；元数据100条/10分钟；不会凭前端超时假装后台取消 |
| UX60 | 缓存与性能比较 | `experience.py`、`agent.py`、`ExperiencePanels.tsx` | 执行记录选2–10个Run，只读历史；比较模型/端点/样本版本/规则，旧数据缺失保持未知，不估算费用、不主动调用模型 |

新增人工检查：存储路径不可写/磁盘不足后的提示、临时探测清理、保存/重开/切项目后的超时值、HTTP/2关闭协商、活跃SSE/心跳、不同比较条件与旧Run指标、任务回执未知后查历史、关闭弹窗不取消任务。真实数据、Provider与设备操作继续由用户手动完成。

## 手动验收重点与未覆盖

1. 新包中拖顶栏/品牌、双击缩放、短窗口760×520、文字100%/150%/200%、长内容/弹窗/审批；多显示器、焦点与大列表证据跳转需实际观察，静态颜色调整不代表所有状态都达到对比目标。
2. 旧Provider重新录入一次，重开应用、macOS重新登录、覆盖更新后复用；损坏/不可写文件、保存/删除失败、401、跨项目复制后的独立替换。不要将真Key写入验收记录。
3. 手机直达→首次代理请求在Mac授权→HTTP挑战→CA安装/完全信任→开启解密→HTTPS挑战→目标App；拒绝/撤销、地址变化、停止/睡眠/切项目及手机代理关闭。浏览器通过不替代App，IP不是设备身份。
4. 同一真实模型多轮比较缓存读写、耗时/首输出，兼容端点开/关扩展；命中没有固定承诺。预算压缩、版本变化缓存失效、停止/回执丢失重试、历史/草稿/证据返回、中文输入法与阅读不抢滚动。
5. 逐个QA页核对前置/空态、表单、证据与未知结果，切页/关窗后看任务与预览。取消只适用于原本支持取消的作业，不声称对外发送后可撤回；operationId不保证进程崩溃下数据库多表原子性。

本轮不新增/运行测试套件，不启动桌面或代理，不调用真实Provider，不读取旧Keychain；人工验收由用户执行。已有A11/D07和长期负载/真实流等验收继续保留，外部平台继续暂缓。

## 历史清单及新增8条的后续复核

用户要求覆盖历史119/49/48/60条，并明确将《todo 问题修复.md》8条一并开发。见[总复核](checklist-audit.md)：恢复目录入口回归、修复单子目录合并/深分页证据定位、完成请求快照及范围外引用处理，新增上下文设置/本地compress、主动密钥查看、代理/手机/Compose/Repeat/Shell工具与外层设备状态、紧凑标题/默认折叠历史。FIX01–08不是追加8个UX编号，避免重复计数。真实验收状态不变。
