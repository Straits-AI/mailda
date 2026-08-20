import { BUDGETS } from "@mailda/budgets";
import { butler as butlerSchema, type Butler } from "@mailda/butler-ast";
import type { Ctx } from "@mailda/runtime";

import { log } from "../audit.ts";
import type { ButlerRunPayload } from "./interpret.ts";

/**
 * What starts a run: one delivery, every published Butler listening on the mailbox it landed in (#50).
 *
 * ## The instance id is the whole idempotency mechanism
 *
 * `<butlerVersionId>-<triggerKey>`, where the trigger key is the `msg_` id of the delivery. `create({ id })`
 * **throws `instance.already_exists`** on a duplicate within the instance's retention window, so the same
 * delivery cannot start two runs of the same version — and the refusal comes from the platform rather than
 * from a check written here. That is conflict-is-the-signal, the pattern already carrying the audit
 * sequence, the migration ledger, `send_recipient_events` and the claim CAS. §16's `forbid` overlap policy
 * is therefore free.
 *
 * It matters because this function is called from an **at-least-once** pipeline: `materialiseReceipt` is
 * driven by an outbox event, and #9's model is explicit that a handler will see the same event twice and
 * must not care.
 *
 * Three things that must not be conflated, each stated because each is easy to get wrong:
 *
 * - **The run id is not an ADR 9 effect key.** It dedups the *trigger*. Every sending step still mints its
 *   own effect key — the manifest id — so one intent produces one run and many effects.
 * - **The dedup window is 30 days**, being the instance retention. After it the same id is creatable again.
 *   That is a property of the platform, not of this design, and `butler_runs`' primary key is what refuses
 *   the second *record* for ever.
 * - **`createBatch` is not used, and must not be.** It **silently skips** a duplicate id and excludes it
 *   from the returned array — measured at 4 requested, 1 returned, no error. A fan-out built on it drops
 *   runs with nothing to notice. `create` per item is what makes a duplicate throw.
 *
 * ## What is measured locally and what is not, said rather than assumed
 *
 * The throw was measured against the real platform (`workflow-provisioning.md`). **Miniflare's local
 * Workflows emulation does not reproduce it**: its `create` resolves and swallows the initialisation
 * failure, so a duplicate returns a handle and starts no second run. So locally the *outcome* holds — one
 * run per delivery — while the *refusal* is invisible. This function therefore counts a resolved `create` as
 * started and a thrown `already_exists` as a duplicate, and `test/butler-run.test.ts` proves both arms: the
 * outcome against real storage, and the handling against a binding that throws.
 *
 * ## Matching is a JSON parse per published Butler, and that is a deliberate cost
 *
 * A trigger lives inside `ast_json`, which is a blob (0027 argues why), so no index can answer *"which
 * Butlers listen on this address"*. This reads every published version for the organization — one query on
 * `btv_live`, which is partial on `state = 'published'` — and parses each. The alternative is a projected
 * trigger column, which is a second copy of a fact inside the frozen AST and therefore a thing that can
 * disagree with the program. At the scale a Node publishes Butlers that trade is obviously right; the day it
 * is not, the fix is an index built *from* the AST at publication, not a column an author can set.
 *
 * ## This runs in the sweeper's invocation, not in the run's
 *
 * Its cost is charged to whatever invoked `materialiseReceipt`, not to any Butler's pot.
 * `docs/receipts/butler-run-cost.md` measures it separately for that reason.
 */

/**
 * The facts a `mail.received` run reads as `event.*`. Closed, so an author can be told what is there.
 *
 * A `type` rather than an `interface`, and that is load-bearing rather than a style choice: TypeScript infers
 * an implicit index signature for an object *type alias* and not for an interface, so only this form is
 * assignable to the payload's `Readonly<Record<string, unknown>>` without a cast. A cast there would be the
 * one place in this file where the compiler stopped checking that the run's `event` root is exactly these
 * fields.
 */
export type DeliveryFacts = {
  readonly message_id: string;
  readonly conversation_id: string | null;
  readonly case_id: string | null;
  readonly mailbox_id: string;
  readonly mailbox_address: string;
  readonly subject: string;
  readonly from: string;
  readonly received_at: string;
  /** Non-null when the message's headers could not be read. §24 keeps such a message, visibly unparsed. */
  readonly parse_error: string | null;
};

export interface TriggerOutcome {
  /** Instance ids created by this call. */
  readonly started: readonly string[];
  /** Instance ids the platform refused because a run for this delivery already exists. */
  readonly duplicates: readonly string[];
  /** Published Butlers whose trigger names a different mailbox. */
  readonly notListening: number;
  /**
   * Published versions this call started nothing for, and **not** because of their trigger.
   *
   * Two causes, and the field is named for what it means to a caller rather than for either of them: the
   * stored AST would not parse as a Butler at all, or the run's id would not fit
   * `workflow.instance_id_max_chars`. It was called `unreadable` first, which was a name overclaiming a
   * cause — an over-long id is a perfectly readable program — and a caller cannot act differently on the two
   * anyway, since both mean *this Butler did not run and the log says why*. The log entry is what
   * distinguishes them, and it names the version in both cases.
   */
  readonly notStarted: readonly string[];
}

interface VersionRow {
  id: string;
  butler_id: string;
  ast_json: string;
}

/** Whether a `create` failure is the platform refusing a duplicate rather than a fault. */
function isDuplicate(error: unknown): boolean {
  // Matched on the documented error name rather than on a code, because the platform reports it as
  // `instance.already_exists` and a numeric code for it is not published. Narrow on purpose: anything else
  // is a real failure and must not be counted as "already running".
  return /instance\.already_exists|already exists/i.test((error as Error)?.message ?? "");
}

/**
 * The facts of one delivery, or null when it is not one this Node can attribute.
 *
 * One query. The mailbox comes through `ingress_receipts.envelope_to` → `addresses`, which is the only thing
 * that says where a message actually landed — `messages` carries no mailbox column, and organization
 * membership is a different question. The case is joined on `(conversation, mailbox)` because that is the key
 * `caseForDelivery` files it under.
 */
async function deliveryFacts(env: Env, orgId: string, messageId: string): Promise<DeliveryFacts | null> {
  const row = await env.CATALOG.prepare(
    `SELECT m.id AS message_id, m.conversation_id, m.subject, m.from_addr, m.received_at, m.parse_error,
            a.mailbox_id, a.address AS mailbox_address, k.id AS case_id
       FROM messages m
       JOIN ingress_receipts r ON r.org_id = m.org_id AND r.id = m.ingress_receipt_id
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
       LEFT JOIN cases k ON k.org_id = m.org_id AND k.conversation_id = m.conversation_id
                        AND k.mailbox_id = a.mailbox_id
      WHERE m.org_id = ? AND m.id = ? LIMIT 1`,
  ).bind(orgId, messageId).first<{
    message_id: string; conversation_id: string | null; subject: string | null; from_addr: string | null;
    received_at: string; parse_error: string | null; mailbox_id: string; mailbox_address: string;
    case_id: string | null;
  }>();
  if (row === null) return null;
  return {
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    case_id: row.case_id,
    mailbox_id: row.mailbox_id,
    mailbox_address: row.mailbox_address,
    // Empty rather than null: `event.subject` is a string an expression interpolates, and a message with an
    // unreadable or absent Subject genuinely has none. `parse_error` is what says which of the two it was.
    subject: row.subject ?? "",
    from: row.from_addr ?? "",
    received_at: row.received_at,
    parse_error: row.parse_error,
  };
}

/**
 * Starts a run of every published Butler listening on the mailbox this message landed in.
 *
 * Never throws for a reason that belongs to one Butler: a version whose stored AST will not parse is
 * counted, logged and skipped, so one bad row cannot stop every other Butler on the Node from firing. A
 * failure to reach D1 or the workflow binding *does* propagate, because the caller is an outbox handler and
 * leaving the event unpublished is what makes the retry happen (#9, ADR 31).
 */
export async function triggerButlers(
  env: Env,
  ctx: Ctx,
  orgId: string,
  messageId: string,
): Promise<TriggerOutcome> {
  const facts = await deliveryFacts(env, orgId, messageId);
  if (facts === null) {
    // A message with no attributable mailbox: its address was removed, or the receipt is gone. Nothing to
    // trigger, and not an error — the same judgement `materialiseReceipt` makes about a receipt that has
    // disappeared, for the same reason: raising would wedge the outbox on an event that can never succeed.
    return { started: [], duplicates: [], notListening: 0, notStarted: [] };
  }

  const { results } = await env.CATALOG.prepare(
    `SELECT id, butler_id, ast_json FROM butler_versions
      WHERE org_id = ? AND state = 'published'`,
  ).bind(orgId).all<VersionRow>();

  const started: string[] = [];
  const duplicates: string[] = [];
  const notStarted: string[] = [];
  let notListening = 0;
  const wanted = facts.mailbox_address.trim().toLowerCase();

  for (const version of results) {
    let ast: Butler;
    try {
      // The envelope only, through the AST's own schema. Not `checkButler`: matching a trigger needs the
      // trigger, and a version whose *graph* has become uncheckable — a node moved from shipped to reserved
      // since it was published — must still be able to start a run, because the run is where that refusal
      // belongs and where it becomes visible to a person. `interpret` re-checks and refuses it there.
      ast = butlerSchema.parse(JSON.parse(version.ast_json));
    } catch {
      notStarted.push(version.id);
      continue;
    }

    if (ast.trigger.event !== "mail.received") {
      // Unreachable while `mail.received` is the only member of the trigger enum, and written rather than
      // asserted because the enum is what #49 says will grow: the day a second trigger exists, a Butler
      // listening for it must not fire on a delivery.
      notListening += 1;
      continue;
    }
    if (ast.trigger.mailbox.trim().toLowerCase() !== wanted) {
      notListening += 1;
      continue;
    }

    /*
     * The id, and the one bound worth checking: `workflow.instance_id_max_chars = 100` is documented, and a
     * typed-prefix ULID pair comes to 61 — so this is a tripwire past where any real id goes, and only a
     * changed id scheme reaches it. Refusing here rather than letting `create` reject it means the Butler is
     * named in the log instead of the failure arriving as an opaque platform error.
     */
    const instanceId = `${version.id}-${facts.message_id}`;
    if (instanceId.length > BUDGETS["workflow.instance_id_max_chars"]) {
      await log(env, ctx, {
        level: "error",
        event: "butler.instance_id_too_long",
        message: `E_BUDGET_EXCEEDED  workflow.instance_id_max_chars=`
          + `${BUDGETS["workflow.instance_id_max_chars"]}, this run's id would be ${instanceId.length}`,
        orgId,
        detail: { versionId: version.id, messageId: facts.message_id },
      }).catch(() => undefined);
      notStarted.push(version.id);
      continue;
    }

    const payload: ButlerRunPayload = {
      orgId,
      butlerId: version.butler_id,
      butlerVersionId: version.id,
      trigger: { event: ast.trigger.event, key: facts.message_id, facts },
    };

    try {
      // `create`, one per Butler, never `createBatch` — see the header.
      await env.BUTLER_RUNS.create({ id: instanceId, params: payload });
      started.push(instanceId);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      duplicates.push(instanceId);
    }
  }

  return { started, duplicates, notListening, notStarted };
}
