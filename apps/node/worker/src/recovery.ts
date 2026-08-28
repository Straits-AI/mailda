import { ID_PREFIXES, ULID_ALPHABET, type Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { unprocessable } from "./errors.ts";
import { aesKeyFrom, vault, type KeyPurpose } from "./keyvault.ts";

/**
 * ADR 29's recovery codes, carrying ADR 28's key escrow (#92).
 *
 * ## The gate this closes
 *
 * `keyvault.ts` states it plainly: the Durable Object's storage is the crown jewels, losing it makes every
 * message permanently unreadable, and **"ADR 28 therefore does not ship without the key escrow in ADR 29"**.
 * That is a release condition the code set for itself and nothing satisfied. Worse than a gap: three
 * refusals — `E_VAULT_NO_KEY`, `E_VAULT_UNKNOWN_GENERATION` and doctor's `credential_key` finding — already
 * told an operator to *"restore the vault from the ADR 29 recovery codes"*, and there were none. An error
 * message naming an impossible remedy is worse than one naming no remedy, because somebody goes looking.
 *
 * ## What is escrowed, and what is not
 *
 * The vault's **secrets**, per generation and purpose. Not D1, not R2, not the manifests. That division is
 * the point rather than a first cut: D1 and R2 live in the customer's own account and are recoverable by
 * ordinary means, and both have thirty days of point-in-time recovery. The Durable Object's storage is the
 * one thing whose loss is *irreversible*, because it holds the only copy of the keys everything else is
 * sealed under. Escrowing the keys is what turns "every message is permanently unreadable" into "restore
 * the vault and read them".
 *
 * A clean-account restore needs the D1 and R2 halves too, and #92 asks for that as well — it is a later
 * layer, and it is genuinely later rather than deferred: exporting evidence nobody can decrypt would be a
 * backup that proves nothing.
 *
 * ## Two uses of one secret, kept apart
 *
 * | | derived from | stored here | answers |
 * |:--|:--|:--|:--|
 * | authentication | `sha256(code)` | **yes**, `code_hash` | is this one of the ten? |
 * | encryption | the code's plaintext | **no** | may this open the vault? |
 *
 * Sealing the escrow under the stored hash would put the ciphertext and its key in the same table, and a D1
 * dump would carry both. So this Node can *verify* a code it cannot *use* — which is the property that makes
 * the escrow worth having, and the reason `codeKey` derives from `code` while `codeHash` derives the thing
 * that gets written down.
 *
 * ## Why the codes are not an authentication path yet
 *
 * ADR 29 gives the same ten codes two jobs: recovering an account and restoring the vault. This builds the
 * second. Signing in with a recovery code is the first and is deliberately absent here, because it needs
 * step-up, rate limiting and an audited session-issuance path — and shipping the vault half first means the
 * gate ADR 28 named is closed without waiting on any of that. Named rather than implied: `redeemForVault`
 * spends a code and issues **no session**.
 */

/** ADR 29: ten. Not a tripwire and not measured — the number *is* the decision, recorded in the blueprint. */
const CODE_COUNT = 10;

/**
 * ADR 29: 128-bit codes. Sixteen bytes, rendered as 26 Crockford-ish base32 characters — and `formatCode`
 * below carries the account of how that rendering lost 48 of them for a while.
 *
 * Not a receipt value for the same reason `CODE_COUNT` is not: it is quoted from the decision rather than
 * measured from anything. The blueprint says *"ten single-use 128-bit codes, plain SHA-256"*, and the
 * argument for no expensive KDF is in the same sentence — the codes are not human-chosen, so there is no
 * offline-guessing surface to price.
 */
const CODE_BYTES = 16;

/*
 * Crockford base32, from the registry rather than spelled again here.
 *
 * The first version wrote the alphabet out — and `id-prefix-world.test.ts` refused it by name, which is the
 * check earning its place a second time. The reason it matters for a *recovery code* is the same as for an
 * id and slightly worse: the alphabet's whole job is that a code read aloud or copied off paper during an
 * incident is unambiguous, and a second copy is a second thing to keep correct. `ULID_ALPHABET` already
 * excludes I, L, O and U for exactly that reason.
 */

export interface MintedCodes {
  /** The ten codes, in plaintext, **once**. Nothing stores these and nothing can produce them again. */
  readonly codes: readonly string[];
  /**
   * Which set these are, so a caller can say *"confirm this sheet"* rather than *"confirm whatever is
   * current"* — the distinction that was missing and that both P1-2 defects came out of.
   */
  readonly setId: string;
  readonly escrowedGenerations: { readonly content: number; readonly credential: number };
}

/** What the vault holds, as the escrow carries it. Generations included, or a restore cannot name them. */
interface EscrowedVault {
  readonly content: readonly { readonly generation: number; readonly secret: string }[];
  readonly credential: readonly { readonly generation: number; readonly secret: string }[];
}

/**
 * How many characters 128 bits needs in base32, and the invariant the encoder below is checked against.
 *
 * `ceil(128 / 5) = 26`. Twenty-five characters carry 125 bits, so the twenty-sixth carries the remaining
 * **three data bits plus two of padding** — 26 x 5 = 130 bits of capacity for 128 of secret. Stated
 * precisely because an earlier version of this comment said "three bits of padding", which is the same
 * kind of arithmetic slip as the bug it describes.
 */
export const CODE_CHARACTERS = 26;

/**
 * A code, formatted so a person can write it on paper and type it back.
 *
 * Grouped in fours with hyphens. The hyphens are cosmetic and stripped before hashing, so a code typed
 * without them still works — a recovery path that rejects a correctly-remembered secret over punctuation is
 * a recovery path that fails when it is needed.
 *
 * ## This discarded 48 of its 128 bits, and the comment above it said otherwise
 *
 * The first implementation was one line: `for (const byte of bytes) out += ULID_ALPHABET[byte % 32]`. One
 * base32 character per source byte — so sixteen random bytes became **sixteen characters**, and a base32
 * character carries five bits. 16 × 5 = **80 bits**, not 128, while the constant above it was named
 * `CODE_BYTES = 16` and the comment beside it claimed "26 Crockford-ish base32 characters".
 *
 * There was no modulo bias — 256 divides evenly by 32 — so nothing about the output looked wrong. The
 * entropy was simply thrown away, and every test used codes of the length the bug produced.
 *
 * These codes open the escrow holding the keys to **all of an organization's mail**. 80 bits is not
 * trivially guessable and it is not what ADR 29 promises, and the gap between a stated security contract and
 * the shipped one is the thing this repository exists to keep at zero.
 *
 * **Exported for the test**, for the reason `messagePageQuery` is: minted codes use random bytes, so the
 * only way to assert that a given input bit reaches the output is to feed known bytes to the *shipped*
 * encoder. A test with its own copy of this loop would assert that its copy is correct.
 *
 * The encoder now packs bits properly: an accumulator takes bytes eight bits at a time and emits a character
 * whenever five are available, with the remaining three padded at the end. `value` never exceeds thirteen
 * bits because it is drained on every iteration, so the shifts stay well inside a 32-bit integer.
 */
export function formatCode(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ULID_ALPHABET[(value >>> bits) & 31];
    }
  }
  // The tail. 128 is not a multiple of 5, so three bits are left; padding them is what makes the last
  // character carry them rather than lose them.
  if (bits > 0) out += ULID_ALPHABET[(value << (5 - bits)) & 31];
  return (out.match(/.{1,4}/g) ?? []).join("-");
}

/** Hyphens and case are cosmetic. Everything downstream uses this form. */
export function normaliseCode(code: string): string {
  return code.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Proves membership. Written down; cannot open anything. */
export async function codeHash(code: string): Promise<string> {
  return await sha256Hex(normaliseCode(code));
}

/**
 * The key that opens an escrow blob.
 *
 * Derived from the code itself and **domain-separated** from `codeHash` by the prefix, so the value written
 * into `code_hash` is not the input to this. Without the separation, `sha256(code)` would be both the stored
 * verifier and the key material, and the table would carry the means to open its own contents.
 */
async function codeKey(code: string): Promise<CryptoKey> {
  return await aesKeyFrom(`mailda/vault-escrow/v1/${normaliseCode(code)}`);
}

async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext),
  );
  const joined = new Uint8Array(iv.length + sealed.byteLength);
  joined.set(iv, 0);
  joined.set(new Uint8Array(sealed), iv.length);
  return btoa(String.fromCharCode(...joined));
}

async function open(key: CryptoKey, blob: string): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(blob), (character) => character.charCodeAt(0));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    /*
     * A wrong code, or a blob from a different Node. Returning null rather than throwing because this is an
     * expected answer at this layer — the caller turns it into `E_RECOVERY_CODE_UNKNOWN`, which is the same
     * refusal an unrecognised code gets, so a code that exists but does not decrypt is not an oracle.
     * Nothing is swallowed: the caller refuses.
     */
    return null;
  }
}

/**
 * Reads every generation the vault holds, so the escrow can carry all of them.
 *
 * **Every generation, not only the current one.** Objects sealed under an earlier generation are opened with
 * that generation's key (`openingKey`), so an escrow holding only the newest would restore a vault that
 * could read new mail and not old — the exact half-recovery that reads as success. `inventory()` gives the
 * current numbers and the walk goes down from there; generation 0 is skipped because it is the published
 * development constant and `openingKey` returns it without help.
 */
async function readVault(env: Env): Promise<EscrowedVault> {
  const inventory = await vault(env).inventory();
  const collect = async (purpose: KeyPurpose, current: number) => {
    const found: { generation: number; secret: string }[] = [];
    for (let generation = 1; generation <= current; generation++) {
      // `openingKey` throws for a generation this vault never held, which is possible in principle if a
      // restore brought a pointer without its keys. Skipped rather than fatal: escrowing what exists is
      // strictly better than escrowing nothing, and `doctor` reports the gap separately.
      const key = await vault(env).openingKey(purpose, generation).catch(() => null);
      if (key !== null) found.push({ generation, secret: key.secret });
    }
    return found;
  };
  return {
    content: await collect("content", inventory.content),
    credential: await collect("credential", inventory.credential),
  };
}

/**
 * Mints ten codes and escrows the vault under each.
 *
 * Called at claim, and callable again to re-escrow after a rotation — which **invalidates the previous set**,
 * because ten codes that open a vault two generations behind are ten codes that restore a Node unable to
 * read its recent mail. A silent stale escrow is the failure this whole file exists to prevent, so replacing
 * the set is the honest behaviour and the old rows are deleted rather than left to be chosen from.
 *
 * The plaintext codes are returned **once**. Nothing stores them, so nothing can reproduce them: the same
 * sentence `claim-secret` already prints, and the reason a lost set is re-minted rather than recovered.
 */
export async function mintRecoveryCodes(
  env: Env,
  ctx: Ctx,
  orgId: string,
  /**
   * Who asked, when anybody did. Omitted by `claim.ts`, which has no session to attribute to and mints the
   * first set as part of installing the Node.
   */
  actor?: { actorUserId: string; delegatorUserId?: string | null },
): Promise<MintedCodes> {
  const escrowed = await readVault(env);
  const payload = JSON.stringify(escrowed);
  const at = new Date(ctx.now()).toISOString();

  const codes: string[] = [];
  const rows: { id: string; hash: string; blob: string }[] = [];
  for (let n = 0; n < CODE_COUNT; n++) {
    const code = formatCode(crypto.getRandomValues(new Uint8Array(CODE_BYTES)));
    codes.push(code);
    rows.push({
      id: ctx.id(ID_PREFIXES.recoveryCode),
      hash: await codeHash(code),
      blob: await seal(await codeKey(code), payload),
    });
  }

  const current = {
    content: escrowed.content.at(-1)?.generation ?? 0,
    credential: escrowed.credential.at(-1)?.generation ?? 0,
  };

  /*
   * One batch, so a Node is never left holding a partial set. D1's `batch` is one transaction, and the
   * delete travels with the inserts — a failure between them would otherwise destroy a working escrow to
   * make room for one that never arrived.
   *
   * ## The delete is `confirmed_at IS NULL`, and that is the whole of audit P1-2
   *
   * It used to be every row for the organization, which made the batch's atomicity beside the point. A
   * partial write was impossible; a **lost response** was not, and it is the ordinary failure: the operator
   * who never sees the new sheet is left holding an old one that no longer works and a new one they have
   * never read. The escrow stays perfectly intact and becomes unreachable by anybody.
   *
   * So a confirmed set survives a rotation and is retired by `confirmRecoveryCodes` once its replacement is
   * proven held. What this delete still removes is an **unconfirmed** set: nobody proved they hold it, so
   * nothing is lost by replacing it, and it bounds the table at one pending set plus one active one rather
   * than accumulating a sheet per press of the button.
   *
   * `set_id` is what makes any of it expressible. Before it, "the current set" meant "every row for this
   * org", and there was no way to write either statement correctly.
   */
  const setId = ctx.id(ID_PREFIXES.recoveryPad);
  await auditedBatch(
    env, ctx, orgId,
    {
      action: "recovery.codes_minted",
      outcome: "ok",
      /*
       * The person, when there is one. `/api/recovery-codes/rotate` is an authenticated administrator's act
       * and recording it as the Node made the trail say a machine rotated the one artifact that can decrypt
       * an organization's mail — the least attributable act in the product, recorded least. `claim.ts` has no
       * session and passes nothing, which is the case the old comment described and the only one it fitted.
       */
      ...(actor ?? { actorKind: "node" as const }),
      detail: {
        codes: rows.length, set: setId, content: current.content, credential: current.credential,
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "DELETE FROM recovery_codes WHERE org_id = ? AND confirmed_at IS NULL",
      ).bind(orgId),
      ...rows.map((row) => env.CATALOG.prepare(
        `INSERT INTO recovery_codes
           (id, org_id, code_hash, escrow, content_generation, credential_generation, created_at,
            code_characters, set_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      // `CODE_CHARACTERS` rather than a literal, and rather than measuring `row.code`: the column records
      // what the encoder promises, so a future encoder that silently shortened its output would disagree
      // with the constant and fail `recovery-escrow.test.ts` rather than write a comfortable number here.
      ).bind(row.id, orgId, row.hash, row.blob, current.content, current.credential, at, CODE_CHARACTERS,
        setId)),
    ],
  );

  return { codes, setId, escrowedGenerations: current };
}

/**
 * Spends a code and puts the vault back.
 *
 * The order is the load-bearing part and it is the opposite of the obvious one: **the escrow is opened
 * before the code is spent.** Marking it redeemed first would burn one of ten on a typo, and a recovery path
 * that consumes the secret it failed to use is one that runs out during the incident it exists for.
 *
 * The spend is a conditional UPDATE on `redeemed_at IS NULL` and the `changes` count is checked, which is
 * this repository's compare-and-swap: two concurrent redemptions of one code cannot both succeed, and the
 * conflict is the signal rather than something to lock against.
 *
 * Issues **no session**. A recovery code restoring the vault and a recovery code signing somebody in are two
 * acts, and this is the first — see the header.
 */
export async function redeemForVault(
  env: Env, ctx: Ctx, orgId: string, code: string,
): Promise<{
  restored: { content: number[]; credential: number[] };
  /**
   * Generations the vault already held under a **different** secret, so the escrowed key was not installed.
   *
   * Not an error and not a success. Reachable by one route and it is worth stating: a Node whose storage was
   * lost and which then kept working mints a fresh generation 1, and an escrow from before the loss carries
   * generation 1 too. Both keys are real and both are needed — the newer one opens mail sealed since the
   * loss, the escrowed one opens mail sealed before it — and one number cannot hold both.
   *
   * The live key is kept, because losing newer mail to recover older is the worse trade. **Mail sealed under
   * the escrowed key stays unreadable**, and this field is how the operator finds that out at the moment it
   * happens rather than the next time somebody opens an old message.
   */
  conflicted: { content: number[]; credential: number[] };
}> {
  const hash = await codeHash(code);
  const row = await env.CATALOG.prepare(
    "SELECT id, escrow, redeemed_at FROM recovery_codes WHERE org_id = ? AND code_hash = ? LIMIT 1",
  ).bind(orgId, hash).first<{ id: string; escrow: string; redeemed_at: string | null }>();

  /*
   * §5C: an unknown code and a spent one answer differently, and that is deliberate rather than an
   * oversight. "Already used" is not an oracle — the caller already held the code — and an operator who
   * reads "unknown" for a code they know they wrote down will go looking for the wrong problem during an
   * incident. What must not differ is unknown versus *undecryptable*, which is why the failure below
   * reuses this same code.
   */
  /*
   * Opened **once**, here, and the plaintext is carried down rather than decrypted twice. The first version
   * opened it in this condition and again after the spend with a `!` — two decryptions of the same blob, and
   * a non-null assertion standing in for the fact that the first one had already proved it.
   */
  const plain = row === null ? null : await open(await codeKey(code), row.escrow);
  if (row === null || plain === null) {
    throw unprocessable("E_RECOVERY_CODE_UNKNOWN", {
      what: "that is not a recovery code for this Node",
      why: "codes are checked against a stored hash and the escrow is sealed under the code itself, so a "
        + "code from another Node verifies as neither. Hyphens and case are ignored, so the difference is "
        + "not punctuation",
      fix: "check the code against the set printed at claim. If that set is lost, the vault cannot be "
        + "restored from here — the keys exist only in this Node's Durable Object storage and in an escrow "
        + "nothing but a code can open",
    });
  }
  /*
   * **This check is the message, not the guarantee**, and `scripts/mutants.mjs` is what established that:
   * removing it entirely leaves every test passing, because the compare-and-swap below refuses the same code
   * for the same reason. What is lost without it is the *date* — "already used, on 2026-08-26" instead of
   * "used by another request while this one was running", which is a worse sentence for somebody holding a
   * list of ten codes and trying to work out which they have spent.
   *
   * Kept deliberately, and labelled, because a surviving mutant here is a reader's question and this is the
   * answer: the guard is redundant on purpose, and the redundancy buys a better refusal.
   */
  if (row.redeemed_at !== null) {
    throw unprocessable("E_RECOVERY_CODE_SPENT", {
      what: `that recovery code was already used, on ${row.redeemed_at}`,
      why: "ADR 29's codes are single-use, so that one is spent whether or not the restore it was used for "
        + "succeeded",
      fix: "use one of the other codes from the set printed at claim, then mint a fresh set — a set with "
        + "codes missing is a set nobody knows the size of",
    });
  }

  /*
   * The entry rides in the **same transaction as the spend**, so a code marked redeemed always has a record
   * of being redeemed. Standalone would admit the reverse: a spent code with no entry, on the one route that
   * takes no session — which is exactly where the trail has to be reliable, because it is the only thing
   * that makes an unauthenticated key-installing route accountable at all.
   *
   * The detail names what the escrow **carried**, not what ended up installed: the restore happens after
   * this commits, and a generation can collide with a live key and be skipped. Recording the escrowed set as
   * restored would be the false-success claim this file's own tests exist to catch.
   */
  const escrowed = JSON.parse(plain) as EscrowedVault;
  const { results } = await auditedBatch(
    env, ctx, orgId,
    {
      action: "recovery.vault_restored",
      outcome: "ok",
      actorKind: "node",
      // The row id, never the code and never its hash — enough to answer "which of the ten, and when".
      subject: row.id,
      detail: {
        escrowedContent: escrowed.content.map((key) => key.generation),
        escrowedCredential: escrowed.credential.map((key) => key.generation),
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "UPDATE recovery_codes SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL",
      ).bind(new Date(ctx.now()).toISOString(), row.id),
    ],
  );
  const spent = results[1]!;
  if ((spent.meta.changes ?? 0) === 0) {
    // Lost the race against a concurrent redemption of the same code. The other one restored the vault.
    throw unprocessable("E_RECOVERY_CODE_SPENT", {
      what: "that recovery code was used by another request while this one was running",
      why: "codes are single-use and the spend is a compare-and-swap, so exactly one of two concurrent "
        + "redemptions wins",
      fix: "the vault was restored by the request that won — check `doctor` before using a second code",
    });
  }

  const restored = { content: [] as number[], credential: [] as number[] };
  const conflicted = { content: [] as number[], credential: [] as number[] };
  for (const purpose of ["content", "credential"] as const) {
    for (const key of escrowed[purpose]) {
      /*
       * The outcome is **read**, and the first version threw it away — it pushed every generation into
       * `restored` whatever happened, so a redemption that installed nothing reported the full list as
       * restored. Found by probing the wipe-then-regenerate case rather than by reading: the report said
       * generation 1 was restored while the vault kept a different key of the same number.
       *
       * `identical` is not reported as restored either. A generation the vault already had, byte for byte,
       * was not put back by this redemption, and counting it would inflate what a code achieved.
       */
      const outcome = await vault(env).restore(purpose, key.generation, key.secret);
      if (outcome === "restored") restored[purpose].push(key.generation);
      else if (outcome === "conflict") conflicted[purpose].push(key.generation);
    }
  }
  return { restored, conflicted };
}

/**
 * What `doctor` reports. Counts and generations only — never a hash, and certainly never a code.
 *
 * ## Two sets can be present, and the counts have to say which is which
 *
 * Since audit P1-2 a confirmed set survives a rotation until its replacement is confirmed, so an organization
 * can hold one **active** sheet and one **pending** one at the same time. The old shape reported `unconfirmed`
 * and `doctor` went degraded on `unconfirmed > 0` — which after that change would fire on a Node the operator
 * can recover perfectly, because they hold the active sheet and simply have not confirmed the new one yet. A
 * monitoring check that cries wolf on the healthy case is the one people learn to ignore.
 *
 * So the question is answered directly: `confirmed` is the number of unspent codes **somebody has proved they
 * hold**. Zero of those is the unhealthy state, whatever the row count says.
 */
export async function escrowState(env: Env, orgId: string): Promise<{
  total: number; unredeemed: number; content: number; credential: number; weak: number;
  unconfirmed: number; confirmed: number;
} | null> {
  const row = await env.CATALOG.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN redeemed_at IS NULL THEN 1 ELSE 0 END) AS unredeemed,
            /*
             * Generations twice: across every present set, and across the confirmed one alone. The staleness
             * finding is about the restore an operator can actually perform, so it has to be judged on the
             * sheet they have proved they hold -- a pending set carrying the current generation says nothing
             * about whether anybody can use it.
             */
            MAX(content_generation) AS content,
            MAX(credential_generation) AS credential,
            MAX(CASE WHEN confirmed_at IS NOT NULL THEN content_generation END) AS held_content,
            MAX(CASE WHEN confirmed_at IS NOT NULL THEN credential_generation END) AS held_credential,
            /*
             * Codes still spendable that were minted before the encoder carried its full 128 bits. NULL is
             * the legacy marker -- migration 0042 added the column without a default precisely so that
             * existing rows say "unknown" rather than being relabelled as strong. The inequality covers a
             * future encoder that shortens rather than lengthens.
             *
             * Counted across **both** sets on purpose: redeemForVault accepts a code from any present set,
             * so a weak code in the pending sheet is a live weakness even when the active one is strong.
             */
            SUM(CASE WHEN redeemed_at IS NULL
                      AND (code_characters IS NULL OR code_characters < ?)
                     THEN 1 ELSE 0 END) AS weak,
            -- Codes nobody has proved they hold. Migration 0043 records why an unconfirmed set is not
            -- healthy: from this Node's side a lost mint response is indistinguishable from a stored one.
            SUM(CASE WHEN redeemed_at IS NULL AND confirmed_at IS NULL THEN 1 ELSE 0 END) AS unconfirmed,
            -- And the answer to the question that actually decides health: is any of it proven held?
            SUM(CASE WHEN redeemed_at IS NULL AND confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed
       FROM recovery_codes WHERE org_id = ?`,
  ).bind(CODE_CHARACTERS, orgId)
    .first<{
      total: number; unredeemed: number; content: number; credential: number; weak: number;
      unconfirmed: number; confirmed: number;
      held_content: number | null; held_credential: number | null;
    }>();
  if (row === null || Number(row.total) === 0) return null;
  return {
    total: Number(row.total),
    unredeemed: Number(row.unredeemed ?? 0),
    // The held set's generations when there is one, so staleness is judged on the restore that is available.
    content: Number(row.held_content ?? row.content ?? 0),
    credential: Number(row.held_credential ?? row.credential ?? 0),
    weak: Number(row.weak ?? 0),
    unconfirmed: Number(row.unconfirmed ?? 0),
    confirmed: Number(row.confirmed ?? 0),
  };
}

/**
 * Proves an operator holds one of the codes just minted, without spending it.
 *
 * ## Why confirmation is a separate act from minting
 *
 * `mintRecoveryCodes` returns ten codes **once** and cannot produce them again. If that response is lost the
 * operator holds nothing — and the Node cannot tell, because the rows, the hashes and the escrow are all
 * exactly as they would be if the codes had been written down. `doctor` would report health over an
 * organization that cannot recover.
 *
 * So a set is unhealthy until somebody types one code back. That is the cheapest available proof: it verifies
 * against the stored hash, it requires having read the plaintext, and it costs the operator nothing they were
 * not going to do anyway.
 *
 * ## Verifying is not redeeming, and the difference is deliberate
 *
 * `redeemForVault` spends a code and restores the vault; this only compares a hash. A confirmation that
 * consumed a code would leave nine, and the operator would reasonably wonder what happened to the tenth —
 * and an operator who confirms twice would be down to eight. Nothing is spent here.
 *
 * Confirmation is **per set, not per code**. One code proven is proof the sheet was received; asking for all
 * ten would be asking somebody to type 260 characters to satisfy a checkbox.
 */
export async function confirmRecoveryCodes(
  env: Env,
  ctx: Ctx,
  orgId: string,
  code: string,
  /** Who typed it. Omitted only by callers with no session; the route always has one. */
  actor?: { actorUserId: string; delegatorUserId?: string | null },
): Promise<{ confirmed: number; alreadyConfirmed: boolean }> {
  const hash = await codeHash(normaliseCode(code));
  const row = await env.CATALOG.prepare(
    `SELECT id, set_id, confirmed_at FROM recovery_codes
      WHERE org_id = ? AND code_hash = ? AND redeemed_at IS NULL LIMIT 1`,
  ).bind(orgId, hash).first<{ id: string; set_id: string | null; confirmed_at: string | null }>();

  if (row === null) {
    /*
     * Deliberately the same refusal whether the code is wrong, already spent, or belongs to a set that has
     * been replaced. A confirmation route that distinguished them would answer *"that code exists"* to
     * somebody guessing, which is the one thing this route must not become — it is authenticated, but an
     * oracle behind authentication is still an oracle.
     */
    throw unprocessable("E_RECOVERY_CODE_UNKNOWN", {
      what: "that code does not match an unspent code in this Node's current set",
      why: "confirmation compares against the current set only. A code from a set that has since been "
        + "replaced will not match, and neither will one that has already been redeemed.",
      fix: "type a code from the most recently printed set. If none of them match, mint a fresh set — the "
        + "previous printout is no longer this Node's",
    });
  }

  /*
   * Already held. Nothing to mark and — the load-bearing half — **nothing to retire**.
   *
   * An operator typing a code from the set that is already active is saying *"I still have this sheet"*, which
   * is true and changes nothing. Falling through would run the retirement below and destroy a pending
   * replacement on the strength of a confirmation of something else. Reported rather than refused, because
   * the code was genuine and a refusal would send somebody looking for a problem that is not there.
   */
  if (row.confirmed_at !== null) return { confirmed: 0, alreadyConfirmed: true };

  const at = new Date(ctx.now()).toISOString();
  /*
   * One batch: the set is confirmed and every other set is retired together, or neither happens.
   *
   * **`set_id IS ?` and `IS NOT ?`, not `=` and `<>`.** SQLite's `IS` is the null-safe comparison, and
   * `set_id` is nullable because migration 0047 leaves pre-migration rows as the legacy set. `= NULL` is
   * `NULL`, which is not true, so an `=` here would confirm nothing for a legacy set and — far worse — the
   * `<>` form would retire nothing, leaving both sheets live and the vault openable by a sheet the operator
   * has just replaced.
   *
   * **Retirement is a delete rather than a state**, and that is the point of it. Each row carries the vault
   * *sealed under its own code*, so a retired row left in the table is the vault still openable by the old
   * sheet — exactly what somebody rotating their codes is trying to stop being true. A `retired_at` column
   * would have recorded the intent and kept the capability.
   *
   * The UPDATE is conditional on `confirmed_at IS NULL`, which is this repository's compare-and-swap: two
   * operators confirming the same sheet at once cannot both retire the other set, because the second one's
   * update changes nothing and the count says so.
   */
  const retiring = await env.CATALOG.prepare(
    "SELECT COUNT(DISTINCT IFNULL(set_id, '')) AS sets FROM recovery_codes WHERE org_id = ? AND set_id IS NOT ?",
  ).bind(orgId, row.set_id).first<{ sets: number }>();

  /*
   * Through `auditedBatch`, and the trail is the reason rather than the batch.
   *
   * Confirming used to write nothing. It changes whether this Node is recoverable, and — since retirement is
   * a delete — it **destroys copies of the key vault**, one per code on the retired sheet. An act that
   * removes the ability to decrypt an organization's mail leaving no entry is what §7 forbids, and it went
   * unnoticed because the act reads like a checkbox.
   *
   * The gate makes the entry conditional on the set still being pending, so a confirmation that loses a race
   * to another one records nothing rather than claiming a retirement it did not perform. The entry precedes
   * the statements that change the predicate, which `AuditGate` requires.
   *
   * **No test in this repository reaches that gate, and this says so rather than implying otherwise.** The
   * early return above means a sequential caller whose set is already confirmed never gets here, and the
   * `UPDATE`'s predicate is the same one the `SELECT` just satisfied — so in a single-threaded world the
   * update always changes rows and the gate always fires. It exists for the interleaving: pending at read
   * time, confirmed or retired by write time. What *is* tested is the mechanism —
   * `test/audit.test.ts` asserts the chain stays contiguous when a gated entry does not fire — and the
   * predicate is the same one the `UPDATE` carries three lines below, so the two cannot disagree about what
   * "still pending" means.
   */
  const { results } = await auditedBatch<unknown>(
    env, ctx, orgId,
    {
      action: "recovery.codes_confirmed",
      outcome: "ok",
      actorKind: actor === undefined ? "node" : undefined,
      ...(actor ?? {}),
      subject: row.id,
      detail: { set: row.set_id, retired: Number(retiring?.sets ?? 0) },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE recovery_codes SET confirmed_at = ?
          WHERE org_id = ? AND set_id IS ? AND confirmed_at IS NULL`,
      ).bind(at, orgId, row.set_id),
      env.CATALOG.prepare(
        "DELETE FROM recovery_codes WHERE org_id = ? AND set_id IS NOT ?",
      ).bind(orgId, row.set_id),
    ],
    {
      sql: "SELECT 1 FROM recovery_codes WHERE org_id = ? AND set_id IS ? AND confirmed_at IS NULL",
      params: [orgId, row.set_id],
    },
  );

  return { confirmed: results[1]?.meta.changes ?? 0, alreadyConfirmed: false };
}
