import { idPattern, type IdPrefix } from "@mailda/runtime";
import { type PolicyConditions } from "../policy.ts";
import { stageOf, type Stages } from "../approvals.ts";
import { clearedCookies, sessionCookies, type IssuedSession } from "../auth/session.ts";

/**
 * A response that installs a session. Three Set-Cookie headers, which is why this uses
 * `Headers.append` — assigning `set-cookie` in a header object keeps only the last one, and the
 * resulting bug is a session that half-works.
 */
export function sessionResponse(body: unknown, session: IssuedSession): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of sessionCookies(session)) headers.append("set-cookie", cookie);
  return new Response(
    JSON.stringify({ ...(body as object), accessExpiresAt: session.accessExpiresAt }),
    { headers },
  );
}

/**
 * A terminal 401: the session is over and no refresh will fix it. Cookies are cleared, so a
 * client cannot sit in a refresh loop against a token that will never work again.
 */
export function signedOutResponse(error: string, message: string): Response {
  const headers = new Headers({ "content-type": "application/json", "x-mailda-refreshable": "false" });
  for (const cookie of clearedCookies()) headers.append("set-cookie", cookie);
  const status = error === "signed_out" ? 200 : 401;
  return new Response(JSON.stringify({ error, message, refreshable: false }), { status, headers });
}

/**
 * A 401 that a refresh may fix. The access token is missing, expired or unverifiable — but the
 * refresh cookie is not consulted here, so this says "try refreshing", never "you are signed
 * out". Only the refresh endpoint gets to conclude the latter.
 */
/**
 * What the router answers for a path nothing serves, reused by handlers whose segment must be an id: before
 * the registry routed, their regular expression carried the id alphabet and a malformed id simply never
 * matched. The registry's `:name` accepts any segment, so the same refusal now lives one line inside.
 */
/**
 * An address list from a JSON body: every element as a string, so `to: [1]` reaches `normalizeAddress` and
 * is refused as an address rather than crashing on `.trim` (a 500 the 17 September audit found). Absent or
 * not an array is the empty list; the handler decides whether empty is allowed.
 */
export function addressList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((one) => (typeof one === "string" ? one : String(one ?? ""))) : undefined;
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return idPattern(prefix).test(value);
}

export function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

export function unauthenticated(): Response {
  return Response.json(
    { error: "unauthenticated", message: "Sign in to continue.", refreshable: true },
    { status: 401, headers: { "x-mailda-refreshable": "true" } },
  );
}

/**
 * A policy's five conditions out of a JSON body, and nothing else.
 *
 * Five named reads rather than a spread, deliberately. `{ ...body.conditions }` would accept `dataClass` or
 * `device` — a field #60 named **absent** because no data answers it — and store it nowhere while the caller
 * believed a rule had been written. That is exactly *"a condition backed by no data is a policy that silently
 * never fires"*, arriving through the API instead of through the schema, and the five-column table would not
 * have caught it because the extra key would never reach a column.
 *
 * An unrecognised key is still **ignored rather than refused here**, and since #93 that is no longer a weak
 * spot, because it is no longer the only line. `conditions` is a strict object in
 * `packages/contract/src/schemas.ts` and `refuseUnknownFields` applies it at the boundary, so
 * `{"mailbox_id":…}` never reaches this function — it is refused by name, with the five that exist, before
 * anything is written. That is where the check belongs: the contract is where every channel's validation
 * comes from, and a second hand-written validator in this file is the correspondence problem `errors.ts`
 * already rejected once.
 *
 * This stays exactly as it was, and the reason is worth stating rather than trusting: it is the **last**
 * line, not the first. A future route, a Butler effect or a restore path that builds conditions without
 * going through the HTTP boundary still cannot smuggle a sixth key into the five columns.
 */
export function conditionsFrom(raw: unknown): PolicyConditions {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const text = (value: unknown): string | null | undefined =>
    value === undefined ? undefined : value === null ? null : String(value);
  const flag = (value: unknown): boolean | null | undefined =>
    value === undefined ? undefined : value === null ? null : Boolean(value);
  const count = (value: unknown): number | null | undefined =>
    value === undefined ? undefined : value === null ? null : Number(value);
  return {
    mailboxId: text(source.mailboxId),
    actorUserId: text(source.actorUserId),
    recipientExternal: flag(source.recipientExternal),
    isReply: flag(source.isReply),
    orgDailyVolumeMin: count(source.orgDailyVolumeMin),
  };
}

/**
 * A policy's approval stages out of a JSON body: what each stage requires, in review order (#61, #73).
 *
 * An array, because the position **is** the ordinal — `[1, 1]` is sequential review by two people, `[2]` is
 * parallel dual control, and `[{"count":1,"team":"tm_…"},{"count":1,"team":"tm_…"}]` is §18's separation of
 * *duty*: one from finance, then one from legal.
 *
 * ## A bare number is sugar for an unconstrained stage, and that is one spelling rather than two
 *
 * `2` and `{"count":2}` arrive as the same `Stage`, so there is exactly one **stored** form — which is the
 * property #61 protects when it normalises the implicit stage away, reached one layer out. What the sugar buys
 * is that every policy body written before teams existed still means what it meant, and a rule with no team
 * constraint is not made to carry an object to say so.
 *
 * Coerced rather than trusted, for the reason `conditionsFrom` coerces its volume floor: JSON from a form
 * carries `"2"`, and `normaliseStages` demands an integer, so an uncoerced value would be refused with a
 * message about its own value being unusable.
 *
 * A stage's unrecognised keys are refused at the boundary since #93, for the same reason a condition's are
 * and with the same mechanism: `team` is a **constraint**, so `{"count":1,"teem":"tm_finance"}` dropped
 * quietly is not a stage with less detail — it is §18's separation of duty replaced by any single approver,
 * in a rule whose author believed they had written the opposite. `count` is not: a misspelled count leaves
 * `Number(undefined)`, and `normaliseStages` already refuses that loudly with `E_BAD_APPROVAL_STAGE`.
 *
 * `undefined` and `[]` both mean the default, which is one stage of count 1. Anything that is not an array is
 * `undefined` rather than an error here: `normaliseStages` refuses what it cannot use, and one refusal beats
 * two. A `team` that is absent, null or not a string becomes `null` — no constraint — and an *empty* string is
 * passed through as an empty string so `normaliseStages` can refuse it, because `""` is a typo rather than a
 * choice and coercing it to null would silently weaken the rule its author wrote.
 */
export function stagesFrom(raw: unknown): Stages | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((value) => {
    if (typeof value !== "object" || value === null) return stageOf(Number(value));
    const stage = value as Record<string, unknown>;
    const team = stage.team ?? stage.teamId;
    return stageOf(Number(stage.count), typeof team === "string" ? team : null);
  });
}

/**
 * The claimed organisation, or null.
 *
 * Tolerates an unreadable catalog, and that is not the same as pretending the Node is unclaimed. A
 * fresh install has no schema at all — `wrangler deploy` provisions the database but does not migrate
 * it — so this query throws, and it used to take `/api/doctor` down with it: the one endpoint whose job
 * is to say what is wrong returned 500 on the most likely way for a Node to be wrong. Measured on a
 * real button install (receipt: `deploy-button-install.md`).
 *
 * Returning null here lets `runDoctor` reach `checkSchema`, which reports the missing tables and the
 * command that fixes them. Nothing is disclosed by doing so: a Node with no tables has no data to
 * protect, and the authentication gate below only applies once an organisation exists.
 */
export async function organizationId(env: Env): Promise<string | null> {
  const row = await env.CATALOG.prepare(
    "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
  ).first<{ org_id: string }>().catch(() => null);
  return row?.org_id ?? null;
}

/** Ensures a sweep is scheduled. Idempotent — the DO only sets an alarm if none is pending. */
export async function armSweeper(env: Env): Promise<void> {
  try {
    await env.OUTBOX_SWEEPER.getByName("node").schedule();
  } catch {
    // A failure to arm is not a failure to accept mail. The next request arms it again, and
    // the row stays visibly unpublished meanwhile — which is the honest state.
  }
}

export function claimMessage(status: string): string {
  switch (status) {
    case "already_claimed":
      return "This Node has already been claimed. Sign in instead, or restore from backup to start over.";
    case "bad_secret":
      return "That bootstrap secret does not match. It was shown once by `mailda claim-secret`, and only its hash is stored — seed again if it is lost.";
    case "not_installed":
      return "This Node has no bootstrap secret recorded. Run `mailda deploy` to complete installation.";
    default:
      return "Claim failed.";
  }
}

export async function hashHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
