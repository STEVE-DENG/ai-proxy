# 构建与发布

[返回 README](../README.md) · [安装](install.md) · [开发指南](development.md) · [验收记录](validation.md)

当前准备版本为`0.2.0`开发预览。包已生成、GitHub流程已编写、GitHub流程已运行、Release已公开是四个独立状态，不能混用。实际执行结果见验收记录。

## 一条命令准备本机产物

```bash
npm ci
npm run engine:sync
npm run release:prepare
```

命令冻结锁定Python引擎、构建Tauri，再按实际架构生成`release/0.2.0/macos-arm64/`或`macos-x64/`。仅准备本地产物，不推送Git、创建tag、上传或启动应用。已有输出目录拒绝覆盖，避免同一版本的指纹被无声替换。

已经成功构建且源码未变化时可运行`npm run release:prepare -- --skip-build`。冻结时先记录Python源码/锁文件/架构与sidecar指纹，构建前验证；构建记录再绑定界面源码/图标/配置/锁文件与主程序、sidecar指纹，任何不一致拒绝准备。`npm run version:set -- 0.2.1`同步七份版本清单/锁文件；依赖版本不变。更新版本后还应补对应`docs/release-notes-版本.md`。

每个架构产物包含：

- 版本/架构命名的DMG和ZIP。DMG带Applications快捷方式；无需另装Python、Node、Rust或uv。
- `SHA256SUMS`及带版本/架构前缀的副本，便于同时附到Release。
- `build.json`：版本、实际架构、commit、脏工作树标记、源码/二进制指纹、签名/公证事实及待验收状态。
- 安装说明、项目许可证、收集的npm/Python/当前Rust目标图许可证与缺失文本清单。补充上游文本带版本、来源和校验摘要；仅有许可概述时仍保留review标记，不假装已覆盖全部分发义务。

签名验证和DMG完整性检查在准备时执行。zip/DMG中不包含工作区、用户数据、模型凭据或开发环境；打包输入仅为应用与发行说明。

## GitHub手动流程

`.github/workflows/release.yml`只由`workflow_dispatch`启动，不因普通push/PR发布。分别使用macos-15/arm64和macos-15-intel构建；主程序与sidecar的实际架构必须一致。当前仅本机arm64构建有执行记录，不能因为有矩阵就声称Intel可用。

默认产物留在Actions artifacts。`draft_release=true`时，需两边构建均成功、干净checkout和指纹校验通过，才创建`v版本`的**草稿预发行**；附DMG/ZIP、校验文件与构建信息，永不自动公开。Git提交、推送、触发远端流程和公开发行按用户授权处理；本轮没有执行这些动作。

GitHub要求手动流程先存在于默认分支，才能从Actions面板启动。见[官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。[Runner架构](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)不是实机验收结果。

## Developer ID与公证

本地默认沿用ad-hoc签名，不会从用户机器读取签名身份。当前没有完成正式公证，跨机Gatekeeper核准和“直接使用”要求仍未关闭。

有维护者Apple Developer凭据时，流程`notarize=true`使用仓库Secrets：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）、`APPLE_TEAM_ID`。脚本只在临时CI runner导入Apple签名证书并退出清理；这不改变产品的Provider密钥本地明文文件方案。

正式模式启用hardened runtime，并要求有效签名、已装订公证票据和许可证文本review无缺口，否则失败。凭据不可提交或贴进Issue/聊天。具体机制见[Tauri macOS签名与公证](https://v2.tauri.app/distribute/sign/macos/)。流水线源码存在不代表Apple已接受提交；签名后的Python解包/动态库和另一台干净Mac仍需运行验收。

## 本机更新

成功构建后，按用户偏好运行`npm run app:install`。脚本先核对来源指纹与深度签名，检查进程；运行中延后，不kill或覆盖。停止时先stage并验证，再保留旧`.app`备份、替换和复核；失败尝试回滚，结果写入`src-tauri/target/install-report.json`，不启动应用。CI分发构建不执行本机安装。

升级前正常退出并备份完整应用数据目录，SQLite迁移备份不包含全部正文/CA/本地凭据。未知写结果仍需核对，升级后不会自动重发。
