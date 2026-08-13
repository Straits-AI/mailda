import { type Bytes, utf8 } from "@mailda/evidence";
import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { auditedBatch } from "../audit.ts";
import { maySend, readableSubjects } from "../authz-read.ts";
import { conflict, notFound } from "../errors.ts";
import { putEvidence } from "../evidence-store.ts";
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
 */

const REFERENCES_MAX = BUDGETS["send.references_emitted_max"];
const HOLD_DEFAULT = BUDGETS["send.hold_window_default_seconds"];

/** ADR 33. Required of every caller, never inferred — the record's worth depends on it. */
export type Fidelity = "authored" | "reconstructed";

export interface Composition {
  mailboxId: string;
  authorUserId: string;
  /** Our own `msg_` id when this is a reply. The threading chain is read from its evidence. */
  inReplyToMessageId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Exactly what the author typed. Stored unchanged. */
  bodyTyped: string;
  fidelity: Fidelity;
}

export interface SealedManifest {
  id: string;
  state: "held";
  releaseAt: string;
  rfcMessageId: string;
  referencesHeader: string | null;
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

  const address = await env.CATALOG.prepare(
    "SELECT address FROM addresses WHERE org_id = ? AND mailbox_id = ? ORDER BY created_at LIMIT 1",
  )
    .bind(orgId, composition.mailboxId)
    .first<{ address: string }>();

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

  const manifestId = ctx.id("snd");
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

  const normalized = normalizeBody(composition.bodyTyped);

  // Both bodies to R2, before the row exists. Same ordering rule as ingress: the reachable partial
  // state is an orphan blob rather than a manifest pointing at nothing.
  const typedStored = await putEvidence(
    env, `${orgId}/sent/${manifestId}/typed.txt`, utf8(composition.bodyTyped),
  );
  const normalizedStored = await putEvidence(
    env, `${orgId}/sent/${manifestId}/normalized.txt`, utf8(normalized),
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
        sealed_at, release_at, state, state_at, transport_message_id, last_error, attempts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,'held',?,NULL,NULL,0)`,
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
      at, releaseAt, at,
    );

  // One row per recipient, in the same transaction as the manifest.
  //
  // Not derived later from the JSON arrays, and not written on first dispatch: a manifest whose recipients
  // are unknown until something else runs is a manifest whose per-recipient state cannot be shown, and the
  // window between the two is exactly where a bounce would arrive with nowhere to land.
  //
  // `submission_state` starts as `held` and mirrors the manifest at hand-over — it is a fact about the
  // envelope, so it is the same for every row. `delivery_state` is left NULL, and that NULL is load
  // bearing: it means *not yet observed*, which is a different claim from any outcome.
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
        ).bind(ctx.id("srp"), orgId, manifestId, kind, address, "held", at, at));
      }
    }
    return rows;
  })();

  // The manifest row and the entry recording the seal commit together. §12's invariant is that the
  // approved bytes are what gets sent; a manifest with no record of who sealed it, or a record of a
  // seal with no manifest, both break the account of that.
  await auditedBatch(env, ctx, orgId, {
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
    },
  }, (entry) => [manifestRow, ...recipientRows, entry]);

  return {
    id: manifestId,
    state: "held",
    releaseAt,
    rfcMessageId,
    referencesHeader,
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
