# 手动体验用合成数据

这些文件不含真实账户、凭据或业务流量，使用 `demo.invalid`，供本地手动导入和阅读。它们不是自动化测试套件，也不是真实 Provider/代理验收结果。

| 文件 | 内容 |
| --- | --- |
| [capture.har.json](capture.har.json) | 3条合成 GET：200、200、500；业务码0/0/5001；带 W3C Trace Header |
| [openapi.json](openapi.json) | 对应 `/api/items` 的 OpenAPI 3 JSON 定义 |
| [otlp-traces.json](otlp-traces.json) | 同一 Trace 的 parent/child，以及跨 Trace Link，共3 Span |

## 不调用模型的体验流程

1. 手动打开应用，建议新建独立示例项目。无需启动系统代理或真实抓包。
2. 从导入入口选择 `capture.har.json`，确认新批次包含3条记录；观察200/500响应和 `/code`、`/data/items` 字段。
3. 在工作台导入 `openapi.json`，对所选请求执行契约校验，查看支持子集与未检查项。当前参数类型校验并非完整 OpenAPI 实现，规范导入不代表所有关键词均执行。
4. 导入 `otlp-traces.json`，在相关 Trace/瀑布入口查看 parent 和 Link。合成关联不证明真实服务因果关系。
5. 通过步骤、人工清单、对比或报告入口继续体验；需要模型时由你显式配置 Provider 并确认发送范围。

`.invalid` 是示例目标，不提供可用服务。不要把重放失败当作产品的真实业务响应；如果要体验发送，请在测试环境显式修改到自己控制的目标。不要在示例文件中补入实际密钥后提交。
