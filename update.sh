#!/usr/bin/env bash
# Mailda, updated as one conversation.
#
#   curl -fsSL https://mailda.site/update.sh | bash
#
# Run it where the install left the clone: in that directory, or one above it (the install makes ./mailda).
# It checks the same tools the installer did, brings the clone up to the release, then hands over to
# `mailda upgrade`, which takes a backup of the Node, lists what the schema will do to the catalog, and
# deploys through the canary. No git command is yours to type: a clone made by the deploy button, which has
# no history and no remote, is joined to the release here too. Nothing in your Cloudflare account changes
# before it asks.
#
# The pull is here, in the script, and not left to `mailda upgrade`, which can also do it: the clone being
# updated is exactly what may be too old to know that verb. Measured 24 September 2026, when a clone from
# before the verb existed answered the hand-over with its usage text and pulled nothing.
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
# pnpm's "update available" box is about pnpm, not this Node, and reads as something to act on. It is not.
export npm_config_update_notifier=false

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

release="https://github.com/Straits-AI/mailda.git"
remote="$(git remote -v | awk '/github\.com[\/:]Straits-AI\/mailda(\.git)? \(fetch\)/ { print $1; exit }')"
if [ -z "$remote" ]; then
  git remote add upstream "$release"
  remote=upstream
  echo "   remote    upstream added: $release"
fi
git fetch --quiet "$remote" main || die "could not fetch $remote; is the network up?"

if [ -n "$(git status --porcelain)" ]; then
  die "this clone has uncommitted changes, so the release cannot be pulled over them.
  fix      commit or stash them, then re-run"
fi

if git merge-base HEAD "$remote/main" >/dev/null 2>&1; then
  if ! git merge --ff-only --quiet "$remote/main"; then
    die "this clone has its own commits, so $remote/main cannot be fast-forwarded onto it.
  fix      git merge $remote/main yourself, resolve what conflicts (package.json is the only file that
           should), then re-run"
  fi
else
  # The deploy button's first update: no history shared with the release. Merged once; the one conflict the
  # update path allows is package.json's `name`, resolved by keeping this clone's name and taking upstream's
  # everything else (`test/node/update-path.test.ts` holds package.json to being the only file).
  echo "   history   none shared with the release: merging once, as a deploy-button clone needs"
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-mailda update}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-update@mailda.invalid}"
  export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  if ! git merge --allow-unrelated-histories --quiet -m "Join this clone to the Mailda release history" "$remote/main" >/dev/null 2>&1; then
    conflicted="$(git diff --name-only --diff-filter=U)"
    if [ "$conflicted" != "package.json" ]; then
      git merge --abort
      die "the first merge conflicts in more than package.json: $(echo "$conflicted" | tr '\n' ' ')
  why      the update path allows exactly one conflict, the Worker's name in package.json; the rest is an
           edit this clone made that only its author can merge
  fix      git merge $remote/main --allow-unrelated-histories, resolve by hand, then re-run"
    fi
    name="$(git show :2:package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).name')"
    git show :3:package.json > package.json
    node -e 'const f="package.json";const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.name=process.argv[1];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$name"
    git add package.json
    git commit --quiet --no-edit
    echo "   merged    package.json keeps this clone's name ($name) and takes the rest"
  fi
fi
echo "   code      $(git rev-parse --short HEAD)"

say "== installing dependencies"
pnpm install --frozen-lockfile

# A pipe is not a terminal, and `mailda upgrade` asks questions: reattach stdin to the terminal.
if [ -t 0 ]; then
  exec pnpm --silent mailda upgrade "$@"
else
  exec pnpm --silent mailda upgrade "$@" < /dev/tty
fi
