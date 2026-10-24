#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/engine"
uv sync --locked --project . --group dev
uv run --locked --project . pyinstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name ai-proxy-engine \
  --paths . \
  --collect-all mitmproxy \
  --collect-all mitmproxy_rs \
  --collect-all pydantic_ai \
  --copy-metadata genai-prices \
  --copy-metadata pydantic-ai-slim \
  --hidden-import socksio \
  --hidden-import ai_proxy_engine.app \
  entrypoint.py
TARGET="$(rustc --print host-tuple)"
mkdir -p "$ROOT/src-tauri/binaries"
DESTINATION="$ROOT/src-tauri/binaries/ai-proxy-engine-$TARGET"
cp "dist/ai-proxy-engine" "$DESTINATION.new"
chmod +x "$DESTINATION.new"
mv -f "$DESTINATION.new" "$DESTINATION"
