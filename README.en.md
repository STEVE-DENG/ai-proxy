# AI Proxy

A local HTTP(S) debugging proxy and AI-assisted QA workbench for macOS.

[中文](README.md) · [Feature reference](docs/features.md) · [Development](docs/development.md) · [Validation status](docs/validation.md)

Inspect captured traffic, investigate a fixed set of requests with an AI agent, follow field-level evidence, reproduce requests, compare successful baselines, and hand off redacted reports. Capture and local inspection run on your Mac. AI analysis requires a provider you configure.

## Status

**Early development preview, version 0.1.0.** Local builds, packaging, isolated checks, desktop launch, and project-switch confirmation have been checked. Live provider behavior, sustained capture, multiple devices, and the complete desktop acceptance checklist remain pending. Code implementation is not the same as product acceptance.

The current macOS bundle is ad-hoc signed and not notarized. Apple Silicon was checked locally; Intel Mac remains unverified. Windows and Linux desktop functionality is not supported.

## Capabilities

- HTTP(S) capture, Host/path trees, virtual lists, filters, on-demand body access and JSON Pointer.
- Scoped AI investigations with version checks, tool history, budgets, stop/continue, evidence and reports.
- Map Local/Remote, rewrite, bandwidth/latency controls, previewed changes and restore.
- Edited request replay, variable-based steps, baselines, fault matrices and editable manual checklists.
- Separate project data, HAR import/export, a declared OpenAPI/Swagger JSON validation subset and OTLP JSON import.
- Redacted evidence packages; provider API keys stored in macOS Keychain.

The agent is read-only by default. Debug writes require a preview and approval; automatic execution skips subsequent approvals. Replay sends real requests directly, without proxy rules, throttling, retries or redirect following. Existing HTTP MCP/Webhook scaffolding is not a complete standards-compliant MCP client or a validated platform integration.

## Run from source

Prerequisites: macOS, Xcode Command Line Tools, Node.js 22+, Rust stable and `uv`. The engine requires Python 3.12, which `uv` can manage.

```bash
git clone https://github.com/STEVE-DENG/ai-proxy.git
cd ai-proxy
npm ci
npm run engine:sync
npm run engine:freeze
npm run tauri dev
```

On a fresh checkout, freeze the sidecar once before Tauri's build-time binary checks. Debug mode then prefers Python source in `engine/.venv`. `npm run dev` alone only serves the frontend and does not provide desktop IPC.

## Build a macOS bundle

```bash
npm run engine:freeze
npm run app:build
```

Output: `src-tauri/target/release/bundle/macos/AI Proxy.app`. The sidecar targets the build machine's architecture. See [release guidance](docs/releasing.md) before distribution.

## Data and trust

To explore local inspection without a provider or proxy, manually import the [synthetic HAR, OpenAPI and OTLP samples](examples/README.md).

Use the proxy only on devices and environments you are authorized to inspect. HTTPS requires installing and trusting the generated CA; all-domain decryption is enabled by default and can be disabled. Remove device proxy settings and unnecessary CA trust after use.

Raw traffic is stored locally and may contain secrets. AI analysis sends redacted context to your configured provider; heuristic redaction can miss private free text. Raw HAR/body exports keep original content. See [SECURITY.md](SECURITY.md) for the trust model, storage boundaries and vulnerability reporting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), [troubleshooting](docs/troubleshooting.md) and [the implementation roadmap](docs/roadmap.md). The detailed guides are currently in Chinese; English documentation improvements are welcome.

The project currently uses build checks, isolated manual checks and human acceptance rather than an automated test suite. CI does not call live providers or start a system proxy.

## License

Original project code is licensed under [MIT](LICENSE). Dependencies, bundled fonts and build tools retain their own licenses.
