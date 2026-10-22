# AI Proxy

一个本地 macOS HTTP(S) 调试代理。应用包含 Codex 式 AI 工作区、Charles 式抓包树、Map Local、Map Remote、Rewrite、代理弱网和手机接入，不需要单独部署服务端。

## 技术结构

- `src/`：React + TypeScript 界面。
- `src-tauri/`：Tauri 2 桌面层、Keychain、文件选择器和 macOS 系统代理。
- `engine/`：Python 本地引擎，使用 mitmproxy、PydanticAI 和 SQLite。
- 前端与引擎通过 Rust 管理的私有 stdin/stdout 消息通信；手机端口只提供代理和证书引导。

## 本地开发

要求：macOS、Node.js、Rust、`uv`。

```bash
npm install
npm run engine:sync
npm run tauri dev
```

开发模式优先使用 `engine/.venv/bin/python` 启动引擎，不依赖已冻结的 sidecar。

## 打包

```bash
npm run engine:freeze
npm run app:build
```

输出位置：

```text
src-tauri/target/release/bundle/macos/AI Proxy.app
```

`engine:freeze` 会生成当前 Mac 架构的 PyInstaller 单文件引擎，并原子替换 `src-tauri/binaries/` 中的 sidecar。当前配置使用 ad-hoc 签名且未公证，适合本机使用；对外分发需要 Developer ID 签名和 Apple 公证。

## 使用

### 本机抓包

1. 打开「抓包」，点击「开始抓包」。
2. 在「设置 → 抓包与代理」中开启本机系统代理，按 macOS 提示完成管理员授权。
3. 请求会按 Host / Path 显示；重复 URL 会保留为独立请求。
4. 退出应用会尝试恢复开启前的系统代理。强制结束进程时不保证立即恢复，可在系统设置中手动关闭。

### 手机接入

1. 手机与 Mac 连接同一 Wi-Fi，打开「连接手机」，点击「开启手机 HTTPS 抓包」。
2. 用手机浏览器扫描证书二维码并打开局域网证书页。iOS 安装 `.mobileconfig` 描述文件；Android 下载 `.crt` CA 证书。
3. iOS 还需到「设置 → 通用 → 关于本机 → 证书信任设置」开启完全信任；Android 需在系统设置中安装用户 CA。
4. 在手机当前 Wi-Fi 的 HTTP 代理中填写页面显示的 Mac IP 和端口，然后重新打开目标 App。
5. 抓包结束后关闭手机 Wi-Fi 代理。

Mac 和手机都必须信任本应用生成的 CA。HTTPS 默认开启全部域名解密；抓包工具栏和「连接手机」中都可以一键关闭。关闭后仍会记录 HTTPS 的 CONNECT 连接，可在 Host 节点单独重新开启该域解密。解密设置只影响新连接。

### Agent

在设置中配置 OpenAI Responses、OpenAI Chat Completions 或 Anthropic Messages 供应商。API Key 保存在 macOS 钥匙串，不写入 SQLite、对话或抓包记录。

Agent 只能调用应用提供的抓包、规则、弱网和系统代理工具。修改配置前默认请求审批；开启「自动执行」后本会话后续配置操作直接执行。Map Local 只能使用当前会话中由用户主动共享的文件。

### 弱网

弱网限制作用于经过本代理的所有本机和手机流量，上下行共享全局预算。它不修改系统网卡，也不模拟丢包。

## 已知边界

- 首版重点支持 HTTP/1.1 和 HTTP/2；WebSocket 可转发并显示握手，不提供帧级编辑。
- 不支持 HTTP/3/QUIC、原始 TCP/UDP、gRPC 解码。
- Android 7+ 的正式 App 可能不信任用户 CA；证书固定的 App 无法仅靠代理获取明文。
- 设备未信任 CA 时不能解密 HTTPS；请先在证书页完成安装和完全信任。
- 流式或超过 5 MiB 的正文只保留有限记录，不会执行整段正文替换。
- 抓包内容可能包含隐私数据。模型分析时会对常见认证 Header 脱敏，但不会自动移除业务正文中的敏感信息。
