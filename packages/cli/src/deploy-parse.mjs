import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The parts of `mailda deploy` that read text, split out so they can be tested (#98).
 *
 * ## Why a separate module
 *
 * `mailda.mjs` dispatches on `process.argv` at the top level, so importing it *runs* it. This repository has
 * already paid for that lesson once: the SDK's generator had a top-level `writeFileSync`, so the test meant
 * to catch a hand edit regenerated the file before it could read one. A module with a top-level side effect
 * cannot be imported by the thing that checks it, and the fix both times is the same seam — the pure part in
 * its own file, the side-effecting part importing it.
 *
 * ## Why these three are worth testing at all
 *
 * The deploy sequence's safety rests on never shifting traffic to an unchecked version, and a failed check
 * needs no rollback because `versions upload` moves no traffic. There is exactly one way to defeat that:
 * **promote the wrong version**, by misreading an id. That is a pure string function, so it gets real tests
 * rather than a lexical guard.
 */

/** A version id, out of wrangler's prose. `null` rather than a guess: the caller refuses on null. */
export function versionIdFrom(text) {
  const match = /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(text)
    ?? /Version ID:\s*([0-9a-f-]{36})/i.exec(text)
    ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(text);
  return match?.[1] ?? null;
}

/**
 * The version currently serving, out of `wrangler deployments list`.
 *
 * ## Why this replaced a preview-URL parser
 *
 * The gate used to check the canary at `canary-mailda.<subdomain>.workers.dev`, and that hostname **404s and
 * always will**. Measured against the live account: the script's subdomain settings read
 * `{"enabled": true, "previews_enabled": true}`, the alias is recorded on every version, and no preview
 * hostname routes at all. The cause is a platform limitation — Cloudflare does not generate preview URLs for
 * Workers that implement a Durable Object, and this one has `KEY_VAULT` and `OUTBOX_SWEEPER`. Two rounds of
 * the deploy drill blamed an account setting, which is why the receipt records the API response rather than
 * the conclusion.
 *
 * So the canary is checked on the **production** hostname through a version override, which needs the
 * currently-serving version id to build a two-version deployment. Cloudflare serves at most two versions in
 * one deployment, so this is the other half of that pair.
 *
 * `wrangler deployments list` prints deployments oldest-first, so the **last** percentage line is the active
 * one. Taking the first would build a deployment around a version that stopped serving days ago and drop the
 * one that is — which is why this reads the last match rather than the first.
 */
export function activeVersionFrom(text) {
  const all = [...text.matchAll(/\((\d{1,3})%\)\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)];
  const serving = all.filter((one) => Number(one[1]) > 0);
  return serving.at(-1)?.[2] ?? null;
}

/**
 * The version id a doctor report says answered, or `null` if it did not say.
 *
 * ## Why the gate cannot just read `verdict`
 *
 * The canary is reached by sending `Cloudflare-Workers-Version-Overrides` to the production hostname, and
 * Cloudflare is explicit about what happens when the override cannot be applied: the request is *"routed
 * according to the percentages set in the gradual deployment configuration"*. That is the version already
 * serving. No error, no header, nothing to notice — the check would ask the **old** version how it is, get
 * `ok`, and promote a canary nothing had examined.
 *
 * That is an assertion that cannot fail, so the identity of the responder is part of the gate. A report
 * without a version is a refusal rather than a pass: a Node too old to carry the field is a Node this gate
 * cannot check.
 */
export function servedVersionOf(report) {
  const id = report?.version;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

/**
 * The pending migrations that contract, given wrangler's `migrations list` output.
 *
 * The phase is read from **this repository's own files** rather than parsed out of wrangler's table. That is
 * deliberate: a change to how wrangler formats that table would otherwise produce an empty list, which reads
 * as "nothing contracts" and lets a contraction through — a silent failure in the guard, which is the shape
 * this whole ticket is about. A name wrangler prints that this checkout does not have is ignored, because it
 * belongs to a version of the Node this checkout is not.
 */
export function contractingAmong(listOutput, migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => listOutput.includes(name))
    .filter((name) => /^--\s*phase:\s*contract\b/im.test(readFileSync(resolve(migrationsDir, name), "utf8")));
}

/**
 * Whether the canary is safe to promote, judged against **what is already serving** (#98).
 *
 * ## The defect this replaces, found by running the drill
 *
 * The gate was `shouldPromote(canary.verdict)` — promote only on `ok`. Against a live Node that refused, and
 * the refusal was correct by its own rule and wrong for the operator:
 *
 *   - the canary reported `degraded`, one finding: `signing_key`, *"No current signing key. One is generated
 *     on the next sign-in, so this self-heals"*;
 *   - the incumbent reported `degraded`, **the same one finding**.
 *
 * So the deploy refused to promote a version that was neither better nor worse than the one already taking
 * every request, and told the operator to promote it by hand. A Node in a self-healing degraded state — which
 * an unclaimed Node is, by construction, until somebody signs in — would refuse **every** deploy that way,
 * and a gate that always has to be overridden has stopped being a gate. That is the same weak
 * "upload, check by hand, promote" path the earlier drills recorded, arrived at from a different direction.
 *
 * ## What a canary can actually answer
 *
 * Whether the **new code** is worse. A finding the incumbent already has is not information about the new
 * version; it is information about the Node, and it is the incumbent's problem whether or not this deploy
 * happens. Refusing on it withholds the fix as readily as the regression.
 *
 * So the comparison is differential: a finding the canary has and the incumbent does not blocks. Shared
 * findings are **carried** — reported, never silently dropped, because "it was already broken" is a sentence
 * an operator should read rather than one a tool should act on alone.
 *
 * ## The one absolute rule kept
 *
 * `refuse` still refuses, whatever the incumbent says. `degraded` is a Node with a finding; `refuse` is a Node
 * saying it cannot do its job, and moving every request onto one of those is not made acceptable by the fact
 * that the current version is also broken. Two broken versions is a reason to stop, not to proceed.
 *
 * ## Why the decision is a function at all
 *
 * Inherited from `shouldPromote`, which this replaced, and kept because the reason was expensive. The gate
 * used to be an inline `if (verdict !== "ok") fail(...)` asserted **lexically** — a test read the source
 * between the check and the traffic shift and required it to contain `fail(` and to mention
 * `verdict !== "ok"`. Both stayed true when the condition was mutated to `if (false && verdict !== "ok")`,
 * which disables the gate completely, so the test passed against a deploy that promotes a broken canary.
 *
 * So the decision lives here, where it can be called with values and checked against answers, and the
 * lexical test keeps only the claim it can support: that the call site consults this before shifting traffic.
 */
export function promotionVerdict({ canary, incumbent }) {
  const notOk = (report) =>
    (report?.findings ?? []).filter((one) => one?.ok === false).map((one) => String(one.check));

  const canaryFaults = notOk(canary);
  const already = new Set(notOk(incumbent));
  const blocking = canaryFaults.filter((check) => !already.has(check));
  const carried = canaryFaults.filter((check) => already.has(check));

  if (canary?.verdict === "refuse") {
    return { promote: false, blocking, carried, why: "the canary reports `refuse`, not merely a finding" };
  }
  if (blocking.length > 0) {
    return {
      promote: false,
      blocking,
      carried,
      why: `the canary has ${blocking.length} finding(s) the version now serving does not: ${blocking.join(", ")}`,
    };
  }
  /*
   * A canary that could not be read is not a canary that passed. `verdict` absent means the report was not
   * the shape this expects, and treating that as "no new findings" would promote on a parse failure.
   */
  if (typeof canary?.verdict !== "string") {
    return { promote: false, blocking, carried, why: "the canary's report carried no verdict" };
  }
  return { promote: true, blocking, carried, why: null };
}
