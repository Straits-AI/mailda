import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { putEvidence } from "../evidence-store.ts";
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
  let chain: string[] = [];
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
  const mailbox = await env.CATALOG.prepare(
    "SELECT id, hold_window_seconds FROM mailboxes WHERE org_id = ? AND id = ? LIMIT 1",
  )
    .bind(orgId, composition.mailboxId)
    .first<{ id: string; hold_window_seconds: number | null }>();

  if (mailbox === null) {
    throw new Error(
      `E_NO_SUCH_MAILBOX  ${composition.mailboxId} is not a mailbox in this organization\n` +
        "  why      From is the mailbox (ADR 36), so a manifest cannot be sealed without one\n" +
        "  fix      compose from a mailbox the author has access to",
    );
  }

  const address = await env.CATALOG.prepare(
    "SELECT address FROM addresses WHERE org_id = ? AND mailbox_id = ? ORDER BY created_at LIMIT 1",
  )
    .bind(orgId, composition.mailboxId)
    .first<{ address: string }>();

  if (address === null) {
    throw new Error(
      `E_MAILBOX_HAS_NO_ADDRESS  mailbox ${composition.mailboxId} has no address to send from\n` +
        "  why      ADR 36 makes From the mailbox, and a mailbox with no address cannot be one\n" +
        "  fix      add a routed address to this mailbox first",
    );
  }

  const manifestId = ctx.id("snd");
  const at = new Date(ctx.now()).toISOString();

  // The hold window (ADR 39). NULL means the default; 0 means dispatch immediately. Zero is a
  // legitimate configuration, not a missing value, which is why the column distinguishes them.
  const hold = mailbox.hold_window_seconds ?? HOLD_DEFAULT;
  const releaseAt = new Date(ctx.now() + hold * 1000).toISOString();

  // Threading. A reply's chain is rebuilt from the original's evidence, bounded.
  let referencesHeader: string | null = null;
  if (composition.inReplyToMessageId !== undefined) {
    const parent = await env.CATALOG.prepare(
      "SELECT rfc_message_id, blob_key FROM messages WHERE org_id = ? AND id = ? LIMIT 1",
    )
      .bind(orgId, composition.inReplyToMessageId)
      .first<{ rfc_message_id: string; blob_key: string }>();
    // The In-Reply-To header itself is derived in renderRfc822 from the stored parent id, so it is
    // not duplicated here — one place decides what reaches the wire.
    if (parent !== null) {
      referencesHeader = await rebuildReferences(env, parent.blob_key, parent.rfc_message_id);
    }
  }

  const normalized = normalizeBody(composition.bodyTyped);
  const encoder = new TextEncoder();

  // Both bodies to R2, before the row exists. Same ordering rule as ingress: the reachable partial
  // state is an orphan blob rather than a manifest pointing at nothing.
  const typedStored = await putEvidence(
    env, `${orgId}/sent/${manifestId}/typed.txt`, encoder.encode(composition.bodyTyped),
  );
  const normalizedStored = await putEvidence(
    env, `${orgId}/sent/${manifestId}/normalized.txt`, encoder.encode(normalized),
  );

  // The Message-ID this Node authors. Derived from the manifest id, so it is stable, unique, and
  // traceable back to its record without a lookup table.
  const senderDomain = address.address.split("@")[1] ?? "invalid";
  const rfcMessageId = `${manifestId}@${senderDomain}`;

  await env.CATALOG.prepare(
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
      JSON.stringify(composition.to),
      composition.cc === undefined ? null : JSON.stringify(composition.cc),
      composition.bcc === undefined ? null : JSON.stringify(composition.bcc),
      composition.subject,
      rfcMessageId,
      referencesHeader,
      composition.fidelity,
      typedStored.blobKey, typedStored.plaintextSha256,
      normalizedStored.blobKey, normalizedStored.plaintextSha256,
      at, releaseAt, at,
    )
    .run();

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
): Promise<{ raw: Uint8Array; sha256: string }> {
  const m = await env.CATALOG.prepare(
    `SELECT envelope_from, envelope_to, envelope_cc, subject, rfc_message_id, references_header,
            in_reply_to_message_id, body_normalized_key, sealed_at, org_id
       FROM send_manifests WHERE id = ? LIMIT 1`,
  )
    .bind(manifestId)
    .first<Record<string, string | null>>();

  if (m === null) {
    throw new Error(
      `E_NO_MANIFEST  ${manifestId} does not exist\n` +
        "  why      rendering requires a sealed manifest; nothing is composed on the fly\n" +
        "  fix      seal a manifest first",
    );
  }

  const body = new TextDecoder().decode(await getEvidence(env, m.body_normalized_key!));

  let inReplyToHeader: string | null = null;
  if (m.in_reply_to_message_id != null) {
    const parent = await env.CATALOG.prepare(
      "SELECT rfc_message_id FROM messages WHERE id = ? LIMIT 1",
    )
      .bind(m.in_reply_to_message_id)
      .first<{ rfc_message_id: string }>();
    if (parent !== null) inReplyToHeader = `<${parent.rfc_message_id}>`;
  }

  const headers: [string, string][] = [
    ["From", m.envelope_from!],
    ["To", (JSON.parse(m.envelope_to ?? "[]") as string[]).join(", ")],
  ];
  if (m.envelope_cc != null) headers.push(["Cc", (JSON.parse(m.envelope_cc) as string[]).join(", ")]);
  headers.push(
    ["Subject", m.subject!],
    ["Message-ID", `<${m.rfc_message_id}>`],
    ["Date", new Date(m.sealed_at!).toUTCString()],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="utf-8"'],
  );
  if (inReplyToHeader !== null) headers.push(["In-Reply-To", inReplyToHeader]);
  if (m.references_header != null) headers.push(["References", m.references_header]);

  const raw = new TextEncoder().encode(
    headers.map(([name, value]) => `${name}: ${value}`).join("\r\n") + "\r\n\r\n" + body,
  );
  return { raw, sha256: await sha256Hex(new TextDecoder().decode(raw)) };
}
