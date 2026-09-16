import { whyAdminCannotExist } from "../backup.mjs";
import { fail, flag, sessionCookie, claimState } from "../support.mjs";
/* ------------------------------------------------------------------ dispatch ----------------------- */

/* ------------------------------------------------------------------ verify-evidence ---------------- */

/**
 * Sweeps every stored message against the hash taken when it arrived (#92).
 *
 * ## Why the CLI pages and the route does not
 *
 * The route is bounded at a measured batch (`evidence-integrity-cost.md`) because a whole-database sweep
 * cannot fit in one invocation's subrequest budget — and a request that hit the cap partway would return a
 * clean partial result, which is the failure this whole feature exists to prevent. So the route answers
 * *"here is what I checked, resume after this"*, and the loop belongs to the caller.
 *
 * That makes this the only place a **complete** answer exists. A person calling the route once learns about
 * two hundred messages and can easily believe they learned about all of them; this keeps going until the
 * Node says there is no more, and prints the total it actually covered.
 *
 * ## What it prints when something is wrong
 *
 * Every fault, grouped by kind, with the receipt id — because the three kinds are different problems.
 * `missing` means the evidence is gone and the metadata that says it existed is not. `unreadable` means the
 * key generation the object names cannot be produced, which is the ADR 28 loss the escrow exists for.
 * `altered` means the bytes changed after ingress, which cannot happen by accident.
 *
 * Exit 1 on any fault, so this can be a scheduled check rather than something somebody reads.
 */
export async function verifyEvidence(argv) {
  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") {
    fail("usage: mailda verify-evidence --url https://your-node.workers.dev\n"
      + "  why      the check runs inside the Node: it needs the R2 bucket and the key vault, so a CLI\n"
      + "           that answered locally would be guessing about both\n"
      + "  fix      pass --url, or set MAILDA_URL");
  }

  // The same check `backup` makes, for the same reason: this route is administrator-only too, and on an
  // unclaimed Node there is no administrator to be.
  const unclaimed = whyAdminCannotExist({ claimed: await claimState(origin) === "unclaimed" ? false : true });
  if (unclaimed !== null) {
    fail(`${unclaimed.what}.\n\n  why      ${unclaimed.why}.\n  fix      ${unclaimed.fix}.`);
  }

  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD\n"
      + "  why      the route is administrator-only: what it reports is how much of the whole\n"
      + "           organization's evidence is intact, which is not a mailbox grant\n"
      + "  fix      export them, then re-run");
  }

  // A cookie, for the reason argued at `recovery-codes`: the login route has never returned a bearer token.
  const cookie = await sessionCookie(origin);
  if (cookie === null) fail("could not sign in — this route needs an administrator.");

  process.stdout.write("\n== checking stored evidence against the hashes taken at ingress\n");

  let after = null;
  let checked = 0;
  let bytes = 0;
  let batches = 0;
  const faults = [];

  /*
   * Bounded by the Node's own cursor rather than by a page limit here. The guard is `resumeAfter` going
   * null, which the route returns only on a short page — so a sweep ends because the Node said it had
   * nothing more, never because this loop decided it had seen enough.
   */
  for (;;) {
    const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
    const response = await fetch(`${origin}/api/evidence/verify${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(`/api/evidence/verify refused (${response.status})\n  ${payload.what ?? payload.message ?? "no detail"}`
        + `\n\n  covered ${checked} message(s) before this, so the sweep is incomplete rather than clean.`);
    }

    batches += 1;
    checked += payload.checked ?? 0;
    bytes += payload.bytesRead ?? 0;
    faults.push(...(payload.faults ?? []));
    process.stdout.write(`   batch ${batches}: ${payload.checked} checked, ${(payload.faults ?? []).length} fault(s)\n`);

    if (payload.resumeAfter === null || payload.resumeAfter === undefined) break;
    after = payload.resumeAfter;
  }

  const megabytes = (bytes / 1024 / 1024).toFixed(1);

  /*
   * Nothing checked is not a clean bill of health, and this said it was. Run against a freshly claimed Node
   * it printed *"0 message(s) checked … Every one opened and hashed to what was recorded"*, which is true and
   * reads as reassurance about evidence that does not exist. The verifier itself has a test for exactly this
   * — `intact: true` with `checked: 0` is honest only because the caller reads `checked` — and then the
   * caller wrote a sentence that did not.
   */
  if (checked === 0) {
    process.stdout.write(
      "\n   nothing to check: this Node holds no stored evidence yet.\n"
      + "   That is not a clean sweep. A Node that has received no mail has nothing to verify, and this\n"
      + "   command cannot tell you anything about one until it does.\n\n",
    );
    return;
  }

  if (faults.length === 0) {
    process.stdout.write(
      `\n   ${checked} message(s) checked in ${batches} batch(es), ${megabytes} MiB read. Every one opened and\n`
      + "   hashed to what was recorded when it arrived.\n\n",
    );
    /*
     * Said explicitly, because it is the limit of what was just established. A clean sweep is a statement
     * about the objects D1 knows about; an R2 object with no receipt is invisible to it, and so is a message
     * that never reached ingress.
     */
    process.stdout.write(
      "   what this does not cover: an R2 object no receipt names, and anything that never reached ingress.\n\n",
    );
    return;
  }

  process.stdout.write(`\n   ${faults.length} fault(s) across ${checked} object(s) checked:\n\n`);
  for (const kind of ["altered", "missing", "unreadable"]) {
    const group = faults.filter((one) => one.kind === kind);
    if (group.length === 0) continue;
    process.stdout.write(`   ${kind} (${group.length})\n`);
    /*
     * The table as well as the row id (#131). This swept `ingress_receipts` only, so a bare id was
     * unambiguous; it now covers drafts, exports and sends, and an id with no table sends somebody looking
     * in the wrong one during an incident.
     */
    for (const fault of group) {
      process.stdout.write(`     ${fault.table ?? "?"}  ${fault.rowId}  ${fault.detail}\n`);
    }
    process.stdout.write("\n");
  }
  process.stderr.write(
    "  altered      the bytes changed after ingress. This does not happen by accident.\n"
    + "  missing      the evidence is gone; the row saying it existed is not.\n"
    + "  unreadable   the object names a key generation this vault cannot produce — the ADR 28 loss the\n"
    + "               recovery codes exist for. `mailda doctor` reports whether the escrow is current.\n\n",
  );
  process.exit(1);
}
