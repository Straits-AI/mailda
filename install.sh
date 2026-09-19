#!/usr/bin/env bash
# Mailda, installed as one conversation.
#
#   curl -fsSL https://mailda.site/install.sh | bash
#
# macOS, Linux, WSL and Git Bash. It checks for git and Node 22, enables pnpm through corepack, clones the
# repository into ./mailda (or uses the clone it is run from), installs, and hands over to `mailda install`,
# which signs you in to Cloudflare, picks the account, deploys, and opens your Node with its claim secret.
# Nothing in your Cloudflare account changes before that last step asks.
set -euo pipefail

say() { printf '\n%s\n' "$*"; }
die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is needed. https://git-scm.com/downloads"
command -v node >/dev/null 2>&1 || die "Node.js 22 or later is needed. https://nodejs.org/en/download"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || die "Node.js $(node -v) is too old; 22 or later is needed. https://nodejs.org/en/download"

if ! command -v pnpm >/dev/null 2>&1; then
  say "== enabling pnpm through corepack"
  corepack enable 2>/dev/null || die "pnpm is needed and corepack could not enable it. https://pnpm.io/installation"
fi

if [ -f package.json ] && grep -q '"name": "mailda"' package.json 2>/dev/null; then
  here="$(pwd)"
else
  here="$(pwd)/mailda"
  if [ -d "$here/.git" ]; then
    say "== using the clone at $here"
  else
    say "== cloning into $here"
    git clone --depth 1 https://github.com/Straits-AI/mailda.git "$here"
  fi
fi
cd "$here"

say "== installing dependencies"
pnpm install --frozen-lockfile

# A pipe is not a terminal, and `mailda install` asks questions: reattach stdin to the terminal.
if [ -t 0 ]; then
  exec pnpm --silent mailda install "$@"
else
  exec pnpm --silent mailda install "$@" < /dev/tty
fi
