import { fail, flag, sessionCookie } from "../support.mjs";
/**
 * Listing and repairing what the body index failed on.
 *
 * ## Why a command rather than a documented UPDATE
 *
 * The receipt for #107 said, in as many words, that repairing a message meant clearing `body_indexed_at` by
 * hand and that no route exposed it. An operator whose search cannot find a message they know exists was
 * being handed a `wrangler d1 execute` — which is not a repair path, it is an invitation to write an
 * `UPDATE` with no `WHERE` during an incident.
 *
 * ## It lists before it repairs, and the default is to list
 *
 * Some failures are deterministic: a body no parser will ever read. Repairing those spends the backfill's
 * attempts on work that cannot succeed, while the mail behind them waits. So `list` shows the reason against
 * each id and `repair` takes the ids worth retrying — a sweep would be one flag and the wrong shape.
 */
export async function search(argv) {
  const action = argv[0] ?? "list";
  if (action !== "list" && action !== "repair") {
    fail("usage: mailda search list|repair --url https://your-node.workers.dev\n"
      + "  list     what the body index failed on, with the reason for each\n"
      + "  repair   put named messages back in the queue: --id msg_… (repeatable), or --all\n"
      + "  why      a message the index gave up on is unsearchable by its text and otherwise untouched.\n"
      + "           Fix the cause before repairing, or the attempts are spent again");
  }

  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") fail("pass --url https://your-node.workers.dev, or set MAILDA_URL");
  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD — both routes are administrator-only");
  }

  // A cookie, for the reason argued at `recovery-codes`: the login route has never returned a bearer token.
  const held = await sessionCookie(origin);
  if (held === null) fail("could not sign in — these routes need an administrator.");
  const auth = { cookie: held, "content-type": "application/json" };

  const listed = await fetch(`${origin}/api/search/failed`, { headers: auth })
    .then((response) => response.json())
    .catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  const failures = listed.failed ?? [];

  if (action === "list" || failures.length === 0) {
    if (failures.length === 0) {
      process.stdout.write("\nthe body index has failed on nothing\n\n");
      return;
    }
    process.stdout.write(`\n== ${failures.length} message(s) the body index failed on\n\n`);
    for (const row of failures) {
      process.stdout.write(`   ${row.messageId}  ${row.state}  ${row.attempts} attempt(s)\n`);
      process.stdout.write(`      ${row.error ?? "no reason recorded"}\n`);
    }
    /*
     * The distinction is printed rather than left for the operator to infer from the error text, because it
     * is the decision the command exists to support: `retryable` is a Node still working, `unindexable` has
     * stopped — and among those, "abandoned after N attempts" is worth retrying and a parse failure is not.
     */
    process.stdout.write("\n   retryable    still being retried automatically; nothing to do\n");
    process.stdout.write("   unindexable  stopped. \"abandoned after N attempts\" is worth a repair once the\n");
    process.stdout.write("                cause is fixed; a parse failure will fail again\n\n");
    process.stdout.write(`   repair: mailda search repair --url ${origin} --id <msg_…>\n\n`);
    return;
  }

  const ids = argv.includes("--all")
    ? failures.map((row) => row.messageId)
    : argv.flatMap((arg, at) => (arg === "--id" ? [argv[at + 1]] : [])).filter(Boolean);
  if (ids.length === 0) {
    fail("pass --id msg_… (repeatable) or --all\n"
      + "  why      repair is per message. Some of these are deterministically unparseable and repairing\n"
      + "           them spends the backfill's attempts on work that cannot succeed\n"
      + "  fix      run `mailda search list` first and choose");
  }

  const response = await fetch(`${origin}/api/search/repair`, {
    method: "POST", headers: auth, body: JSON.stringify({ messageIds: ids }),
  }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(`repair refused (${response.status})\n  ${payload.what ?? "no detail"}`);
  process.stdout.write(`\n${payload.requeued} message(s) re-queued. ${payload.message}\n\n`);
}
