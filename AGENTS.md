# Repository Guidelines

## Project Structure & Module Organization

`src/` contains React 19/TypeScript components, shared types, and CSS; route desktop calls through `src/lib/api.ts`. `src-tauri/` hosts Rust/Tauri 2 IPC, credentials, system proxy management, and icons in `icons/`. Python 3.12 domain logic, SQLite storage, capture, Agent tools, and QA workflows live in `engine/ai_proxy_engine/`. Build helpers, guides, and synthetic fixtures live in `scripts/`, `docs/`, and `examples/`.

## Build, Test, and Development Commands

Requires macOS, Xcode tools, Node 22+, Rust, uv.

- `npm ci`: install locked frontend dependencies.
- `npm run engine:sync`: install locked Python dependencies.
- `npm run engine:freeze`: build the sidecar required by Tauri.
- `npm run build`: type-check TypeScript and bundle the frontend.
- `npm run tauri dev`: launch the complete desktop development app, only when explicitly requested. `npm run dev` runs frontend Vite alone.
- `npm run app:build`: package the macOS application after freezing the engine.
- `engine/.venv/bin/python -m compileall -q engine/ai_proxy_engine`: check Python syntax.
- From `src-tauri/`, run `cargo fmt --check` and `cargo check --locked`; run `git diff --check` at the root.

## Coding Style & Naming Conventions

Follow existing conventions: two-space TypeScript/CSS indentation, four-space Python/Rust indentation, React function components, PascalCase component files, and snake_case Python modules/functions. Preserve Python type annotations; format Rust with rustfmt. Keep native permissions in Rust and domain behavior in Python. Update dependency lockfiles together. Engine stdout carries RPC/events only; diagnostics belong on stderr.

## Testing Guidelines

This repository currently uses build/static checks and documented manual acceptance, without an automated test suite or coverage target. Do not introduce or run test suites. Record checks and manual scenarios in `docs/validation.md`. Compilation is not functional acceptance. Do not automatically launch the app, proxy, or real Provider during development.

## Commit & Pull Request Guidelines

History uses `feat:`, `fix:`, and `docs:` prefixes; `chore:` is also accepted. Keep PRs focused; describe behavior, related issues, validation, migrations, and limitations. Use sanitized UI screenshots and the PR template; see `CONTRIBUTING.md`. Commit and push require explicit authorization. After successful packaging/signature checks, replace `/Applications/AI Proxy.app` with a backup; defer while running. Do not launch automatically.

## Security & Agent Workflow

Work as a single agent unless authorized otherwise. Preserve unrelated changes. Never inspect real API credentials or old Keychain entries. Local credentials are intentionally plaintext with directory/file permissions 0700/0600. Keep Scope/version checks, redaction, approvals, bounded waits, and unknown-outcome records; never automatically resend uncertain writes. Update affected documentation and retain pending user acceptance items.

## TODO Completion

Do not archive or delete unfinished TODOs. Source implementation and successful builds do not establish completion. Keep unresolved and unverified items open; retain unfinished portions of mixed TODOs. Close only with documented evidence satisfying the requirements or explicit user confirmation of completion.
