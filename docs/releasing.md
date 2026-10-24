# 构建与发布

[返回 README](../README.md) · [开发指南](development.md) · [人工验收](validation.md)

当前仓库提供源码和本地构建流程，版本为 `0.1.0`，尚未以本次功能变更声明稳定版发布。`.app` 为当前 Mac 架构、ad-hoc 签名且未公证。

## 本地构建

在 macOS 安装 [开发依赖](development.md) 后：

```bash
npm ci
npm run engine:sync
npm run engine:freeze
npm run app:build
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/AI Proxy.app"
```

冻结步骤用锁定依赖和当前 Python 源码生成 sidecar。只有运行 `app:build` 不会自动重建 Python sidecar，因此 Python 修改后必须先重新冻结。检查成功只证明包结构/签名可验证，不证明 Gatekeeper 接受，也不证明功能验收。

当前已检查 arm64 本机构建；Intel Mac 或 universal 分发需分别验证 Python 依赖、sidecar、Rust target 和目标机器，不能把一个架构产物改名当作另一个。

## 发布前维护者清单

1. 记录精确 commit、依赖锁文件和构建环境，确认工作树干净；完成对应 [人工验收](validation.md)，列出未覆盖和支持平台。
2. 如果发布新版本，同步 `package.json`/`package-lock.json`、`src-tauri/Cargo.toml`/`Cargo.lock`、`src-tauri/tauri.conf.json`、`engine/pyproject.toml`/`uv.lock` 的版本，再构建验证。
3. 检查包内无开发者数据、抓包、私钥、API Key 和本地绝对路径依赖；携带项目 MIT 文本及所分发依赖、字体和运行时的许可证/归属信息。
4. 对外分发需配置维护者的 Developer ID 签名、hardened runtime、所需权限和 Apple 公证，验证内部 sidecar 及干净目标机器行为。仓库目前不提供这些凭据或已验证的正式签名流水线。
5. 按实际架构命名压缩包，生成 SHA-256，准备发布说明：版本/commit、支持系统、升级迁移/备份、已知问题、签名/公证状态与验收记录。
6. 维护者确认发行范围后创建 tag/Release，附可验证产物。Git 提交、推送或新增 CI 都不自动创建公开发行版。

打包时保留 `.app` 符号链接与权限，可在 macOS 使用：

```bash
ditto -c -k --keepParent "src-tauri/target/release/bundle/macos/AI Proxy.app" AI-Proxy-macos-arm64.zip
shasum -a 256 AI-Proxy-macos-arm64.zip
```

示例文件名适用于实际 arm64 包；执行前按构建架构调整。仓库忽略构建目录，不把二进制或业务验收数据提交到源码历史。

升级前应在正常退出后备份完整应用数据目录，schema迁移备份不包含全部正文/证书；参见 [数据布局](architecture.md#数据布局与备份)。未知结果的写操作仍需人工核对，不能在升级后自动重发。
