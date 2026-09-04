/**
 * The conditions a deploy needs, checked before anything is changed (#98).
 *
 * ## Why this exists, and what it replaces
 *
 * `mailda deploy` failed safely on a perfectly ordinary machine and told the operator the wrong thing. The
 * cause was that the operator's wrangler token could see **more than one Cloudflare account**, which makes
 * every non-interactive wrangler call fail with *"More than one account available but unable to select one in
 * non-interactive mode"*. The chain that produced:
 *
 *   1. `wrangler workflows list` failed, so the #99 Workflow-theft guard printed a note and **returned** —
 *      the protection against one Node stealing another's Butler engine silently did not run;
 *   2. `wrangler versions list` failed, so `firstInstall` could not tell a new account from an old one and
 *      refused with *"could not tell whether this account already has a Mailda Worker"*, naming
 *      `CLOUDFLARE_ACCOUNT_ID` in passing at the end of an advice block about something else.
 *
 * Both messages were about the symptom. Neither said *your token sees four accounts, pick one*, which is the
 * whole of it and is checkable in one call before anything runs.
 *
 * ## Why every check runs, rather than the first failure winning
 *
 * A deploy has several preconditions and an operator setting up a Node has all of them wrong at once. Failing
 * on the first means a round trip per problem, and each round trip ends in a message about a different thing
 * — which is how a five-minute setup becomes an afternoon. So these gather, and the report lists everything
 * that is wrong together.
 *
 * The functions here are pure and take text, so they can be tested against real wrangler output rather than
 * against a machine that happens to be configured a particular way.
 */

/**
 * The accounts a `wrangler whoami` table names, as `[{name, id}]`.
 *
 * Parsed from the box-drawn table, which is the only place wrangler prints them. The id is matched as 32 hex
 * characters rather than "the second cell", so a change to the table's column order cannot silently produce
 * account names as ids.
 */
export function accountsFrom(whoami) {
  const accounts = [];
  for (const line of whoami.split("\n")) {
    if (!line.includes("│")) continue;
    const cells = line.split("│").map((cell) => cell.trim()).filter((cell) => cell !== "");
    const id = cells.find((cell) => /^[0-9a-f]{32}$/i.test(cell));
    if (id === undefined) continue;
    const name = cells.find((cell) => cell !== id) ?? "(unnamed)";
    accounts.push({ name, id });
  }
  return accounts;
}

/** Whether wrangler thinks anybody is signed in. `whoami` says so in prose; there is no exit code for it. */
export function signedIn(whoami) {
  return /You are logged in|associated with the email|Account Name/i.test(whoami);
}

/**
 * Which account a deploy would use, or why it cannot tell.
 *
 * The three cases are deliberately distinct. One account needs nothing — wrangler picks it, and demanding an
 * environment variable there would be ceremony. Several accounts with no choice made is the defect this
 * module exists for. And a choice made that is **not in the list** is worth its own message: it is almost
 * always a copied id from another machine, and letting wrangler fail on it produces a permissions error that
 * reads like a broken token.
 */
export function resolveAccount({ accounts, chosen }) {
  if (typeof chosen === "string" && chosen !== "") {
    const known = accounts.find((one) => one.id.toLowerCase() === chosen.toLowerCase());
    if (accounts.length > 0 && known === undefined) {
      return {
        ok: false,
        /*
         * A different headline from the ambiguous case on purpose. wrangler does not answer "ambiguous" here
         * — it answers a permissions error against an account the token cannot reach, which reads like a
         * broken or expired token and sends people to re-authenticate instead of to the typo.
         */
        what: "CLOUDFLARE_ACCOUNT_ID names an account this token cannot see",
        why: `it is set to ${chosen}, which is not in this token's list. wrangler will answer with a `
          + "permissions error rather than saying the id is wrong, which reads like an expired login",
        fix: `pick one of:\n${listOf(accounts)}`,
      };
    }
    return { ok: true, id: chosen, name: known?.name ?? "(as configured)" };
  }
  if (accounts.length === 1) return { ok: true, id: accounts[0].id, name: accounts[0].name };
  if (accounts.length === 0) {
    return {
      ok: false,
      what: "wrangler named no accounts",
      why: "so it is probably not signed in, and every step of a deploy is a call against your account",
      fix: "run `wrangler login`, or set CLOUDFLARE_API_TOKEN",
    };
  }
  return {
    ok: false,
    what: "the Cloudflare account is ambiguous",
    why: `this token can see ${accounts.length} accounts and nothing says which one to deploy to, so every `
      + "wrangler call fails with a message about non-interactive mode — and the Workflow-theft guard (#99) "
      + "is skipped rather than enforced, because it treats an unreadable account as 'nothing to check'",
    /*
     * The remedy is the export line, spelled out. Every wrangler call in the deploy fails without it — with a
     * message about non-interactive mode that sends people looking for a `--yes` flag rather than for this.
     */
    fix: `export CLOUDFLARE_ACCOUNT_ID=<one of these>\n${listOf(accounts)}`,
  };
}

function listOf(accounts) {
  return accounts.map((one) => `             ${one.id}  ${one.name}`).join("\n");
}

/** wrangler's own version, out of its banner. */
export function wranglerVersionFrom(text) {
  return /wrangler\s+(\d+\.\d+\.\d+)/i.exec(text)?.[1] ?? null;
}

/**
 * Whether `version` is at least `floor`, comparing numerically rather than as strings.
 *
 * `"4.118.0" >= "4.97.0"` is **false** as a string comparison, because `1` sorts before `9`. A floor checked
 * that way would reject every wrangler released after 4.99 — refusing the newest versions and accepting the
 * oldest, which is the exact inversion of the intent and would look like a broken toolchain.
 */
export function atLeast(version, floor) {
  if (version === null) return false;
  const parts = (text) => String(text).split(".").map((piece) => Number(piece) || 0);
  const have = parts(version);
  const want = parts(floor);
  for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Whether a Node can report which version answered, which the canary gate compares against.
 *
 * Not fatal, and the distinction matters. A Node deployed before the `version_metadata` binding existed
 * cannot name itself, so an override that silently falls through to it is indistinguishable from a healthy
 * canary — except that a report with no version at all is exactly what the gate refuses on. So this is a
 * warning with a remedy rather than a refusal: the first deploy after the binding lands installs it.
 */
export function reportsItsVersion(report) {
  return typeof report?.version === "string" && report.version !== "";
}

/**
 * Whether not knowing the Node's URL should stop this command (#162).
 *
 * ## The bug this exists because of, found on the first live run
 *
 * `mailda deploy --plan` ran preflight and was refused: *"the Node's URL is not known"*. That requirement's
 * own stated reason is that **the canary is checked by overriding to the Node's own hostname**, so a deploy
 * cannot verify what it is about to promote — and a plan promotes nothing and verifies nothing.
 *
 * Worse, the refusal made `--plan` useless in exactly the case it was written for. A plan for a **first
 * install** runs before there is a Node, so there is no URL to pass; the command that exists to describe an
 * empty account demanded the address of something that does not exist there yet. That is the same
 * chicken-and-egg #92's drill found in the deploy sequence, reintroduced one command along.
 *
 * A function rather than an inline `if`, for `promotionVerdict`'s reason: the gate it replaced was asserted
 * lexically and survived being mutated to `if (false && …)`. A decision that takes values and returns values
 * cannot pass that way.
 */
export function urlRequirement({ origin, needsUrl }) {
  if (origin !== null) return null;
  if (!needsUrl) return null;
  return {
    what: "the Node's URL is not known",
    why: "the canary is checked by overriding to it on the Node's own hostname — there is no preview URL "
      + "for a Worker with Durable Objects — so a deploy cannot verify what it is about to promote",
    fix: "pass `--url https://<your-node>`, or set MAILDA_URL",
  };
}
