# 开发指南

0.2.0新增`npm run release:prepare`（本地产物）、`npm run app:install`（来源校验/备份/运行中延后）和`npm run version:set -- X.Y.Z`。`app:build`先验证冻结引擎的源码/架构/指纹，只通过Tauri的beforeBuild构建前端一次，再写来源指纹；不要手动给旧包补写来源记录。详见[分发流程](releasing.md)。

[返回 README](../README.md) · [架构说明](architecture.md) · [贡献指南](../CONTRIBUTING.md)

## 环境

| 工具 | 要求与用途 |
| --- | --- |
| macOS + Xcode Command Line Tools | 桌面、本地凭据、系统代理、Rust 链接与签名；`xcode-select --install` 安装工具 |
| Node.js 22+ / npm | TypeScript/Vite/Tauri CLI；CI 目标为 Node 22，本地已有 Node 25.6.1 构建记录 |
| Rust stable + Cargo | Tauri 宿主；本地已有 Rust 1.93.0 检查与打包记录 |
| uv | 管理 Python 3.12 与依赖；本地已有 uv 0.10.7 记录 |
| Python 3.12 | `engine/pyproject.toml` 限制 `>=3.12,<3.13`；不要用系统 Python 替代 |

以上本机记录不代表其它组合已验收。当前桌面仅面向 macOS，arm64 产物已本机构建；Intel 和跨平台适配没有完成验收。

工具安装可参考 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)、[Rust 安装](https://www.rust-lang.org/tools/install) 与 [uv 安装](https://docs.astral.sh/uv/getting-started/installation/)。

## 第一次 checkout

```bash
npm ci
npm run engine:sync
npm run engine:freeze
npm run tauri dev
```

`npm ci` 遵守 npm 锁文件。`engine:sync` 使用 `uv sync --locked --project engine`；`uv` 可按项目 Python 约束安装解释器。Tauri build script 会检查 `externalBin`，因此干净仓库需要先冻结 sidecar；debug 运行时仍优先使用 `.venv` 中的 Python 源码，不需要每次 Python 改动都重新冻结。

Vite 只监听 `127.0.0.1:1420`，完整桌面命令是 `npm run tauri dev`。`npm run dev` 只是浏览器界面预览，Tauri invoke/本地凭据/引擎 RPC 不可用。不要把 dev server 作为可用产品或对局域网暴露。

## 常用检查

在仓库根目录执行：

```bash
npm run build
uv run --locked --project engine python -m compileall -q engine/ai_proxy_engine engine/entrypoint.py
cargo check --locked --manifest-path src-tauri/Cargo.toml
git diff --check
```

首次 `cargo check` 同样需要 sidecar 文件，先运行 `npm run engine:freeze`。Python 编译只检查语法，不验证工具行为；`__pycache__` 已忽略。不要将这几条命令描述为功能测试套件。

当前项目不新增自动化测试文件/套件。功能核查用临时数据、可说明的独立操作和 [人工记录](validation.md)。不自动启动桌面、系统代理或调用真实供应商作为构建检查的一部分。

## 引擎 RPC 开发

桌面由 Rust 启动引擎。若需单独调试，只在你明确创建的隔离数据目录运行 `uv run --locked --project engine python -m ai_proxy_engine`，不要直接使用真实默认目录。

协议为一行一个 JSON，请求包含 `id`、`method` 和 `params`；响应包含 `type=response`、相同 `id`、`ok` 及 `result` 或 `error`。启动先输出 `{"type":"ready"}`，事件为 `{"type":"event","event":"...","data":{...}}`。例如只读初始化请求：

```json
{"id":1,"method":"app.bootstrap","params":{}}
```

关闭使用 `{"method":"__shutdown__"}` 或 stdin EOF。这个协议是应用内部接口，没有稳定的公共 API 兼容承诺。不要提供一个对网络开放的通用 RPC 入口。

## 依赖与构建

- npm、uv 和 Cargo 锁文件一并提交；正常同步使用 locked 模式。只有有意升级时才重新解析锁文件，并记录变化。
- `npm run engine:freeze` 使用 PyInstaller 生成单文件引擎，按 `rustc --print host-tuple` 命名，原子替换到 `src-tauri/binaries/`。
- Python 模块/动态依赖变更后需重新冻结，release 模式不会回退到源码解释器。
- `npm run app:build` 调用前端构建与 Tauri 打包；输出和 sidecar 均在 `.gitignore` 中。
- `package.json` 保持 `private: true`，用于防止误发布 npm 包；这不影响仓库使用 MIT 开源许可证。

## GitHub Actions

`.github/workflows/ci.yml` 在 push、PR 和手动触发时执行：

1. Linux job 安装 Node 22、`npm ci`、TypeScript/Vite 生产构建。
2. macOS job 构建前端资源，安装 Python 3.12/uv、锁文件同步、Python 语法检查、冻结 sidecar 和 `cargo check --locked`。

Actions 只有 `contents: read` 权限，第三方 Action 固定 commit；不使用模型 Key、Developer ID 凭据或个人业务数据，也不启动桌面和代理。CI 是编译/冻结检查，不进行签名发行，不替代 A11/D07 人工验收。新增工作流是否已在托管 runner 成功运行，需以 Actions 页面为准。

更新 Action 时参考其官方文档：[checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[setup-uv](https://github.com/astral-sh/setup-uv)，核对版本对应的 commit 后再更新。

## 开发时应同步更新

改变用户操作更新 [使用指南](user-guide.md)；改变支持范围更新 [完整功能](features.md)；改变数据/权限更新 [架构](architecture.md) 与 [安全说明](../SECURITY.md)；改变完成状态更新 [路线图](roadmap.md)、[验收](validation.md) 和 [CHANGELOG](../CHANGELOG.md)。

问题排查优先记录实际错误、数据状态和支持范围，不要通过扩大 Scope、绕过审批或丢弃失败样本来“修好”结果。


凭据实现位于 `src-tauri/src/credentials.rs`，LAN证据/许可位于 `engine/ai_proxy_engine/connections.py`，显示偏好位于 `src/lib/display.ts`。仅源码语法/构建检查不读取用户凭据。改Python后先重新冻结再打包，禁止用旧sidecar证明新代码已交付；本轮逐项记录见 [UX状态](ux-status.md)。

## RI18后续补修

贡献者入口见[Repository Guidelines](../AGENTS.md)，逐项交付见[RI01–RI18](improvement-status.md)。schema6迁移需先保留SQLite备份；失败沿用现有恢复机制，不自动降级。新只读端点agent.original-task、agent.context.identity、reports.history沿用20秒引擎/25秒界面期限；Compose列表返回items/total/offset对象，默认每页20。变更模型配置或来源后重新生成预览，未知发送不能自动重试。

## 本地安装偏好（用户已授权）

后续开发完成并通过打包与签名检查后，自动替换`/Applications/AI Proxy.app`，无须再次请求安装确认。先确认应用与引擎未运行，在Applications内暂存新包，核对签名和可执行文件SHA-256，再保留旧包备份并切换；失败恢复旧包。应用运行中则延后，不强制结束抓包/Agent或覆盖运行中的包。安装后不自动启动，不读取实际凭据，不自动调用Provider；提交/推送仍须明确授权。
