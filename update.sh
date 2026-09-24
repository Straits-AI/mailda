#!/usr/bin/env bash
# Mailda, updated as one conversation.
#
#   curl -fsSL https://mailda.site/update.sh | bash
#
# Run it where the install left the clone: in that directory, or one above it (the install makes ./mailda).
# It checks the same tools the installer did, then hands over to `mailda upgrade`, which pulls the release,
# takes a backup of the Node, lists what the schema will do to the catalog, and deploys through the canary.
# No git command is yours to type: a clone made by the deploy button, which has no history, is merged here
# too. Nothing in your Cloudflare account changes before it asks.
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

if [ -f package.json ] && grep -q '"mailda"' package.json 2>/dev/null && [ -d packages/cli ]; then
  here="$(pwd)"
elif [ -d mailda/packages/cli ]; then
  here="$(pwd)/mailda"
else
  die "no Mailda clone here. Run this in the directory the install made (./mailda), or install first:
  curl -fsSL https://mailda.site/install.sh | bash"
fi
cd "$here"
say "== updating the clone at $here"

# The CLI has to be runnable before it can pull; `mailda upgrade` installs again after the pull.
pnpm install --frozen-lockfile

# A pipe is not a terminal, and `mailda upgrade` asks questions: reattach stdin to the terminal.
if [ -t 0 ]; then
  exec pnpm --silent mailda upgrade "$@"
else
  exec pnpm --silent mailda upgrade "$@" < /dev/tty
fi
