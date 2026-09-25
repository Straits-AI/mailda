#!/usr/bin/env bash
# Mailda, installed as one conversation.
#
#   curl -fsSL https://mailda.site/install.sh | bash
#
# macOS, Linux, WSL and Git Bash. It checks for git and Node 22, enables pnpm through corepack, clones the
# repository into ./mailda (or uses the clone it is run from), installs, and hands over to `mailda install`,
# which signs you in to Cloudflare, picks the account, deploys, claims the Node, asks which domain it should
# receive at, and sets up receiving, sending and delivery outcomes with that same sign-in, so the Node
# receives when this ends. Nothing in your Cloudflare account changes before it asks.
# Later, `curl -fsSL https://mailda.site/update.sh | bash` in the same directory pulls the release, backs the
# Node up, and redeploys through the canary; `pnpm mailda upgrade` is the same from the clone.
set -euo pipefail

say() { printf '\n%s\n' "$*"; }
die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

# A missing tool is named with the one command that installs it on this machine, found by which package
# manager is here. Printed, not run: a script read off the network does not install system software on your
# behalf, and most of these commands ask for your password. Re-run afterwards.
installer() {
  if command -v brew >/dev/null 2>&1; then echo "brew install $1"
  elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y $2"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y $2"
  elif command -v winget >/dev/null 2>&1; then echo "winget install $3"
  else echo "see $4"; fi
}
command -v git >/dev/null 2>&1 || die "git is needed. Install it, then re-run:
  $(installer git git Git.Git https://git-scm.com/downloads)"
command -v node >/dev/null 2>&1 || die "Node.js 22 or later is needed. Install it, then re-run:
  $(installer node nodejs OpenJS.NodeJS.LTS https://nodejs.org/en/download)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || die "Node.js $(node -v) is too old; 22 or later is needed. Update it, then re-run:
  $(installer node nodejs OpenJS.NodeJS.LTS https://nodejs.org/en/download)"

if ! command -v pnpm >/dev/null 2>&1; then
  say "== enabling pnpm through corepack"
  if ! command -v corepack >/dev/null 2>&1; then
    die "corepack is not on this machine's Node.js, so pnpm cannot be enabled. Install it, then re-run:
  npm install -g corepack"
  fi
  corepack enable 2>/dev/null || die "pnpm is needed and corepack could not enable it. Install it, then re-run:
  npm install -g pnpm@10"
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

# pnpm's "update available" box is about pnpm, not this Node, and reads as something to act on. It is not.
export npm_config_update_notifier=false
say "== installing dependencies"
pnpm install --frozen-lockfile

# A pipe is not a terminal, and `mailda install` asks questions: reattach stdin to the terminal.
if [ -t 0 ]; then
  exec pnpm --silent mailda install "$@"
else
  exec pnpm --silent mailda install "$@" < /dev/tty
fi
