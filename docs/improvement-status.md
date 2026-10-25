# 二次复核18项改进交付

用户随后指出原问题仍未完成：此前错误归档的三份TODO已恢复，当前以[未完成事项总表](/Users/dengxurui/Documents/日常/开源项目/ai_proxy/todo/todo 未完成事项总表.md)及原TODO为待办入口。下述源码交付记录不代表问题已经解决或任务已经关闭；未确认项继续保留，不能全部归类为仅待人工验收。

源码已补齐 RI01–RI18；编译与打包结果见[验收记录](validation.md)。这不是18项实机通过的声明，VA01–VA08仍由用户手动验收。原8条、RF56及更早119/49/60清单存在重叠，不累加为独立功能数量。

## 逐项对照

| ID | 本轮行为 | 主要源码 | 状态 |
| --- | --- | --- | --- |
| RI01 | 手选快照先核对缺失/不匹配项；确认后只保留原选择，全部缺失则停止 | [app.py](../engine/ai_proxy_engine/app.py) | 源码已实现，待人工验收 |
| RI02 | 缺失选择、场景、批次与原问题独立错误code；调整范围及按根任务复制问题 | [domain.py](../engine/ai_proxy_engine/domain.py) | 源码已实现，待人工验收 |
| RI03 | 上下文逐请求序号、身份隔离、dirty编辑保护和读取重试 | [AgentContextPanel.tsx](../src/components/AgentContextPanel.tsx) | 源码已实现，待人工验收 |
| RI04 | 完整预览绑定数据库来源修订、项目、会话、Provider与预算指纹；变化失效 | [agent.py](../engine/ai_proxy_engine/agent.py) | 源码已实现，待人工验收 |
| RI05 | 密钥首次读取前安装失焦/隐藏监听，回执再查焦点、身份及代次 | [Dialogs.tsx](../src/components/Dialogs.tsx) | 源码已实现，待人工验收 |
| RI06 | 密钥查看10秒超时、finally释放busy；迟到成功/失败均隔离 | [api.ts](../src/lib/api.ts) | 源码已实现，待人工验收 |
| RI07 | 证据定位区分删除/筛选排除/读取失败/层数与行数上限；25秒等待和恢复入口 | [DirectoryTree.tsx](../src/components/DirectoryTree.tsx) | 源码已实现，待人工验收 |
| RI08 | Compose前后校验expectedSourceVersion；来源删除或变化拒绝混用正文 | [composer.py](../engine/ai_proxy_engine/composer.py) | 源码已实现，待人工验收 |
| RI09 | 恢复后按动作派生完成/未发/未知/失败及HTTP错误计数，记录recoveredAt | [composer.py](../engine/ai_proxy_engine/composer.py) | 源码已实现，待人工验收 |
| RI10 | 核对唯一实际代理抓包与动作关联，30秒收尾保存状态；可只读重查 | [composer.py](../engine/ai_proxy_engine/composer.py) | 源码已实现，待人工验收 |
| RI11 | 连续3次失败或发送总时限+30秒后停止自动等待，手动核对且不重发 | [ComposePanel.tsx](../src/components/ComposePanel.tsx) | 源码已实现，待人工验收 |
| RI12 | 监听常驻watchdog与status统一检测睡眠/调度间隔，旧证据失效并关闭连接 | [connections.py](../engine/ai_proxy_engine/connections.py) | 源码已实现，待人工验收 |
| RI13 | 页码与服务端成功返回页绑定，翻页失败保留原数据/页码 | [RunHistory.tsx](../src/components/RunHistory.tsx) | 源码已实现，待人工验收 |
| RI14 | 目录隐藏暂停并在恢复时单飞刷新；历史展开才读取，折叠保留缓存 | [DirectoryTree.tsx](../src/components/DirectoryTree.tsx) | 源码已实现，待人工验收 |
| RI15 | 后端报告每页8条摘要/总数，点击单独读取正文，隔离会话迟到结果 | [storage.py](../engine/ai_proxy_engine/storage.py) | 源码已实现，待人工验收 |
| RI16 | schema6迁移Compose历史到索引表，每页20条摘要；状态/列表受限后台读取 | [storage.py](../engine/ai_proxy_engine/storage.py) | 源码已实现，待人工验收 |
| RI17 | 有界根任务链解析，续查继承原问题摘要并标父Run/次数；断链明确回退 | [storage.py](../engine/ai_proxy_engine/storage.py) | 源码已实现，待人工验收 |
| RI18 | 无Provider提示本地命令仍可用；普通模型发送继续引导配置 | [AIWorkspace.tsx](../src/components/AIWorkspace.tsx) | 源码已实现，待人工验收 |

## 使用与边界

- 快照恢复先显示原选择缺失、样本版本与引用差异，确认才新建可能收费的Run；不会把缺失的手选范围扩大为全部筛选。全部缺失或场景已删除时，可调整范围并复制根任务问题。
- 上下文刷新保留未保存设置；先保存预算/窗口再预览。预览来源指纹包含数据库修订（请求、场景、Provider、规则、配置和历史）、项目路径、会话、Provider及预算/窗口。前端来源变化立即标旧，另每5秒只读核对；隐藏/恢复也标旧。变化可能在下次核对才被发现，点击预览期间会前后核验。字节估算不是精确Token或真实Usage。
- 密钥查看10秒等待、30秒显示上限，并受失焦/隐藏/关闭/切账户保护。继续使用权限0700/0600的本地明文文件，不读取旧Keychain；同用户进程仍可能读取。
- 目录每次定位最多25秒、64层、1万展开行；超限或失败可收起、缩小范围、重试或切逐请求视图。隐藏窗口不做周期刷新。
- Compose保留1–20次、并发1–3、整组5–60秒。状态连续3次读取失败或整组发送时限加30秒宽限后停止自动等待，界面保留结果未知与手动核对，不重发。单次状态读取仍有统一RPC上限；停止不能撤销已到服务端的请求。
- 代理抓包保存单独区分saved/pending/failed/unknown；30秒仍不能确认则unknown，可重查，绝不补发或造第二条抓包。已完成表示动作收到响应，HTTP错误另计，不代表业务成功。
- schema从5升为6，沿用迁移前SQLite备份与失败恢复。旧replay-job设置仅迁移一次至compose_jobs，之后索引查询每页20组摘要；审计动作保留。列表/状态读取最多2个后台任务，SQLite锁等待仍有限。旧reports.list兼容接口保留，AI历史与工单报告选择器已改报告摘要分页，QA目录只读标题元数据。
- 常驻代理每秒检查长间隔（>15秒）或墙钟/单调时钟差异，状态读取也检查。检测睡眠/时钟变化/长调度暂停时使配对失效、关闭旧客户端连接并保留来源许可。外层仍单独显示监听状态，必须重新验证手机/目标App；IP不是身份或在线证明。短于检测阈值且时钟未出现差异的暂停不作绝对检测承诺。
- Run/报告页码绑定成功返回的数据，加载或失败保留旧页；分析记录展开才读。根任务链最多64层，断链回退实际当前输入，不编造原问题。

## 人工验收保留

VA01快照与原问题、VA02真实上下文/命令/停止、VA03真实凭据显隐、VA04目录定位、VA05真实工具审批与副作用、VA06手机分层连接与睡眠、VA07长历史/报告分页、VA08窄窗/低高度/200%字体。

本轮未启动应用/sidecar/代理，未调用Provider或产品Shell/网络发送工具，未创建或运行测试套件，未读取实际凭据，未安装覆盖Applications，未提交或推送。上一轮Applications包不会随源码或构建目录自动更新。原TODO保留。

## Applications后续更新

用户随后授权自动替换，本轮新版已安装至`/Applications/AI Proxy.app`并复核签名/指纹，旧包保留备份；未启动。上文“未安装”描述的是开发交付时刻。后续按[安装偏好](development.md)自动替换，运行中延后。
