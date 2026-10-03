#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/../.."
task_uv="$(command -v uv || true)"
if [[ -z "$task_uv" ]]; then
  print -u2 'uv is required for the isolated FREE-WILi Python runtime.'
  exit 1
fi
"$task_uv" venv --allow-existing --python python3 output/freewili-runtime
"$task_uv" pip install --python output/freewili-runtime/bin/python -r native/freewili/requirements.txt
node native/freewili/prepare-stock-audio.ts
zsh native/freewili/install-whisper.sh
output/freewili-runtime/bin/fwi-serial --list
