import { type Bytes, utf8 } from "@mailda/evidence";
import { ID_PREFIXES, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { type AuditEvent, auditedBatchMany } from "../audit.ts";
import { describeShortfall, planApproval, type Shortfall } from "../approvals.ts";
import { decidersOf } from "../deciders.ts";
import { maySend, readableSubjects } from "../authz-read.ts";
import { conflict, notFound } from "../errors.ts";
import { putEvidence } from "../evidence-store.ts";
import { evaluateBreakers, describeTrip, RATE_BREAKERS, type RateReading } from "../breakers.ts";
import { BUTLER_RELEASE_REASON } from "../butler/gate.ts";
import { domainOf, evaluate, requiredStages, STATE_FOR, type Outcome } from "../policy.ts";
import { domainPaused } from "./recheck.ts";
import { HeaderBlock, normalizeAddress } from "./headers.ts";
import { headerFields, headerBlock, messageIds } from "../mime.ts";
import { getEvidence } from "../evidence-store.ts";

/**
 * Sealing a composition manifest (§1429, ADR 35).
 *
 * A manifest is created for **every** send, not only those a policy required review for. Otherwise
 * "what did we send?" has two different answers depending on whether a policy happened to apply,
 * §12's second invariant becomes conditional, and the path with no record is the majority one.
 *
 * ## Sealing is a distinct act from dispatching
 *
 * `sealManifest` produces a row in state `held`. Nothing has been sent. That gap is what makes
 * undo-send honest (ADR 39) — cancelling stops something that genuinely never left — and it is also
 * what an approval binds to (Layer 5).
 *
 * ## Editing a sealed manifest is not an operation
 *
 * A revision calls this again and gets a **new id**. Since approval binds an id, the old approval
 * references a manifest nobody will dispatch, so ADR 11's "any material edit invalidates it" is a
 * property of the identifiers rather than a rule someone must remember to enforce.
 *
 * ## Two bodies
 *
 * Normalization happens **here**, before sealing, so the bytes sent are the bytes approved —
 * normalizing afterwards would contradict ADR 11 outright. The author's typed original is stored
 * alongside, because if normalization ever changes meaning a record holding only the normalized form
 * cannot settle the dispute. Both are R2 evidence; only their hashes reach D1 (§12).
 *
 * ## The policy decision happens here, and the state it produces is not always `held`
 *
 * §18 places the policy decision between authorization and the effect intent, which is exactly where this
 * sits — and #60 makes it *this* function rather than dispatch for a stronger reason: the outcome
 * **determines the state**, and the state has to exist when the manifest does. A manifest that is sealed now
 * and gated later has a window in which it reads as sendable.
 *
 * So `SealedManifest.state` is one of three: `held` when policy allowed, `awaiting` when it holds or requires
 * approval, `withheld` when it denied. See `STATE_FOR` in `src/policy.ts` for the mapping and the argument
 * for `deny` landing in `withheld` rather than in `awaiting`.
 *
 * **Re-evaluation at dispatch is built, in `src/outbound/recheck.ts`** (#62). The manifest *binds* the version
 * set it was decided under (`policy_versions`) and the result (`policy_outcome`); the decision at dispatch uses
 * the **current** policy, because that is what honours §18's "stricter policy fails closed". `policy_outcome`
 * is also what tells `dispatchOne` which path a send is on, at no cost — which is why it is written once here
 * and never rewritten, not even when an approval releases the send.
 *
 * ## `require_approval` requests the approval here, in the same transaction (#61)
 *
 * A gated manifest with no request to decide would be a send waiting on something nobody can clear, which is
 * the state #60 refused to let `deny` occupy. So the `approvals` row, its frozen stage set and **both** audit
 * entries — `send.sealed` and `approval.requested` — ride in this function's one `batch()`. A seal that exists
 * without its approval is therefore not unlikely, it is unrepresentable.
 *
 * And if the stages cannot be satisfied — too few `approval.decide` holders on the mailbox once the author is
 * removed — the send is **withheld** with `approval_unsatisfiable` and no approval row is written at all. There
 * is nothing to decide, so a pending request would be a queue of dead work; the shortfall goes into the seal's
 * audit detail and into `last_error`, naming which stage and how many short.
 */

const REFERENCES_MAX = BUDGETS["send.references_emitted_max"];
const HOLD_DEFAULT = BUDGETS["send.hold_window_default_seconds"];

/** ADR 33. Required of every caller, never inferred — the record's worth depends on it. */
export type Fidelity = "authored" | "reconstructed";

export interface Composition {
  mailboxId: string;
  authorUserId: string;
  /**
   * Which of the mailbox's addresses to send as. Required when the mailbox has more than one.
   *
   * A mailbox may have several addresses — `addresses` is unique on the address, **not** on `mailbox_id` —
   * and From used to be chosen by `ORDER BY created_at LIMIT 1`, the oldest. So adding `billing@` to a
   * support mailbox made billing replies go out as `support@`, decided by a timestamp, with nothing saying
   * so. The grain of `send.propose` is still the mailbox (ADR 36); what changed is that the *choice* is no
   * longer silent.
   */
  senderAddress?: string;
  /** Our own `msg_` id when this is a reply. The threading chain is read from its evidence. */
  inReplyToMessageId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Exactly what the author typed. Stored unchanged. */
  bodyTyped: string;
  fidelity: Fidelity;
  /**
   * True when the author is a program with no person present, so the send needs a human release (#50).
   *
   * Set by the Butler engine and by nothing else. It is a parameter here rather than a second write by the
   * caller for the reason the policy decision moved into this function: **the outcome determines the state,
   * and the state has to exist when the manifest does.** A manifest sealed `held` and gated a moment later
   * has a window in which it reads as sendable — and `dispatchDue`'s sweeper reads exactly that column, so
   * the window is not theoretical.
   *
   * Named for the property rather than for the caller (`proposedByButler` would be a name that goes stale
   * the first time anything else proposes a send without a person). Its rank in the order below, and the
   * argument for it, are in `src/butler/gate.ts`.
   */
  releaseRequired?: boolean;
}

export interface SealedManifest {
  id: string;
  /**
   * `held` when policy allowed, `awaiting` when it gated, `withheld` when it denied (#60) — and `awaiting`
   * with `butler_release_required` when a program proposed it and no person has released it yet (#50).
   */
  state: "held" | "awaiting" | "withheld";
  releaseAt: string;
  rfcMessageId: string;
  referencesHeader: string | null;
  /** The `max` over every matching policy. `allow` when nothing matched. */
  policyOutcome: Outcome;
  /**
   * Which policy versions decided this, in the order they were read. Empty when none matched — which is a
   * real answer, not a gap: it means the send *was* evaluated and no rule applied.
   */
  policyVersionIds: string[];
  /**
   * The machine token behind a gated or refused state, and NULL when `held`.
   *
   * A token rather than a sentence, deliberately: the words for every send state and reason live in
   * `src/client/delivery.client.js`, which is the one place with a test over them. Two copies of the same
   * sentence is how the authoritative one becomes whichever file the reader opened.
   */
  stateReason: string | null;
  /**
   * The approval this send is waiting on, or null. Null for three different reasons — no policy required one,
   * a policy denied the send outright, or the stages could not be satisfied — and `stateReason` is what
   * distinguishes them, which is the whole reason that column carries a token rather than a boolean.
   */
  approvalId: string | null;
  /** Why no approval could be requested, when that is why this send is `withheld` (#61). */
  approvalShortfall: Shortfall | null;
  /**
   * The rate breaker that gated this send, or null (#66).
   *
   * Returned rather than left to the outbox, because AGENTS.md requires a developer to see the limit at the
   * moment they hit it: this carries `limit`, `observed`, `observations` and `retryAfterSeconds`, so an agent
   * composing in a loop can back off by a number rather than by guessing. `GET /api/breakers` answers the
   * same question **before** the send, which is the other half of that rule.
   */
  breaker: RateReading | null;
  /**
   * The four-part sentence behind a breaker state, or null. Also written to `send_manifests.last_error`, so
   * the caller and the outbox row say the same thing rather than two things that could drift.
   */
  breakerError: string | null;
}

/**
 * Normalization.
 *
 * Deliberately conservative, and deliberately *not* an HTML transform: this normalizes line endings
 * to CRLF and strips trailing whitespace, which is what RFC 5322 requires on the wire and what a
 * recipient's client would otherwise vary on. Anything that could change *meaning* — rewriting HTML,
 * rewrapping paragraphs, "smart" quotes — is excluded, because ADR 35 binds approval to this output
 * and a normalizer that alters meaning would mean an approver reviewed something else.
 *
 * When richer composition arrives (still fog at this layer), whatever it adds belongs here and the
 * approval story has to be re-argued rather than inherited.
 */
export function normalizeBody(typed: string): string {
  return typed
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\r\n");
}

/**
 * Where one send's staged evidence lives. **One spelling**, shared by the two writers and the reconciler.
 *
 * `sealManifest` writes `typed.txt` and `normalized.txt` here; `dispatchOne` writes `submitted.eml` here; and
 * `reconcile.ts` lists `sentPrefix` to find objects whose `send_manifests` row is gone (#74). Three spellings
 * would be three things that can disagree, and the disagreement is silent in the worst direction — a
 * reconciler listing a prefix nothing writes and reporting it clean, which is #67's defect with the roles
 * reversed. `exportDestination` and `exportsPrefix` in `src/exports.ts` set the shape;
 * `test/node/evidence-prefix-world.test.ts` is what makes "one spelling" a property rather than a claim.
 */
export function sentObjectKey(orgId: string, manifestId: string, name: string): string {
  return `${sentPrefix(orgId)}${manifestId}/${name}`;
}

/** The prefix every send in one organization stages under — what the reconciler lists (#74). */
export function sentPrefix(orgId: string): string {
  return `${orgId}/sent/`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Rebuilds the `References` chain for a reply, **bounded**.
 *
 * ADR 27 stores only two threading anchors — root and parent — because a stored chain grows with its
 * thread and §11B's shard arithmetic depends on a constant per-message cost. The chain is therefore
 * reconstructed here from the original's own MIME.
 *
 * Bounded rather than faithful, and the bound is not cosmetic: Cloudflare **rejects a reply** whose
 * incoming message carries more than 100 `References` entries (receipt:
 * `cloudflare-email-sending.md`). A long thread loses its middle, keeping the root and the immediate
 * parent — the two entries that actually decide threading — which is what every other client does.
 */
export async function rebuildReferences(
  env: Env,
  parentBlobKey: string,
  parentRfcMessageId: string,
): Promise<string | null> {
  let chain: string[];
  try {
    const raw = await getEvidence(env, parentBlobKey);
    const fields = headerFields(headerBlock(raw));
    chain = messageIds(fields.get("references")?.[0] ?? "");
  } catch {
    // The parent's evidence is unreadable. Threading on the parent's id alone is degraded but
    // correct; refusing to reply because the archive is damaged would be worse.
    chain = [];
  }

  const full = [...chain, parentRfcMessageId].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  if (full.length === 0) return null;
  if (full.length <= REFERENCES_MAX) return full.map((id) => `<${id}>`).join(" ");

  // Keep the root and the most recent entries; drop the middle.
  const kept = [full[0]!, ...full.slice(-(REFERENCES_MAX - 1))];
  return kept.map((id) => `<${id}>`).join(" ");
}

export async function sealManifest(
  env: Env,
  ctx: Ctx,
  orgId: string,
  composition: Composition,
): Promise<SealedManifest> {
  // Authorization first, before the mailbox is even looked up.
  //
  // The order is the point. Below, a mailbox that does not exist and a mailbox with no address raise
  // *different* errors — useful when it is your own mailbox, and an organisation-wide oracle when it is
  // not: a caller could enumerate which mailbox ids exist by reading which refusal came back. Checking
  // authority first collapses every unauthorized case to one answer.
  //
  // §7 evaluates this per request against live tuples, so revoking the relation takes effect on the next
  // seal with nothing to invalidate.
  if (!(await maySend(env, { orgId, userId: composition.authorUserId }, composition.mailboxId))) {
    throw notFound("E_MAY_NOT_SEND_AS_MAILBOX", {
      what: "no mailbox you may send as matches this request",
      why: "sending as a mailbox is a distinct authority from reading it (§7), and it was not held",
      fix: "ask an administrator for send.propose on this mailbox",
    });
  }

  const mailbox = await env.CATALOG.prepare(
    "SELECT id, hold_window_seconds FROM mailboxes WHERE org_id = ? AND id = ? LIMIT 1",
  )
    .bind(orgId, composition.mailboxId)
    .first<{ id: string; hold_window_seconds: number | null }>();

  if (mailbox === null) {
    throw notFound("E_NO_SUCH_MAILBOX", {
      what: `${composition.mailboxId} is not a mailbox in this organization`,
      why: "From is the mailbox (ADR 36), so a manifest cannot be sealed without one",
      fix: "compose from a mailbox the author has access to",
    });
  }

  /**
   * From, chosen rather than assumed.
   *
   * Every address on the mailbox, oldest first — the order the previous version silently picked from. One
   * address needs no ceremony; more than one is a decision with consequences for every recipient, and this
   * refuses rather than picking. Same reasoning as merge: a choice a person would want to make must not be
   * made by `created_at`.
   */
  const { results: mailboxAddresses } = await env.CATALOG.prepare(
    "SELECT address FROM addresses WHERE org_id = ? AND mailbox_id = ? ORDER BY created_at",
  )
    .bind(orgId, composition.mailboxId)
    .all<{ address: string }>();

  let address: { address: string } | null = mailboxAddresses[0] ?? null;

  if (composition.senderAddress !== undefined) {
    // Verified against this mailbox, not merely well-formed. Otherwise `senderAddress` would be a way to
    // send as an address routed to a mailbox the author holds nothing on, which is the authority
    // `send.propose` is bound to.
    // Compared case-insensitively on the whole address rather than by `===`, so a caller echoing back
    // `Support@Acme.example` from a display is not refused for capitalisation. `normalizeAddress` throws on
    // a control character, which is the injection guard, so it runs on the caller's value first.
    const wanted = normalizeAddress("senderAddress", composition.senderAddress).toLowerCase();
    const named = mailboxAddresses.find((row) => row.address.trim().toLowerCase() === wanted);
    if (named === undefined) {
      throw notFound("E_SENDER_NOT_ON_MAILBOX", {
        what: `${composition.senderAddress} is not an address of the mailbox you are sending as`,
        why: "From is bound to the mailbox (ADR 36), so the sender must be one of its own addresses",
        fix: mailboxAddresses.length === 0
          ? "give this mailbox an address first"
          : `use one of: ${mailboxAddresses.map((row) => row.address).join(", ")}`,
      });
    }
    address = named;
  } else if (mailboxAddresses.length > 1) {
    // Refused, not guessed. Naming the addresses because the fix is to pick one, and a refusal a person
    // cannot act on is a complaint.
    throw conflict("E_SENDER_AMBIGUOUS", {
      what: `mailbox ${composition.mailboxId} has ${mailboxAddresses.length} addresses, so which one this `
        + "is from is not decided",
      why: "the previous behaviour picked the oldest by created_at, which is a choice about what every "
        + "recipient sees being made by a timestamp",
      fix: `name one of: ${mailboxAddresses.map((row) => row.address).join(", ")}`,
    });
  }

  if (address === null) {
    throw conflict("E_MAILBOX_HAS_NO_ADDRESS", {
      what: `mailbox ${composition.mailboxId} has no address to send from`,
      why: "ADR 36 makes From the mailbox, and a mailbox with no address cannot be one",
      fix: "add a routed address to this mailbox first",
    });
  }

  // Validated *through the builder* before anything is persisted, rather than by a parallel set of
  // checks that could drift from it. A value that survives sealing is therefore a value the wire form
  // will accept — and addresses are stored already punycoded, so the domain is encoded once rather
  // than on every render.
  new HeaderBlock().add("Subject", composition.subject);
  const to = composition.to.map((address) => normalizeAddress("to", address));
  const cc = (composition.cc ?? []).map((address) => normalizeAddress("cc", address));
  const bcc = (composition.bcc ?? []).map((address) => normalizeAddress("bcc", address));

  const manifestId = ctx.id(ID_PREFIXES.sendManifest);
  const at = new Date(ctx.now()).toISOString();

  // The hold window (ADR 39). NULL means the default; 0 means dispatch immediately. Zero is a
  // legitimate configuration, not a missing value, which is why the column distinguishes them.
  const hold = mailbox.hold_window_seconds ?? HOLD_DEFAULT;
  const releaseAt = new Date(ctx.now() + hold * 1000).toISOString();

  // Threading. A reply's chain is rebuilt from the original's evidence, bounded.
  let referencesHeader: string | null = null;
  if (composition.inReplyToMessageId !== undefined) {
    // Bounded by **read authority on the parent**, not merely by organization.
    //
    // This check used to be `WHERE org_id = ? AND id = ?`, while the refusal below claimed "a reply threads
    // onto a message the author can see". Organization membership is not seeing it. `messages` carries no
    // mailbox column, so nothing consulted where the parent was actually delivered — and a principal holding
    // `send.propose` on one mailbox and nothing at all on another could name a message delivered only into
    // the second and receive its `References` chain and its Message-ID, persisted here and emitted on the
    // wire. Reproduced before fixing, in `test/reply-parent-authority.test.ts`.
    //
    // Two consequences worse than the disclosure itself, which is why this is bounded in the SQL rather than
    // filtered afterwards: the emitted `In-Reply-To` and `References` **inject the reply into the foreign
    // thread** in every external participant's client, and the difference between a refusal and a success is
    // an org-wide existence oracle for message ids.
    //
    // The authority is the one `listMessages` already uses — `mailbox.content.read` on the mailbox the
    // parent was delivered into, reached through `ingress_receipts.envelope_to` → `addresses`. Same subjects
    // (the user plus every team they belong to), same tuple shape, so a reply cannot thread onto something
    // the inbox would not have shown them.
    const subjects = await readableSubjects(env, { orgId, userId: composition.authorUserId });
    const placeholders = subjects.map(() => "?").join(", ");
    const parent = await env.CATALOG.prepare(
      `SELECT m.rfc_message_id, m.blob_key
         FROM messages m
         JOIN ingress_receipts r ON r.org_id = m.org_id AND r.id = m.ingress_receipt_id
         JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
        WHERE m.org_id = ? AND m.id = ?
          AND a.mailbox_id IN (
            SELECT object_id FROM relationship_tuples
             WHERE org_id = ? AND subject_id IN (${placeholders})
               AND object_type = 'mailbox' AND relation = 'mailbox.content.read'
          )
        LIMIT 1`,
    )
      .bind(orgId, composition.inReplyToMessageId, orgId, ...subjects)
      .first<{ rfc_message_id: string; blob_key: string }>();
    // Refused rather than silently ignored, and **not-found rather than forbidden**: §5C requires an
    // invisible thing and an absent one to answer alike, which is what stops this being the oracle described
    // above. Persisting an unverified id would leave `renderRfc822` to resolve it later and put a Message-ID
    // the author never had access to into an outgoing header. Storing an id nothing verified is the actual
    // defect; the header is just where it becomes visible.
    if (parent === null) {
      throw notFound("E_NO_SUCH_PARENT", {
        what: `${composition.inReplyToMessageId} is not a message you can reply to`,
        why:
          "a reply threads onto a message the author can read; an unverified id would be resolved at " +
          "render time and disclosed to the recipient",
        fix: "reply to a message in a mailbox you may read",
      });
    }
    // The In-Reply-To header itself is derived in renderRfc822 from the stored parent id, so it is
    // not duplicated here — one place decides what reaches the wire.
    referencesHeader = await rebuildReferences(env, parent.blob_key, parent.rfc_message_id);
  }

  /**
   * The policy decision (#60), after the parent is resolved and before anything is persisted.
   *
   * After the parent, because `is_reply` is one of the five conditions and a named parent that fails the
   * authority check above must refuse rather than be evaluated as a reply. Before the writes, because the
   * outcome decides the state the row is inserted with — the whole reason evaluation is here rather than at
   * dispatch. The refusals above still come first: an unauthorized send is refused without a policy being
   * consulted, so a policy denial never becomes a way to learn that a mailbox exists.
   */
  const decision = await evaluate(env, ctx, orgId, {
    mailboxId: composition.mailboxId,
    actorUserId: composition.authorUserId,
    recipients: [...to, ...cc, ...bcc],
    isReply: composition.inReplyToMessageId !== undefined,
  });
  let { state: sealedState, reason: stateReason } = STATE_FOR[decision.outcome];

  /**
   * The approval (#61), planned before anything is persisted because it can change the state this manifest is
   * sealed with.
   *
   * Costs two queries and **only on the `require_approval` path**, which is the same laziness `evaluate` uses
   * for its two derived inputs: a send no policy gated pays nothing for a mechanism it does not touch
   * (receipt: `approval-decision-cost.md`).
   *
   * The stage set is folded over every matching `require_approval` version — `max` per ordinal, which is #60's
   * own conflict resolution rather than a second rule — because two policies requiring approval of one send are
   * both in force.
   */
  let approvalId: string | null = null;
  let approvalShortfall: Shortfall | null = null;
  let approvalStatements: D1PreparedStatement[] = [];
  let approvalEvent: AuditEvent | null = null;
  if (decision.outcome === "require_approval") {
    const stages = await requiredStages(
      env,
      decision.matched.filter((match) => match.outcome === "require_approval").map((match) => match.versionId),
    );
    const deciders = await decidersOf(env, orgId, composition.mailboxId);
    const planned = planApproval(env, ctx, orgId, {
      // The subject is this manifest. `subject_kind` is written rather than implied by the id's prefix, for
      // the reason 0021 gives: a kind the writer leaves out falls back on a column default, and a default is
      // not a classification.
      subjectKind: "send_manifest",
      subjectId: manifestId,
      scopeId: composition.mailboxId,
      actorUserId: composition.authorUserId,
      stages,
    }, deciders);

    if (planned.satisfiable) {
      approvalId = planned.plan.approvalId;
      approvalStatements = planned.plan.statements;
      approvalEvent = planned.plan.event;
    } else {
      // Withheld rather than parked. The gate exists and nobody can clear it, so `awaiting` would be a state
      // that reads as pending forever — the argument #60 made for keeping `deny` out of it, reached from the
      // other side. Terminal, and the remedy is an administrator's grant plus a re-seal.
      approvalShortfall = planned.shortfall;
      sealedState = "withheld";
      stateReason = "approval_unsatisfiable";
    }
  }

  /**
   * The circuit breakers (#66), evaluated after the policy and folded into the same state and reason.
   *
   * ## Where this sits in the order, and why the order is a total one
   *
   * #60 gave four outcomes a total order so that conflict resolution is one comparison. Two breakers join
   * that order, and both ends are decided rather than incidental:
   *
   *     policy deny  >  domain pause  >  require_approval  >  policy hold  >  butler release  >  rate gate  >  allow
   *
   * **The butler release gate is #50's, and it is above the rate gate for the reason stated three
   * paragraphs down**: a rate gate needs time and a release needs a person. `src/butler/gate.ts` carries the
   * full argument, including why a Butler send does not simply require an approval instead.
   *
   * **A policy denial keeps its reason** even on a paused domain, because a denial is the older and more
   * specific decision — somebody wrote a rule about this send — and overwriting it would hide it. **A pause
   * outranks both gates**, because a gate says *wait* and a pause says *never*, and telling somebody to wait
   * for a condition that no amount of waiting clears is the worst of the four wordings available. **A rate
   * gate ranks below the policy gates**, and that is the load-bearing one: a policy gate needs a *person* to
   * clear it and a rate gate needs *time*, so if both apply, the reason a reader must act on is the human
   * one — and the rate is re-asked at dispatch anyway, after the approval releases the send.
   *
   * ## The rate gate is only ever written over an `allow`
   *
   * `sealedState === "held"` is the guard, and it is not a shortcut for "policy did not gate". It is what
   * keeps the `awaiting` state machine sound: a rate gate is the **one** `awaiting` reason that clears with
   * no act by anybody, so `dispatchDue` admits it back into the sweep. If a policy hold could carry a
   * breaker reason, the sweep would pick up a policy-gated send and hand it over the moment the window
   * cleared — a rate limiter silently releasing mail a policy stopped. See `dispatch.ts`'s widened predicate,
   * which names this dependency from the other end.
   *
   * Costs **one** D1 statement, unconditionally, on every seal (`docs/receipts/send-breakers.md`). Not lazy
   * the way `evaluate`'s two derived inputs are, and that is a real difference worth stating: a policy
   * condition is only asked when some published policy constrains it, while a breaker has no configuration
   * to be absent — it is always in force, so there is nothing to skip.
   */
  const breakers = await evaluateBreakers(env, ctx, orgId, domainOf(address.address));
  let breakerGate: RateReading | null = null;
  let breakerError: string | null = null;

  if (breakers.pause !== null && sealedState !== "withheld") {
    const refusal = domainPaused(domainOf(address.address), breakers.pause);
    sealedState = "withheld";
    stateReason = refusal.reason;
    breakerError = refusal.lastError;
  } else if (composition.releaseRequired === true && sealedState === "held") {
    /*
     * The Butler gate (#50), ranked between the pause and the rate gate.
     *
     * Above the rate gate deliberately, on this function's own rule: a rate gate needs *time* and this
     * needs a *person*, so when both apply the reason a reader must act on is the human one. A Butler send
     * carrying `over_rate` would tell somebody "nothing has to be cleared by anybody and it goes on its
     * own", which is false of it. The rate is re-asked at dispatch after the release, exactly as it is
     * after an approval.
     *
     * Below every policy gate, because `sealedState === "held"` is the guard: a policy hold or an approval
     * keeps its own reason, and a `withheld` send is not re-opened into a queue somebody could clear.
     * `require_approval` is already a human gate, so a second ask on top would mean two people clearing one
     * send for one reason — and when an administrator wants that rule they write it as a policy naming the
     * Butler as actor, which outranks this.
     *
     * No `last_error`: there is nothing wrong. `state_reason` is the whole answer and the words for it live
     * in `src/client/delivery.client.js` with every other send reason.
     */
    sealedState = "awaiting";
    stateReason = BUTLER_RELEASE_REASON;
  } else if (breakers.gate !== null && sealedState === "held") {
    breakerGate = breakers.gate;
    breakerError = describeTrip(breakers.gate);
    sealedState = "awaiting";
    stateReason = RATE_BREAKERS[breakers.gate.breaker].reason;
  }

  const normalized = normalizeBody(composition.bodyTyped);

  // Both bodies to R2, before the row exists. Same ordering rule as ingress: the reachable partial
  // state is an orphan blob rather than a manifest pointing at nothing.
  const typedStored = await putEvidence(
    env, sentObjectKey(orgId, manifestId, "typed.txt"), utf8(composition.bodyTyped),
  );
  const normalizedStored = await putEvidence(
    env, sentObjectKey(orgId, manifestId, "normalized.txt"), utf8(normalized),
  );

  // The Message-ID this Node authors. Derived from the manifest id, so it is stable, unique, and
  // traceable back to its record without a lookup table.
  const senderDomain = address.address.split("@")[1] ?? "invalid";
  const rfcMessageId = `${manifestId}@${senderDomain}`;

  const manifestRow = env.CATALOG.prepare(
    `INSERT INTO send_manifests
       (id, org_id, mailbox_id, author_user_id, in_reply_to_message_id,
        envelope_from, envelope_to, envelope_cc, envelope_bcc, subject, rfc_message_id,
        references_header, fidelity,
        body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
        submitted_key, submitted_sha256,
        sealed_at, release_at, state, state_at, transport_message_id, last_error, attempts,
        policy_outcome, policy_versions, state_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,NULL,?,0,?,?,?)`,
  )
    .bind(
      manifestId, orgId, composition.mailboxId, composition.authorUserId,
      composition.inReplyToMessageId ?? null,
      address.address,
      JSON.stringify(to),
      cc.length === 0 ? null : JSON.stringify(cc),
      bcc.length === 0 ? null : JSON.stringify(bcc),
      composition.subject,
      rfcMessageId,
      referencesHeader,
      composition.fidelity,
      typedStored.blobKey, typedStored.plaintextSha256,
      normalizedStored.blobKey, normalizedStored.plaintextSha256,
      at, releaseAt, sealedState, at,
      // Prose for a person, beside the machine token in `state_reason`. The two are not redundant: the token
      // is what #62's vocabulary is built from, and this is the sentence that says which stage was short —
      // or, for a breaker, the four parts AGENTS.md requires: the named budget, its limit, the ask and the
      // way to change it. At most one of the two is ever set, because the state that produced each is
      // exclusive of the other.
      approvalShortfall !== null
        ? describeShortfall(approvalShortfall, composition.mailboxId)
        : breakerError,
      decision.outcome,
      JSON.stringify(decision.matched.map((match) => match.versionId)),
      stateReason,
    );

  // One row per recipient, in the same transaction as the manifest.
  //
  // Not derived later from the JSON arrays, and not written on first dispatch: a manifest whose recipients
  // are unknown until something else runs is a manifest whose per-recipient state cannot be shown, and the
  // window between the two is exactly where a bounce would arrive with nowhere to land.
  //
  // `submission_state` mirrors the manifest at hand-over — it is a fact about the envelope, so it is the
  // same for every row, and it starts at whatever the policy decision made the manifest rather than at a
  // literal `held`. A gated manifest whose recipients read `held` would show a person a message that is
  // simultaneously stopped and pending, which is the defect the cancel and withhold paths already fixed
  // downstream. `delivery_state` is left NULL, and that NULL is load bearing: it means *not yet observed*,
  // which is a different claim from any outcome.
  //
  // Duplicates are collapsed rather than rejected. The same address in To and Cc is one recipient in SMTP
  // terms, and two rows would count one bounce twice; `sr_unique` enforces it, and the first mention wins
  // so a To recipient is never demoted to Cc.
  const recipientRows = (() => {
    const seen = new Set<string>();
    const rows: D1PreparedStatement[] = [];
    for (const [kind, list] of [["to", to], ["cc", cc], ["bcc", bcc]] as const) {
      for (const address of list) {
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(env.CATALOG.prepare(
          `INSERT INTO send_recipients
             (id, org_id, manifest_id, kind, address, submission_state, submission_state_at,
              delivery_state, delivery_state_at, bounce_type, last_error, last_event_id, created_at)
           VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?)`,
        ).bind(ctx.id("srp"), orgId, manifestId, kind, address, sealedState, at, at));
      }
    }
    return rows;
  })();

  // The manifest row and the entry recording the seal commit together. §12's invariant is that the
  // approved bytes are what gets sent; a manifest with no record of who sealed it, or a record of a
  // seal with no manifest, both break the account of that.
  const sealEvent: AuditEvent = {
    action: "send.sealed",
    outcome: "ok",
    actorUserId: composition.authorUserId,
    subject: manifestId,
    // Recipients and subject are the *action*, not the content — but they are still the most
    // sensitive thing here, so only counts and the mailbox go in. §12 keeps the rest in R2.
    detail: {
      mailboxId: composition.mailboxId,
      recipients: composition.to.length + (composition.cc?.length ?? 0) + (composition.bcc?.length ?? 0),
      fidelity: composition.fidelity,
      inReplyTo: composition.inReplyToMessageId ?? null,
      // Which rule applied, in the entry for the act that applied it. §18 requires the audit trail to say
      // this, and it rides in `send.sealed`'s detail rather than as a second entry because sealing is **one**
      // act: a denial is not a separate event that happened afterwards, it is what this seal produced.
      // `send.withheld` stays the name of dispatch's own refusal, which is a genuinely later act.
      policyOutcome: decision.outcome,
      policyVersions: decision.matched.map((match) => `${match.policyName}@${match.version}:${match.versionId}`),
      state: sealedState,
      stateReason,
      // Which approval was asked for, or why none could be. Both belong in the entry for the act that produced
      // them: an approval nobody could be asked for is not a later event, it is what this seal decided.
      approvalId,
      ...(approvalShortfall === null ? {} : { approvalShortfall }),
      // What the breakers said, on the entry for the act they decided. Recorded whether or not one fired,
      // and that is the deliberate half: a breaker whose reading is only written down when it trips leaves
      // no evidence that it was *asked*, so a breaker silently unarmed for a month looks exactly like a
      // breaker that nothing tripped. `armed` and `observations` are what tell those two apart, which is the
      // same distinction `doctor` refuses to blur.
      breakers: breakers.rates.map((rate) => ({
        breaker: rate.breaker,
        armed: rate.armed,
        observations: rate.observations,
        observed: rate.observed,
        percent: rate.percent,
        tripped: rate.tripped,
      })),
      domainPaused: breakers.pause === null ? null : breakers.pause.pauseId,
    },
  };

  /*
   * The trip's own entry (#66). **The only record that a rate breaker fired**, because a rate breaker keeps
   * no state: the rows it counted will have aged out of the window before anybody reads the trail, so a trip
   * that is not recorded here never happened.
   *
   * It rides in the seal's `batch()` beside `send.sealed`, so a gated manifest with no entry naming the
   * breaker is not representable — the same property `approval.requested` gets from the same transaction.
   * Two entries about one act, for `approval.requested`'s reason: `send.sealed` records what happened to the
   * *send*, and this records that a **threshold** was crossed, which is a fact about the Node and is the
   * thing somebody filters the trail by when they ask "how often is this firing".
   */
  const breakerEvent: AuditEvent | null = breakerGate === null ? null : {
    action: "send.rate_limited",
    // `refused` would overclaim in the direction this whole design exists to avoid: nothing was refused. The
    // send is waiting, and `ok` is what the trail's other gates record.
    outcome: "ok",
    actorUserId: composition.authorUserId,
    subject: manifestId,
    detail: {
      breaker: breakerGate.breaker,
      reason: stateReason,
      limit: breakerGate.limit,
      observed: breakerGate.observed,
      observations: breakerGate.observations,
      percent: breakerGate.percent,
      windowSeconds: breakerGate.windowSeconds,
      retryAfterSeconds: breakerGate.retryAfterSeconds,
      // Whether the figure above is when it clears or the earliest it can. Recorded rather than left for a
      // reader to infer from the breaker's name, because the two claims are different and one of them is
      // weaker.
      retryAfterExact: breakerGate.retryAfterExact,
      mailboxId: composition.mailboxId,
      at: "seal",
    },
  };

  // Two entries, one transaction. `approval.requested` is a fact about the people being asked — its subject is
  // the approval id and its detail is the stage set — which `send.sealed` cannot carry without becoming an entry
  // about two different things. See `auditedBatchMany`.
  await auditedBatchMany(
    env, ctx, orgId,
    [sealEvent, ...(approvalEvent === null ? [] : [approvalEvent]),
      ...(breakerEvent === null ? [] : [breakerEvent])],
    (entries) => [manifestRow, ...recipientRows, ...approvalStatements, ...entries],
  );

  return {
    id: manifestId,
    state: sealedState,
    releaseAt,
    rfcMessageId,
    referencesHeader,
    policyOutcome: decision.outcome,
    policyVersionIds: decision.matched.map((match) => match.versionId),
    stateReason,
    approvalId,
    approvalShortfall,
    breaker: breakerGate,
    breakerError,
  };
}

/**
 * The RFC 5322 bytes for a manifest, for the `authored` path.
 *
 * `From` is the mailbox and nothing else (ADR 36): the author is in the manifest and the audit trail,
 * never in a header, because a staff name in `From` discloses employee identity and turnover to every
 * external correspondent, permanently and irreversibly.
 *
 * `Bcc` is deliberately **absent from the emitted headers** while present in the manifest. That is
 * what Bcc means — the other recipients must not learn it — and the envelope carries the recipient
 * list separately.
 */
export async function renderRfc822(
  env: Env,
  manifestId: string,
): Promise<{ raw: Bytes; sha256: string }> {
  const m = await env.CATALOG.prepare(
    `SELECT envelope_from, envelope_to, envelope_cc, subject, rfc_message_id, references_header,
            in_reply_to_message_id, body_normalized_key, sealed_at, org_id
       FROM send_manifests WHERE id = ? LIMIT 1`,
  )
    .bind(manifestId)
    .first<Record<string, string | null>>();

  if (m === null) {
    throw notFound("E_NO_MANIFEST", {
      what: `${manifestId} does not exist`,
      why: "rendering requires a sealed manifest; nothing is composed on the fly",
      fix: "seal a manifest first",
    });
  }

  const body = new TextDecoder().decode(await getEvidence(env, m.body_normalized_key!));

  let inReplyToHeader: string | null = null;
  if (m.in_reply_to_message_id != null) {
    // Org-scoped. `sealManifest` already refuses an out-of-org parent, and this is the second lock on
    // the same door: rendering reads from D1, so it must not trust that whatever wrote the row did
    // the check.
    const parent = await env.CATALOG.prepare(
      "SELECT rfc_message_id FROM messages WHERE org_id = ? AND id = ? LIMIT 1",
    )
      .bind(m.org_id, m.in_reply_to_message_id)
      .first<{ rfc_message_id: string }>();
    if (parent === null) {
      throw conflict("E_PARENT_NOT_IN_ORG", {
        what: `manifest ${manifestId} references a message outside its organization`,
        why: "rendering it would disclose another tenant's Message-ID to the recipient",
        fix: "this manifest cannot be sent; investigate how the reference was written",
      });
    }
    inReplyToHeader = `<${parent.rfc_message_id}>`;
  }

  // Built, not concatenated. Every field goes through `HeaderBlock.add`, so validation and RFC 2047
  // encoding cannot be skipped by a future field — there is no array to push a raw line onto, which is
  // the whole reason this is a builder rather than a set of checks.
  const raw = new HeaderBlock()
    .add("From", normalizeAddress("from", m.envelope_from!))
    .addAddresses("To", JSON.parse(m.envelope_to ?? "[]") as string[])
    .addAddresses("Cc", m.envelope_cc == null ? [] : (JSON.parse(m.envelope_cc) as string[]))
    .add("Subject", m.subject!)
    .add("Message-ID", `<${m.rfc_message_id!}>`)
    .add("Date", new Date(m.sealed_at!).toUTCString())
    .add("MIME-Version", "1.0")
    .add("Content-Type", 'text/plain; charset="utf-8"')
    .addIfPresent("In-Reply-To", inReplyToHeader)
    .addIfPresent("References", m.references_header)
    .bytes(body);

  return { raw, sha256: await sha256Hex(new TextDecoder().decode(raw)) };
}
