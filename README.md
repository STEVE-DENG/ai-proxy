# AI Proxy

本地 HTTP(S) 抓包、AI 调查与 QA 复现工作台，面向 macOS。

[English](README.en.md) · [使用指南](docs/user-guide.md) · [完整功能](docs/features.md) · [开发指南](docs/development.md) · [实施状态](docs/roadmap.md)

把抓包树、固定范围的 AI Agent、字段证据、请求重放、故障矩阵和缺陷报告放在同一个桌面应用里。抓包和本地分析无需部署服务端；AI 分析需配置你自己的模型供应商。

> **开发预览，版本 0.1.0。** 已完成本地构建、打包和部分功能核查；真实 Provider、持续采集、多设备与完整桌面验收仍待手动完成。[验收记录与未覆盖项](docs/validation.md)。当前构建为 ad-hoc 签名，未公证；不将开发产物标为稳定发行版。

## 可以用它做什么

| 场景 | 能力 |
| --- | --- |
| 排查接口 | Host/路径抓包树、时序、组合筛选、分页与虚拟列表，按需读取正文和 JSON Pointer |
| 让 AI 查证 | 固定样本与版本，调用检索/聚合/字段/Diff/Trace 工具，结论附证据与未检查范围 |
| 调试与复现 | Map Local/Remote、Rewrite、弱网，变更预览与恢复；编辑重放、变量步骤、故障矩阵 |
| 回归与交接 | 成功基线、业务键配对、可编辑人工清单，Markdown/JSON 报告与脱敏证据包 |
| 交换数据 | HAR 导入/导出、OpenAPI/Swagger JSON 子集校验、OTLP JSON Span 导入 |
| 分离项目 | 独立数据库、正文、规则、环境、场景与模型历史；API Key 存储在 macOS Keychain |

Agent 默认只读；调试模式的写操作需要预览和审批。开启自动执行会跳过后续审批，请在理解具体变更后使用。平台集成仍有边界：现有有限 HTTP MCP/Trace GET/Webhook 入口不等于标准 MCP 客户端或已完成的真实平台适配。

## 从源码运行

需要 macOS、Xcode Command Line Tools、Node.js 22+、Rust stable 和 `uv`。引擎固定使用 Python 3.12，`uv` 可管理该解释器。当前只核查过 Apple Silicon 本机产物；Intel Mac 尚待验证，Windows/Linux 暂不支持桌面功能。

```bash
git clone https://github.com/STEVE-DENG/ai-proxy.git
cd ai-proxy
npm ci
npm run engine:sync
```

Tauri 的构建配置声明了 sidecar。全新 checkout 先冻结一次引擎以满足构建期文件检查：

```bash
npm run engine:freeze
npm run tauri dev
```

开发模式运行 `engine/.venv/bin/python`，优先使用当前 Python 源码。单独 `npm run dev` 只有界面开发服务器，无法提供完整桌面 IPC 能力。详细环境、命令和排障见 [开发指南](docs/development.md)。

## 第一次使用

想先离线查看数据，可手动导入 [合成 HAR / OpenAPI / OTLP 示例](examples/README.md)，无需开启代理或调用模型。

1. 进入「抓包」，开始采集；在设置的代理入口启用本机系统代理。HTTPS 还需安装并信任应用生成的 CA。
2. 发起自己可控制的请求，在 Host/路径树中查看详情、筛选或对比。手机可从「连接手机」配置同一 Wi-Fi 下的代理和 CA。
3. 在设置中配置模型供应商，选择当前筛选、多选请求或场景发起只读分析；点击证据返回原请求。
4. 从工作台进入重放、基线回归、故障矩阵、人工验证和证据交接。重放会真实发送请求，请先核对预览。
5. 结束后停止采集，关闭手机 Wi-Fi 代理，并核对 Mac 系统代理已恢复。

HTTPS 默认解密全部域名；可以一键关闭或仅对特定 Host 开启。仅在你有权调试的设备与环境中使用。模型请求会发送脱敏后的上下文到所配置供应商，脱敏规则不能保证清除自由文本中的所有隐私。[数据与安全边界](SECURITY.md)。

## 本地打包

```bash
npm run engine:freeze
npm run app:build
```

输出：`src-tauri/target/release/bundle/macos/AI Proxy.app`。sidecar 为当前 Mac 架构，应用不需要目标机器另装 Python。分发签名、公证和验收要求见 [发布说明](docs/releasing.md)。构建目录和本地抓包数据不提交到 Git。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/user-guide.md) | CA、手机接入、分析、调试、QA 与数据交换 |
| [完整功能与边界](docs/features.md) | 功能细节、数据限额、协议与契约支持范围 |
| [架构说明](docs/architecture.md) | React → Tauri → Python、持久化、Scope 和审批 |
| [开发指南](docs/development.md) | 环境、锁文件、检查、CI 和源码导航 |
| [故障排查](docs/troubleshooting.md) | 引擎、证书、代理恢复、缺失正文与过期证据 |
| [人工验收](docs/validation.md) | 已执行检查、未验收场景和可复制记录模板 |
| [实施状态与路线图](docs/roadmap.md) | 第二轮49项状态与下一步；附第一轮119项映射 |
| [变更记录](CHANGELOG.md) | 已提交开发变化与发布边界 |

## 参与贡献

欢迎提交可复现的问题、文档修正和范围明确的 Pull Request。先阅读 [贡献指南](CONTRIBUTING.md)；普通问题使用 [GitHub Issues](https://github.com/STEVE-DENG/ai-proxy/issues)。涉及凭据、CA 私钥或原始抓包的安全问题，请使用 [安全报告流程](SECURITY.md)。

本项目当前使用构建检查、隔离数据核查和人工验收，不维护自动化测试套件。CI 不调用真实供应商、不启动系统代理，绿色检查不代表真实环境验收通过。

## 许可证

项目原创代码使用 [MIT License](LICENSE)。第三方依赖、字体和工具保留各自许可证；打包分发时也需遵守其条款。
