import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backupIndex, checkBackup, exportableTables, needsIndexRebuild, whyAdminCannotExist } from "../backup.mjs";
import { fail, capture, run, flag, sessionCookie, doctorReport, ENV, runPreflight, claimState } from "../support.mjs";
/* ------------------------------------------------------------------ backup ------------------------- */

/**
 * Takes a backup that can be restored into a **different** Cloudflare account (#92).
 *
 * ## Why the account matters
 *
 * Durable Object point-in-time recovery and D1 Time Travel both cover thirty days and both operate inside the
 * account that failed. #92 puts it plainly: *"A backup that only restores into the account that failed is not
 * a backup for a product whose selling point is that you own the account."* So this writes files an operator
 * holds, not a snapshot Cloudflare holds.
 *
 * ## Three files, and what each is for
 *
 *   `catalog.sql`      `wrangler d1 export`. The thing you restore. It carries the composition manifests, the
 *                      audit chain and the **wrapped vault escrow**, because all three are rows — which is why
 *                      the escrow had to exist before this was worth writing, and why #92's layers came in
 *                      that order.
 *   `inventory.jsonl`  every R2 object with the hash its plaintext should have. The bucket itself is not
 *                      copied here — a bucket-to-bucket copy is the operator's tool, and this is what makes
 *                      the result checkable object by object afterwards.
 *   `index.json`       what the other two should contain, with a SHA-256 of each, so `verify-backup` can tell
 *                      a complete copy from a truncated one without a Node.
 *
 * ## What this deliberately does not do
 *
 * **Copy the evidence bytes.** Streaming a mailbox's worth of R2 through a laptop is not a backup strategy,
 * and pretending otherwise would produce a command that works on a demo Node and fails on a real one. The
 * inventory is what turns somebody else's copy — `rclone`, an R2 bucket-to-bucket job — into a copy that can
 * be verified. That is the honest division, and the receipt says so.
 *
 * **Verify by default.** `--verify` runs the evidence sweep first and records what it found, which opens every
 * object and costs accordingly. Without it the index records `verified: null`, and `verify-backup` reports
 * that as *not asked* rather than as clean.
 */
export async function backup(argv) {
  const ready = await runPreflight(argv);
  if (!ready.ok) fail(ready.report);
  const origin = ready.origin;

  const out = flag(argv, "out");
  if (out === null) {
    fail("usage: mailda backup --url https://your-node --out ./backup-2026-08-31\n"
      + "  why      a backup is files you hold. D1 Time Travel and Durable Object recovery both restore\n"
      + "           only into the account that failed, which is the one thing a customer-owned deployment\n"
      + "           has to survive losing\n"
      + "  fix      pass --out with a directory to write");
  }

  /*
   * The claim state first, because the answer changes what to ask for. On an unclaimed Node the credentials
   * this command needs cannot exist at all, and telling the operator to go and find them sends them after the
   * one thing that cannot work.
   */
  const unclaimed = whyAdminCannotExist({ claimed: await claimState(origin) === "unclaimed" ? false : true });
  if (unclaimed !== null) {
    fail(`${unclaimed.what}.\n\n  why      ${unclaimed.why}.\n  fix      ${unclaimed.fix}.`);
  }

  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD\n"
      + "  why      the inventory is administrator-only: it lists every object this organization holds\n"
      + "  fix      export them, then re-run");
  }
  const cookie = await sessionCookie(origin);
  if (cookie === null) {
    /*
     * Still fatal, and deliberately: a backup whose inventory is absent cannot be checked afterwards, and
     * writing one that *looks* complete is the failure this whole command exists to prevent. What changed is
     * that the sign-in above no longer gives up after one attempt (#148), so reaching here means three tries
     * failed or the Node refused outright.
     */
    fail(
      "could not sign in, so the inventory cannot be read and no backup was written.\n\n"
      + "  why      three attempts failed, or this Node refused the credentials outright — a 401 is not\n"
      + "           retried, because wrong credentials will be wrong again\n"
      + "  fix      check MAILDA_EMAIL and MAILDA_PASSWORD, then `mailda doctor --url " + origin + "`. A\n"
      + "           Node that answers 500 to sign-in may have an unusable signing key, which\n"
      + "           `doctor`'s signing_key finding names.",
    );
  }

  mkdirSync(out, { recursive: true });

  /*
   * Which tables to ask for, derived from the database rather than listed. `wrangler d1 export` refuses a
   * whole database that contains a virtual table — *"cannot export databases with Virtual Tables (fts5)"* —
   * and this catalog has two, so asking for the database exported nothing at all. Naming the tables is
   * accepted; the reasoning about which to leave out is in `exportableTables`.
   */
  process.stdout.write("\n== reading the catalog's shape\n");
  const schema = capture("npx", ["wrangler", "d1", "execute", "CATALOG", "--remote", "--json",
    "--command", "SELECT name, sql FROM sqlite_master WHERE type = 'table'", ...ENV], { quiet: true });
  if (schema.status !== 0) fail(`could not read the catalog's table list (exit ${schema.status}).`);
  let master;
  try {
    const parsed = JSON.parse(schema.text.slice(schema.text.indexOf("[")));
    master = parsed[0]?.results ?? [];
  } catch {
    fail("could not parse the catalog's table list. Nothing was written.");
  }
  const { included, excluded } = exportableTables(master);
  if (included.length === 0) fail("the catalog reported no exportable tables. Nothing was written.");
  process.stdout.write(`   ${included.length} table(s) to export, ${excluded.length} left out\n`);
  for (const one of excluded) process.stdout.write(`   omitting  ${one.name}  — ${one.why}\n`);

  process.stdout.write("\n== exporting the catalog\n");
  const catalogPath = `${out}/catalog.sql`;
  if (run("npx", ["wrangler", "d1", "export", "CATALOG", "--remote", "--output", catalogPath,
    "--skip-confirmation", "--no-schema", ...ENV,
    ...included.flatMap((name) => ["--table", name])]) !== 0) {
    fail("exporting D1 failed, so there is no backup. Nothing was written that could be mistaken for one.");
  }

  /*
   * **Data only.** The schema comes from the restoring Node's own migrations — ADR 24 makes the repository
   * the source of truth for it, and the runbook deploys before it restores, so the tables already exist.
   * Carrying `CREATE TABLE` as well would make every restore fail on its first statement.
   */
  const rebuild = needsIndexRebuild(master);
  if (rebuild) {
    process.stdout.write("\n   the search index is excluded and must be rebuilt after restoring\n");
  }

  process.stdout.write("\n== listing the evidence\n");
  let cursor = null;
  let objects = 0;
  let unaccounted = 0;
  const lines = [];
  for (;;) {
    const query = cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`;
    const response = await fetch(`${origin}/api/evidence/inventory${query}`, {
      headers: { accept: "application/json", cookie },
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    if (!response.ok) {
      fail(`/api/evidence/inventory answered ${response.status}, so the backup is incomplete and was not `
        + `indexed. ${objects} object(s) had been listed.`);
    }
    const page = await response.json();
    for (const object of page.objects ?? []) lines.push(JSON.stringify(object));
    objects += (page.objects ?? []).length;
    unaccounted += page.unaccounted ?? 0;
    /*
     * `\r` only on a terminal. Piped or captured, a carriage return is not a rewind — the drill's log read
     * `3 object(s)   3 object(s)   3 object(s) listed`, one copy per page, because nothing overwrote anything.
     */
    if (process.stdout.isTTY) process.stdout.write(`   ${objects} object(s)\r`);
    if (page.resumeAfter === null || page.resumeAfter === undefined) break;
    cursor = page.resumeAfter;
  }
  process.stdout.write(`   ${objects} object(s) listed\n`);

  let verified = null;
  if (argv.includes("--verify")) {
    process.stdout.write("\n== checking the evidence before recording it\n");
    let after = null;
    let checked = 0;
    let faults = 0;
    for (;;) {
      const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
      const response = await fetch(`${origin}/api/evidence/verify${query}`, {
        method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
      }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
      if (!response.ok) fail(`/api/evidence/verify answered ${response.status}; the backup was not indexed.`);
      const page = await response.json();
      checked += page.checked ?? 0;
      faults += (page.faults ?? []).length;
      for (const fault of page.faults ?? []) {
        process.stdout.write(`   ${fault.kind}  ${fault.table ?? "?"}  ${fault.rowId}  ${fault.detail}\n`);
      }
      if (page.resumeAfter === null || page.resumeAfter === undefined) break;
      after = page.resumeAfter;
    }
    verified = { checked, faults };
    process.stdout.write(`   ${checked} checked, ${faults} fault(s)\n`);
  }

  const inventoryText = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  writeFileSync(`${out}/inventory.jsonl`, inventoryText);

  const report = await doctorReport(origin, { cookie });
  const index = backupIndex({
    node: origin,
    nodeVersion: typeof report.version === "string" ? report.version : null,
    takenAt: new Date().toISOString(),
    catalog: readFileSync(catalogPath),
    inventory: inventoryText,
    objects,
    unaccounted,
    verified,
    excludedTables: excluded,
    rebuildSearchIndex: rebuild,
  });
  writeFileSync(`${out}/index.json`, `${JSON.stringify(index, null, 2)}\n`);

  process.stdout.write(
    `\n   written to ${out}\n`
    + `   catalog    ${index.catalog.bytes} bytes\n`
    + `   inventory  ${objects} object(s), ${unaccounted} named by no live row\n`
    + `   version    ${index.nodeVersion ?? "not reported by this Node"}\n`,
  );
  /*
   * The bucket, said plainly and last, because it is the half this command does not do and the half an
   * operator will assume it did. An inventory without the objects restores nothing.
   */
  process.stdout.write(
    "\n   the evidence bytes are NOT in this backup — copy the R2 bucket separately (rclone, or an R2\n"
    + "   bucket-to-bucket job). The inventory is what makes that copy checkable afterwards.\n\n",
  );
}


/**
 * Checks that a backup on disk is the one its index describes (#92).
 *
 * Reads the artifact and nothing else — no Node, no network — so it can run on the copy an operator keeps
 * rather than on the machine that took it. That is the point: the failures it catches are a truncated copy, a
 * partial download and a directory somebody edited, which is most of how a backup is discovered to be
 * useless, and all of it discoverable before the day it is needed.
 *
 * What it cannot establish is stated in its own output rather than left to a reader, because *"the backup
 * verified"* is the sentence somebody will remember on the day it matters.
 */
export function verifyBackup(argv) {
  const dir = flag(argv, "in");
  if (dir === null) fail("usage: mailda verify-backup --in ./backup-2026-08-31");

  const read = (name) => {
    try {
      return readFileSync(`${dir}/${name}`);
    } catch {
      return null;
    }
  };
  const indexBytes = read("index.json");
  let index = null;
  if (indexBytes !== null) {
    try {
      index = JSON.parse(indexBytes.toString("utf8"));
    } catch {
      index = null;
    }
  }

  const outcome = checkBackup({ index, catalog: read("catalog.sql"), inventory: read("inventory.jsonl") });

  if (index !== null) {
    process.stdout.write(
      `\n== ${dir}\n`
      + `   taken       ${index.takenAt ?? "(unrecorded)"}\n`
      + `   from        ${index.node ?? "(unrecorded)"}\n`
      + `   version     ${index.nodeVersion ?? "not reported by that Node"}\n`
      + `   objects     ${index.inventory?.objects ?? "?"}\n`,
    );
  }
  for (const note of outcome.notes) process.stdout.write(`\n   note: ${note}\n`);

  if (!outcome.ok) {
    fail(
      `${outcome.problems.length} problem(s) with this backup.\n\n`
      + outcome.problems.map((one, at) => `  ${at + 1}. ${one.what}\n     fix      ${one.fix}`).join("\n\n"),
    );
  }

  process.stdout.write(
    "\n   this backup is the one its index describes: every file present, every hash matching.\n\n"
    + "   what that does not establish, said here rather than left implied:\n"
    + "     - that the evidence decrypts. The objects are not in the backup; the inventory lists them.\n"
    + "     - that the catalog restores. Both are properties of a restore, which is the step that makes\n"
    + "       the rest true.\n\n",
  );
}
