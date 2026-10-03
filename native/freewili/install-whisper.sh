#!/bin/zsh
# Explicit foreground model installation only. No services, STT, devices or env edits.
set -euo pipefail
script_dir="${0:A:h}"
repo_root="${script_dir:h:h}"
model_dir="${1:-$repo_root/output/freewili-runtime/whisper-models}"
if [[ "$model_dir" != /* ]]; then
  print -u2 'Use an absolute model directory.'
  exit 2
fi
model_path="$model_dir/ggml-tiny.en.bin"
model_sha='921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f'
# Official whisper.cpp downloader names this repository. Pin its verified revision.
model_url='https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin'
if [[ -f "$model_path" ]]; then
  actual_sha="$(/usr/bin/shasum -a 256 "$model_path")"
  if [[ "${actual_sha%% *}" != "$model_sha" ]]; then
    print -u2 'Existing model checksum differs; it was preserved. Choose another directory.'
    exit 2
  fi
  print 'Official tiny.en speech model is already installed and checksum verified.'
  exit 0
fi
mkdir -p "$model_dir"
download_path="$(mktemp "$model_dir/.tiny-en-download.XXXXXX")"
trap 'rm -f "$download_path"' EXIT INT TERM
/usr/bin/curl --fail --location --connect-timeout 15 --max-time 600 --silent --show-error --output "$download_path" "$model_url"
actual_sha="$(/usr/bin/shasum -a 256 "$download_path")"
if [[ "${actual_sha%% *}" != "$model_sha" ]]; then
  print -u2 'Downloaded speech model failed its pinned checksum; no model installed.'
  exit 1
fi
chmod 600 "$download_path"
mv "$download_path" "$model_path"
print 'Installed official tiny.en speech model (77.7 MB); checksum verified. Runtime configuration remains separate.'
