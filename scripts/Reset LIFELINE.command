#!/bin/zsh
cd -- "${0:A:h}/.." || exit 1
node scripts/reset-run.ts
