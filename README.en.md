# AI Proxy

![AI Proxy concept illustration](docs/media/workflow-illustration.png)

A local HTTP(S) debugging proxy and AI-assisted QA workbench for macOS.

[中文](README.md) · [Feature reference](docs/features.md) · [Development](docs/development.md) · [Validation status](docs/validation.md)

Inspect captured traffic, investigate a fixed set of requests with an AI agent, follow field-level evidence, reproduce requests, compare successful baselines, and hand off redacted reports. Capture and local inspection run on your Mac. AI analysis requires a provider you configure.

## Status

**Early development preview, version 0.2.0.** Local builds, packaging, isolated checks, desktop launch, and project-switch confirmation have been checked. Live provider behavior, sustained capture, multiple devices, and the complete desktop acceptance checklist remain pending. Code implementation is not the same as product acceptance.

The current macOS bundle is ad-hoc signed and not notarized. Apple Silicon was checked locally; Intel Mac remains unverified. Windows and Linux desktop functionality is not supported.

## Capabilities

- HTTP(S) capture, Host/path trees, virtual lists, filters, on-demand body access and JSON Pointer.
- Scoped AI investigations with version checks, tool history, budgets, stop/continue, evidence and reports.
- Map Local/Remote, rewrite, bandwidth/latency controls, previewed changes and restore.
- Edited request replay, variable-based steps, baselines, fault matrices and editable manual checklists.
- Separate project data, HAR import/export, a declared OpenAPI/Swagger JSON validation subset and OTLP JSON import.
- Redacted evidence packages; provider API keys stored in a local credentials file (0700 directory / 0600 file), reused without Keychain prompts.

The agent is read-only by default. Debug writes require a preview and approval; automatic execution may skip existing rule/throttle approvals, while the new shell, proxy/device management and batch replay tools always require explicit approval. Compose supports direct or explicitly selected local-proxy routing. Fixed previews require approval; sends have bounded counts/concurrency and do not automatically retry unknown outcomes. Existing HTTP MCP/Webhook scaffolding is not a complete standards-compliant MCP client or a validated platform integration.

## Install

Use the matching architecture asset from [Releases](https://github.com/STEVE-DENG/ai-proxy/releases) when published. Drag the app from the DMG into Applications; the Python sidecar is bundled. Local build artifacts are not an uploaded Release. Ad-hoc previews can require macOS security approval. Developer ID, notarization and clean-machine acceptance remain pending.

Light, dark and system appearance, a consistent keyboard-driven selector, startup phases and on-demand workbench loading are included in this source round. See [current completion tracking](docs/completion-tracker.md), [installation](docs/install.md) and [0.2.0 notes](docs/release-notes-0.2.0.md). These changes do not close unresolved user TODOs.

![Local data and permission boundaries](docs/media/architecture.svg)

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

Use the proxy only on devices and environments you are authorized to inspect. HTTPS requires installing and trusting the generated CA; new projects start with HTTPS decryption disabled; existing projects retain their saved policy. Remove device proxy settings and unnecessary CA trust after use.

Raw traffic is stored locally and may contain secrets. AI analysis sends redacted context to your configured provider; heuristic redaction can miss private free text. Raw HAR/body exports keep original content. See [SECURITY.md](SECURITY.md) for the trust model, storage boundaries and vulnerability reporting.

## UX and credentials update

Provider keys now use `~/Library/Application Support/com.nekoya.ai-proxy/credentials/auth.json`. The file is plaintext and accessible to other processes running as the same user. Previously saved Keychain keys are neither read nor migrated automatically: enter each key once in Settings to use the new storage. Removing the app does not remove this file. Complete data-root backups include it; evidence packages do not. CA certificate trust remains a separate system/device setting.

The update adds window/panel resizing, larger text and density controls, a searchable help guide, LAN address permissions and separate direct/HTTP/HTTPS diagnostics, retained drafts, readable Markdown and QA results, and provider/tool cache statistics. Live desktop, phone and provider acceptance remains pending. See the [48-item UX status](docs/ux-status.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), [troubleshooting](docs/troubleshooting.md) and [the implementation roadmap](docs/roadmap.md). The detailed guides are currently in Chinese; English documentation improvements are welcome.

The project currently uses build checks, isolated manual checks and human acceptance rather than an automated test suite. CI does not call live providers or start a system proxy.

## License

Original project code is licensed under [MIT](LICENSE). Dependencies, bundled fonts and build tools retain their own licenses.


Storage settings include an explicit health check using isolated temporary files and read-only database access. Capture settings persist separate total and stream idle deadlines (5–3600 seconds); changing HTTP/2 requires stopping the proxy. Shared HTTP/2 transports can still interrupt sibling streams on timeout. The task panel distinguishes read timeouts from unknown write receipts. Run history can compare existing usage and latency metadata without calling a provider; missing metrics remain unknown. These additions require manual desktop, device and provider acceptance.

The latest [RF01–RF56 delivery map](docs/problem-fixes-status.md) covers original-task snapshot recovery, structured errors, local commands, input estimates, paginated history and layered connection evidence. Compose supports blank requests or captured sources, direct/local-proxy routing and bounded repeat (20 sends, concurrency 3, 60 seconds per group). Confirm the fixed group before sending; uncertain outcomes never retry automatically. Source/build checks do not replace manual acceptance.

The historical [checklist audit](docs/checklist-audit.md) maps the historical119/49/60 items and eight new fixes to source. New controls include optional directory folding, stable completed-request scopes, context settings and local `/compress`, explicit temporary key reveal, a main-window device panel, approved proxy/phone tools, Compose/Repeat and a bounded local shell. Shell uses the current user account and is not sandboxed; no real Provider or device acceptance is claimed.
