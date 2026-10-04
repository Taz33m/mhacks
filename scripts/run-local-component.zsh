#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"

# One foreground component, launched in its own session by the local runner.
# No launchd job or automatic restart. A duplicate invocation exits harmlessly.
case "${1:-}" in
  backend)
    if /usr/sbin/lsof -nP -iTCP:8877 -sTCP:LISTEN >/dev/null 2>&1; then exit 0; fi
    exec node --env-file-if-exists=.env src/server.ts
    ;;
  wili)
    if /usr/sbin/lsof /dev/cu.usbmodem1201 >/dev/null 2>&1; then exit 0; fi
    exec node --env-file-if-exists=.env native/freewili/stock-bridge.ts --port /dev/cu.usbmodem1201 --reconnect
    ;;
  ai)
    if /usr/sbin/lsof -nP -iTCP:11434 -sTCP:LISTEN >/dev/null 2>&1; then exit 0; fi
    exec /bin/zsh scripts/start-local-ai.sh
    ;;
  *) print -u2 'Usage: run-local-component.zsh backend|wili|ai'; exit 2 ;;
esac
