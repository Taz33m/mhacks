#!/bin/zsh
set -euo pipefail

# Prefer the separately installed native runtime over an incompatible Intel CLI.
task_ollama_bin="${LIFELINE_OLLAMA_BIN:-$HOME/Library/Application Support/LIFELINE/Ollama/v0.35.1/ollama}"
if [[ ! -x "$task_ollama_bin" && -z "${LIFELINE_OLLAMA_BIN:-}" ]]; then
  task_ollama_bin="$(command -v ollama || true)"
fi
if [[ -z "$task_ollama_bin" || ! -x "$task_ollama_bin" ]]; then
  print -u2 "Install a compatible Ollama runtime or set LIFELINE_OLLAMA_BIN to its executable."
  exit 1
fi

# This foreground process exits when stopped; it never installs a restart job.
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_NO_CLOUD=1
exec "$task_ollama_bin" serve
