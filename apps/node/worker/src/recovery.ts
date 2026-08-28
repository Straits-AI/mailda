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
 * `ceil(128 / 5) = 26`. The last character carries three bits of padding, which is ordinary for base32 and
 * costs nothing — what matters is that 26 is **not** 16.
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
export async function mintRecoveryCodes(env: Env, ctx: Ctx, orgId: string): Promise<MintedCodes> {
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
   */
  await auditedBatch(
    env, ctx, orgId,
    {
      action: "recovery.codes_minted",
      outcome: "ok",
      // No person. The claim path has no session yet and re-minting is an operator act with a code, not a
      // login — recorded as the Node rather than attributed to somebody who cannot be identified.
      actorKind: "node",
      detail: { codes: rows.length, content: current.content, credential: current.credential },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare("DELETE FROM recovery_codes WHERE org_id = ?").bind(orgId),
      ...rows.map((row) => env.CATALOG.prepare(
        `INSERT INTO recovery_codes
           (id, org_id, code_hash, escrow, content_generation, credential_generation, created_at,
            code_characters)
         VALUES (?,?,?,?,?,?,?,?)`,
      // `CODE_CHARACTERS` rather than a literal, and rather than measuring `row.code`: the column records
      // what the encoder promises, so a future encoder that silently shortened its output would disagree
      // with the constant and fail `recovery-escrow.test.ts` rather than write a comfortable number here.
      ).bind(row.id, orgId, row.hash, row.blob, current.content, current.credential, at, CODE_CHARACTERS)),
    ],
  );

  return { codes, escrowedGenerations: current };
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

/** What `doctor` reports. Counts and generations only — never a hash, and certainly never a code. */
export async function escrowState(env: Env, orgId: string): Promise<{
  total: number; unredeemed: number; content: number; credential: number; weak: number;
} | null> {
  const row = await env.CATALOG.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN redeemed_at IS NULL THEN 1 ELSE 0 END) AS unredeemed,
            MAX(content_generation) AS content, MAX(credential_generation) AS credential,
            /*
             * Codes still spendable that were minted before the encoder carried its full 128 bits. NULL is
             * the legacy marker -- migration 0042 added the column without a default precisely so that
             * existing rows say "unknown" rather than being relabelled as strong. The inequality covers a
             * future encoder that shortens rather than lengthens.
             */
            SUM(CASE WHEN redeemed_at IS NULL
                      AND (code_characters IS NULL OR code_characters < ?)
                     THEN 1 ELSE 0 END) AS weak
       FROM recovery_codes WHERE org_id = ?`,
  ).bind(CODE_CHARACTERS, orgId)
    .first<{ total: number; unredeemed: number; content: number; credential: number; weak: number }>();
  if (row === null || Number(row.total) === 0) return null;
  return {
    total: Number(row.total),
    unredeemed: Number(row.unredeemed ?? 0),
    content: Number(row.content ?? 0),
    credential: Number(row.credential ?? 0),
    weak: Number(row.weak ?? 0),
  };
}
