import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { conflict } from "../errors.ts";
import { heldAccount } from "./account-routing.ts";
import { cloudflareGetAll, operatorOf } from "./cloudflare-api.ts";
import { type Listed, listedOf } from "./destinations.ts";

/**
 * Which of the addresses this Node has handed mail to were verified Email Routing destinations of its
 * account, and when (28 September 2026).
 *
 * ## Why this is read at all
 *
 * No outcome is reported for verified destinations: Cloudflare published no `email.sending` event for mail
 * to one in the one case measured (`docs/receipts/email-sending-events.md`). Such a recipient stays
 * `unobserved`, which reads exactly like an answer still coming or a subscription that is missing. Which
 * addresses are verified destinations is the account's own list, so it is read here, on request, and what
 * the read found is recorded for doctor and `GET /api/sends`, which make no live call.
 *
 * ## What is kept, and what never is
 *
 * The account's list can hold anybody's address. It enters SQL only as a filter against `send_recipients`,
 * so a row is written only for an address this Node already holds as handed over, and the answer, the
 * audit entry and every surface that prints this read carry counts, never an address. Rows are never
 * removed: each keeps the interval a read proved (Cloudflare's own verified timestamp, to the latest read
 * that listed it), so a later read that no longer lists an address leaves the hand-overs it proved alone.
 * Migration 0070's header has the whole argument.
 *
 * ## A failure is could not read, never none verified
 *
 * A refused or unreachable read is recorded as the latest attempt with the failure as reported and changes no
 * address row. It does not throw: it is recorded state, not a partial act.
 */
export interface VerifiedDestinations {
  /** The account whose list `readAt` describes. Null until a read succeeds. */
  accountId: string | null;
  /** The latest successful read, or null when none has succeeded. A failed attempt does not move it. */
  readAt: string | null;
  /** The latest attempt, successful or not. */
  attemptedAt: string;
  /**
   * The latest attempt's failure as `cloudflareGet` reported it (Cloudflare's words when it gave any, otherwise
   * `http_<status>` or that the API could not be reached), or null when it succeeded.
   */
  error: string | null;
  /** How many distinct addresses this Node has handed mail to. */
  recipients: number;
  /** How many of them the latest successful read listed as verified destinations; null when none succeeded. */
  verified: number | null;
  /** This attempt's whole listing, counted (ADR 47); null when this attempt could not read. */
  listed: { verified: number; waiting: number } | null;
  /** The listed addresses, only when asked for and read; never recorded anywhere. */
  addresses: Listed[] | null;
}

/** One entry of Cloudflare's destination-address listing, read defensively: only two fields are used. */
interface RawListed { email?: unknown; verified?: unknown }

export async function recordVerifiedDestinations(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, options: { addresses?: boolean } = {},
): Promise<VerifiedDestinations> {
  /*
   * The account to read: the operator credential's, else the stored token's, which is `boundAccount`'s rule.
   * Read here through `heldAccount`, which rejects on a failed read instead of answering null: the comparison
   * below is skipped when no token is held, so "could not tell" must not pass for "none held".
   */
  const operator = operatorOf(ctx);
  const held = await heldAccount(env);
  const accountId = operator?.accountId ?? held;
  if (accountId === null) {
    throw conflict("E_PROVIDER_NO_TOKEN", {
      what: "this Node holds no Cloudflare API token, and no operator credential came with the request",
      why: "which addresses are verified destinations is the account's own list, and reading it needs a credential",
      fix: "run `mailda setup`, which reads it with wrangler's login; or register a token carrying Email Routing "
        + "Addresses: Read on the Setup screen (`mailda provider --token`); or send the x-cloudflare-token and "
        + "x-cloudflare-account headers with this request",
    });
  }

  /*
   * A Node lives in one account. An operator credential naming another would read a different account's
   * list and record it as this Node's explanation, and the rows it writes are never removed, so the account
   * is compared before anything is asked: with the stored token's when one is held, else with the account the
   * last successful read named. A registered token is how a Node that really moved says so: it becomes what
   * is compared, and rows an earlier account's read proved stay true for the hand-overs made while it lived
   * there. A read with the stored token alone reads that token's account and compares nothing.
   */
  if (operator !== null) {
    const recorded = held !== null ? null : (await env.CATALOG.prepare(
      "SELECT account_id FROM verified_destination_read WHERE id = 1",
    ).first<{ account_id: string | null }>())?.account_id ?? null;
    const bound = held ?? recorded;
    if (bound !== null && bound !== operator.accountId) {
      throw conflict("E_PROVIDER_ACCOUNT_MISMATCH", {
        what: `the operator credential names account ${operator.accountId}, and `
          + (held !== null ? `this Node's token is bound to ${bound}` : `this Node's last read was of account ${bound}`),
        why: "whether a recipient is a verified destination is a fact about the account that sent the mail, and a "
          + "Node lives in one account, so a read of another account's list would record a false explanation",
        fix: `set CLOUDFLARE_ACCOUNT_ID=${bound} and run the command again; or, if this Node now lives in ${operator.accountId}, `
          + "register a token for that account first (`mailda provider --token`)",
      });
    }
  }

  const at = new Date(ctx.now()).toISOString();
  const authority = operator === null ? "token" : "operator";
  const listed = await cloudflareGetAll<RawListed>(env, ctx, orgId, `/accounts/${accountId}/email/routing/addresses`);

  if (!listed.ok) {
    await auditedBatch(
      env, ctx, orgId,
      {
        action: "provider.verified_destinations_read", outcome: "failed", actorUserId,
        subject: accountId, detail: { accountId, authority, error: listed.error },
      },
      (entry) => [entry, readRow(env, { accountId: null, authority, readAt: null, at, error: listed.error })],
    );
    return { ...await stateOf(env, orgId), listed: null, addresses: null };
  }
  // Every listed address with its state, for the kept forwards and the counts; the addresses leave only in the answer.
  const all: Listed[] = listed.result.flatMap((one) => {
    const parsed = listedOf(one);
    return parsed === null ? [] : [parsed];
  });
  const states = JSON.stringify(Object.fromEntries(all.map((one) => [one.email.toLowerCase(), one.state])));

  /*
   * `verified` non-null is Cloudflare's documented test, and it agrees with `status: "verified"` on every
   * measured row. Keyed on the email as listed: SQL folds both sides with lower(), and JavaScript folding
   * here would be a second rule. The timestamp is normalized because it is compared as text against
   * `submission_state_at`, which is `toISOString()` output, and the exact shape of Cloudflare's string was
   * never printed; an offset or missing milliseconds would break the ordering toward explained. One that
   * does not parse is not stored, which errs toward alarm.
   */
  const verified = JSON.stringify(Object.fromEntries(listed.result.flatMap((one) => {
    const when = typeof one.verified === "string" ? Date.parse(one.verified) : Number.NaN;
    return typeof one.email === "string" && one.email !== "" && Number.isFinite(when)
      ? [[one.email, new Date(when).toISOString()]] : [];
  })));

  // Both counts before the batch, for the audit entry, which carries counts because the trail is permanent.
  // A SELECT with no FROM answers exactly one row, so the non-null assertion below cannot be reached by data.
  const counted = (await env.CATALOG.prepare(
    `SELECT (SELECT COUNT(DISTINCT lower(address)) FROM send_recipients
              WHERE org_id = ?1 AND submission_state = 'handed_over') AS recipients,
            (SELECT COUNT(DISTINCT lower(r.address))
               FROM send_recipients r JOIN json_each(?2) j ON lower(j.key) = lower(r.address)
              WHERE r.org_id = ?1 AND r.submission_state = 'handed_over') AS kept`,
  ).bind(orgId, verified).first<{ recipients: number; kept: number }>())!;

  await auditedBatch(
    env, ctx, orgId,
    {
      action: "provider.verified_destinations_read", outcome: "ok", actorUserId, subject: accountId,
      detail: {
        accountId, authority, recipients: counted.recipients, kept: counted.kept,
        listedVerified: all.filter((one) => one.state === "verified").length,
        listedWaiting: all.filter((one) => one.state === "waiting").length,
      },
    },
    (entry) => [
      entry,
      /*
       * Only the intersection, and never a removal. Keep the WHERE clause: SQLite's upsert-from-SELECT needs
       * one to parse. MAX(j.value) picks the later of two listed spellings of one address, which is the later
       * instant only because the timestamps were normalized above.
       */
      env.CATALOG.prepare(
        `INSERT INTO verified_destination_recipients (org_id, address, verified_from, verified_until)
           SELECT ?1, lower(r.address), MAX(j.value), ?2
             FROM send_recipients r JOIN json_each(?3) j ON lower(j.key) = lower(r.address)
            WHERE r.org_id = ?1 AND r.submission_state = 'handed_over'
            GROUP BY lower(r.address)
         ON CONFLICT (org_id, address) DO UPDATE
           SET verified_from = excluded.verified_from, verified_until = excluded.verified_until`,
      ).bind(orgId, at, verified),
      readRow(env, { accountId, authority, readAt: at, at, error: null }),
      /*
       * Each kept forward's destination as this read found it (ADR 47): the re-check People's "verified" comes from.
       * Absent from the list is `absent`, a state of its own: forward() to it throws, as to a waiting one.
       */
      env.CATALOG.prepare(
        `UPDATE addresses SET kept_forward_checked_at = ?2,
           kept_forward_verified = COALESCE((SELECT j.value FROM json_each(?3) j WHERE j.key = lower(addresses.kept_forward_to)), 'absent')
         WHERE org_id = ?1 AND kept_forward_to IS NOT NULL`,
      ).bind(orgId, at, states),
    ],
  );
  return {
    ...await stateOf(env, orgId),
    listed: { verified: all.filter((one) => one.state === "verified").length, waiting: all.filter((one) => one.state === "waiting").length },
    addresses: options.addresses === true ? all : null,
  };
}

/**
 * The one read row, written by every attempt. A failed attempt passes null for the account and the read
 * time, and COALESCE keeps the last success's, so "the read of … still stands" stays answerable.
 */
function readRow(
  env: Env,
  row: { accountId: string | null; authority: string; readAt: string | null; at: string; error: string | null },
): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT INTO verified_destination_read (id, account_id, authority, read_at, attempted_at, error)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       account_id = COALESCE(excluded.account_id, verified_destination_read.account_id),
       authority = excluded.authority,
       read_at = COALESCE(excluded.read_at, verified_destination_read.read_at),
       attempted_at = excluded.attempted_at, error = excluded.error`,
  ).bind(row.accountId, row.authority, row.readAt, row.at, row.error);
}

/** What the latest attempt left, in one statement. Counts only. */
async function stateOf(env: Env, orgId: string): Promise<Omit<VerifiedDestinations, "listed" | "addresses">> {
  const row = await env.CATALOG.prepare(
    `SELECT rd.account_id, rd.read_at, rd.attempted_at, rd.error,
       (SELECT COUNT(DISTINCT lower(address)) FROM send_recipients
         WHERE org_id = ?1 AND submission_state = 'handed_over') AS recipients,
       (SELECT COUNT(*) FROM verified_destination_recipients
         WHERE org_id = ?1 AND verified_until = rd.read_at) AS verified
     FROM verified_destination_read rd WHERE rd.id = 1`,
  ).bind(orgId).first<{
    account_id: string | null; read_at: string | null; attempted_at: string; error: string | null;
    recipients: number; verified: number;
  }>();
  if (row === null) {
    // Every caller has just written this row in the same request, so its absence is a fault, said as one.
    // Unreachable by any test for that reason: `mutants` reports this guard's removal as surviving, accepted.
    throw new Error("verified_destination_read holds no row immediately after an attempt recorded one");
  }
  return {
    accountId: row.account_id, readAt: row.read_at, attemptedAt: row.attempted_at, error: row.error,
    recipients: row.recipients, verified: row.read_at === null ? null : row.verified,
  };
}
