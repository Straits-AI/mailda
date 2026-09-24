/**
 * The pure half of `mailda upgrade`: reading git's answers about where the code is, and sorting pending
 * migrations by what they do to data. `verbs/upgrade.mjs` runs the commands; this decides what they said.
 */

/**
 * The remote that carries Mailda releases, from `git remote -v`: the first whose fetch URL names
 * `Straits-AI/mailda`, or `null` when none does. Named rather than assumed to be `origin`, because a
 * deploy-button clone has no remote and a fork has `origin` pointing at itself with `upstream` at us.
 */
export function releaseRemote(remoteV) {
  for (const line of remoteV.split("\n")) {
    const [name, url, kind] = line.trim().split(/\s+/);
    if (kind === "(fetch)" && /github\.com[/:]Straits-AI\/mailda(\.git)?$/i.test(url ?? "")) return name;
  }
  return null;
}

/**
 * `git rev-list --left-right --count HEAD...<remote>/main` answers "<ahead>\t<behind>". Ahead is local
 * commits the release branch lacks; behind is releases this clone lacks. Both zero means current.
 */
export function distance(revListCount) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(revListCount);
  return m === null ? null : { ahead: Number(m[1]), behind: Number(m[2]) };
}

/**
 * Pending migrations, sorted by phase. `contractingAmong` in `deploy-parse.mjs` decides which contract; this
 * puts the rest beside them so the operator sees the whole list before agreeing to run it on their data.
 */
export function pendingByPhase(listOutput, migrationNames, contracting) {
  const pending = migrationNames.filter((name) => listOutput.includes(name)).sort();
  return {
    expand: pending.filter((name) => !contracting.includes(name)),
    contract: pending.filter((name) => contracting.includes(name)),
  };
}

/**
 * The release remote's URL, for a clone that has none: the deploy button clones without history or remote.
 * One place, so the README, the installer and the upgrade agree about where releases come from.
 */
export const RELEASE_URL = "https://github.com/Straits-AI/mailda.git";

/**
 * Whether a merge's conflicts are the one file the update path allows. `package.json` is the only file a
 * deploy-button clone rewrites (its `name`), and `test/node/update-path.test.ts` fails the day a second one
 * joins it; anything else conflicting is a clone somebody edited, which is theirs to merge.
 */
export function onlyPackageJson(conflicted) {
  const files = conflicted.split("\n").map((one) => one.trim()).filter(Boolean);
  return files.length === 1 && files[0] === "package.json";
}

/**
 * The resolution of that one conflict: upstream's package.json with the clone's own `name` kept. Taking
 * "ours" wholesale would freeze the customer's scripts at install time, which is what the update-path test
 * checks against; taking "theirs" wholesale would rename their Worker.
 */
export function resolvePackageJson(ours, theirs) {
  const name = JSON.parse(ours).name;
  const merged = JSON.parse(theirs);
  if (typeof name === "string" && name !== "") merged.name = name;
  return `${JSON.stringify(merged, null, 2)}\n`;
}
