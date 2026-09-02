import { ID_PREFIXES, ULID_ALPHABET, type Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { unprocessable } from "./errors.ts";
import { aesKeyFrom, vault, type KeyPurpose } from "./keyvault.ts";
import { conflictKey, restoreDetail } from "./restore-detail.ts";

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
 * How long one restore attempt reserves its code.
 *
 * Five minutes, against an operation that takes seconds. As with the body-index lease, the number is not a
 * guess about duration — it is how long a **dead** attempt holds a code before anybody may try again, and a
 * reservation nothing can release is a deadlock wearing a safety argument.
 */
export const RESTORE_LEASE_MS = 5 * 60_000;

/**
 * Bounds on what a decrypted escrow may claim, so a damaged one cannot become a damaged vault.
 *
 * A generation is an integer the vault uses as part of a storage key **and** as a pointer it advances when the
 * value is larger. So a fractional or enormous one is not merely odd input: it leaves this Node sealing under
 * a generation nothing else will ever produce. The count is bounded for the ordinary reason — the loop makes
 * one Durable Object call per entry.
 */
const MAX_ESCROWED_GENERATIONS = 100;
const MAX_GENERATION = 10_000;

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
/*
 * Exported for one test, and the test could not be written without it.
 *
 * The failure branch — the vault refusing part way, so the code must **not** be spent — needs an escrow that
 * opens and then makes `restore` reject. Every escrow this Node writes is well-formed, so producing that state
 * means sealing one deliberately, which needs the key the code derives. Reaching into the crypto to build a
 * broken input is the only way to prove the branch that decides whether an operator loses one of ten codes to
 * a crash.
 */
export async function codeKey(code: string): Promise<CryptoKey> {
  return await aesKeyFrom(`mailda/vault-escrow/v1/${normaliseCode(code)}`);
}

export async function seal(key: CryptoKey, plaintext: string): Promise<string> {
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
 * Called at claim, and callable again to re-escrow after a rotation. Ten codes that open a vault two
 * generations behind are ten codes that restore a Node unable to read its recent mail, and a silent stale
 * escrow is the failure this whole file exists to prevent — so a fresh set is the honest response to a
 * rotation.
 *
 * **It does not invalidate the previous set, and this paragraph used to say it did.** A *confirmed* sheet
 * survives until its replacement is confirmed in turn (audit P1-2): a rotation whose response is lost would
 * otherwise leave the operator holding an old sheet that no longer works and a new one they never saw. What
 * this deletes is an **unconfirmed** sheet — nobody proved they hold it — and not one whose code a restore is
 * running against right now, which would take the escrow that attempt needs to resume with.
 *
 * The stale sentence outlived the behaviour by two rounds, in the file whose subject is what an operator does
 * when everything else has gone wrong.
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
      /*
       * The same in-transaction guard the confirmation carries, and rotation had **none at all**.
       *
       * `redeemForVault` does not require `confirmed_at IS NOT NULL`, so a pending sheet's code is real
       * recovery material and can legitimately be mid-restore when the next rotation deletes it — taking the
       * escrow that attempt needs to resume with. The delete is skipped in that case and the mint proceeds:
       * two pending sheets for a few minutes is untidy, and destroying a live recovery is not.
       */
      env.CATALOG.prepare(
        `DELETE FROM recovery_codes
          WHERE org_id = ? AND confirmed_at IS NULL AND ${NO_LIVE_RESTORE_PENDING}`,
      ).bind(orgId, orgId, new Date(ctx.now() - RESTORE_LEASE_MS).toISOString()),
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
  /**
   * How a generation is put back — the real vault by default.
   *
   * ## Why this parameter exists, and why it is the smallest one that works
   *
   * The failure branch below settles as `failed` and **does not spend the code**, which is the difference
   * between an operator losing one of ten to a crash and being able to run it again. It had no test, and its
   * own comment said so: `vault.restore` answers one of three outcomes for every well-formed input, the
   * escrow's shape is checked before the loop, and two attempts to force a refusal from data both failed —
   * `seal()` overflows on a payload large enough to matter, and miniflare does not enforce the storage-key
   * limit that would have rejected one. So the only remaining trigger is the Durable Object itself failing,
   * which nothing reachable from a test can arrange.
   *
   * A seam is therefore the honest way to reach it, and this is the narrowest available: one function, the
   * same signature the vault's own `restore` has, defaulted to it. It cannot change behaviour when nobody
   * passes it, and it is not configuration — there is no environment variable, no flag, and nothing the
   * deployed Node reads. `codeKey` and `seal` are exported a few lines above for the same reason and with the
   * same argument.
   *
   * What it buys is the whole branch, end to end: some generations installed, the failure detail persisted,
   * the attempt `failed`, ownership released, `redeemed_at` untouched, and a re-run that succeeds — none of
   * which was held by anything but reasoning.
   */
  restoreKey: (
    purpose: KeyPurpose, generation: number, secret: string,
  ) => Promise<"restored" | "conflict" | "identical" | "adopted"> = (purpose, generation, secret) =>
    vault(env).restore(purpose, generation, secret),
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
   *
   * It was not, in practice. #92's drill spent a code, collided on both generations, and every layer above
   * read two empty arrays and two non-empty ones as a success — so `conflictNotice` below says it in words a
   * caller cannot mistake, and the route puts it in the payload.
   */
  conflicted: { content: number[]; credential: number[] };
  /** The subset of `restored` that displaced a reserved, never-sealed generation of the same number. */
  adopted: { content: number[]; credential: number[] };
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
   * removing it entirely leaves every test passing, because the reservation below refuses the same code for
   * the same reason. What is lost without it is the *date* — "already used, on 2026-08-26" instead of "used
   * by another request while this one was running", which is a worse sentence for somebody holding a list of
   * ten codes and trying to work out which they have spent.
   *
   * `redeemed_at` is set only by a restore that **completed**, since the saga deliberately does not spend a
   * failed attempt — so this refusal means the vault was put back, not merely that somebody tried. That
   * distinction is why the sentence says "used" rather than "spent".
   *
   * Kept deliberately, and labelled, because a surviving mutant here is a reader's question and this is the
   * answer: the guard is redundant on purpose, and the redundancy buys a better refusal.
   */
  if (row.redeemed_at !== null) {
    throw unprocessable("E_RECOVERY_CODE_SPENT", {
      what: `that recovery code was already used, on ${row.redeemed_at}`,
      /*
       * This said the code was spent "whether or not the restore it was used for succeeded", which stopped
       * being true when the saga landed: `redeemed_at` is written only by a settlement that **completed**, and
       * a failed attempt deliberately costs nothing. The old sentence sent an operator to their next code
       * when retrying the same one is the designed remedy — which is the wrong direction to be wrong in, with
       * nine left and an incident running.
       */
      why: "ADR 29's codes are single-use, and this one was spent by a restore that ran to the end — a "
        + "failed attempt does not spend a code, so this is a record of a completed recovery rather than of "
        + "an attempt",
      fix: "check `doctor`'s `recovery_restore_state` for what that restore installed. If you need to run "
        + "another, use a different code from the same sheet",
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
  /*
   * The decrypted escrow is **parsed and checked before it is used**, and a corrupt one is a real state: a
   * blob that still decrypts and no longer describes a vault.
   *
   * The parse was unguarded, so invalid JSON threw a bare `SyntaxError` — a 500 with no `what`, `why` or
   * `fix`, on the disaster-recovery path, where the operator has nine codes left and no idea whether to spend
   * one. The shape check that followed accepted any number as a generation, which matters more than it
   * looks: `KeyVault.restore` builds a storage key from it and **advances the current-generation pointer**
   * when it is larger, so `1.5` would leave the vault sealing under a fractional generation for ever.
   *
   * Generation zero is refused too. It is the published legacy constant, `readVault` never escrows it, and
   * `restore` answers `identical` without writing — so its presence means the blob did not come from here.
   */
  const escrowed = ((): EscrowedVault | null => {
    try {
      return JSON.parse(plain) as EscrowedVault;
    } catch {
      return null;
    }
  })();

  const shaped = (part: unknown): boolean => {
    if (!Array.isArray(part) || part.length > MAX_ESCROWED_GENERATIONS) return false;
    const seen = new Set<number>();
    for (const key of part) {
      if (typeof key !== "object" || key === null) return false;
      const { generation, secret } = key as { generation?: unknown; secret?: unknown };
      if (typeof generation !== "number" || !Number.isInteger(generation)) return false;
      if (generation <= 0 || generation > MAX_GENERATION) return false;
      if (seen.has(generation)) return false;
      seen.add(generation);
      // 32 bytes, base64. The vault stores what it is given, so a secret of the wrong length is a key that
      // decrypts nothing — installed, counted as restored, and useless.
      if (typeof secret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) return false;
    }
    return true;
  };

  if (escrowed === null || !shaped(escrowed.content) || !shaped(escrowed.credential)) {
    throw unprocessable("E_RECOVERY_ESCROW_CORRUPT", {
      what: "that code opened its escrow and the escrow does not describe a key vault",
      why: "the blob decrypted, so the code is right — what it carried is damaged. Nothing was installed and "
        + "the code has not been spent",
      fix: "try another code from the same sheet. If they all answer this, the escrow was written by a "
        + "version of this Node that wrote a different shape, and `doctor` will say what the vault now holds",
    });
  }

  const restoreId = ctx.id(ID_PREFIXES.recoveryRestore);
  const at = new Date(ctx.now()).toISOString();
  const stale = new Date(ctx.now() - RESTORE_LEASE_MS).toISOString();

  /*
   * ## One predicate, used three times
   *
   * The reservation, the audit gate and the refusal all have to be asking the same question, and the first
   * version had them asking three. It gated nothing on the entry, tested only for a live `started` row on the
   * insert, and answered with a single code — which left two defects:
   *
   * - **A request turned away still recorded that a restore began.** The entry's insert was unconditional, so
   *   a caller who lost the reservation wrote `recovery.restore_started` and then threw. The catalogue defines
   *   that action as *a code was accepted and restoration began*, and neither had happened.
   * - **A code spent between the read and the batch was restored again.** The `NOT EXISTS` looked for a live
   *   attempt; a winner that had already *finished* leaves none, so a second request sailed through and
   *   restored from a code the database says is spent. Not an escalation — the escrow's contents are the same
   *   either way — but it breaks single use and makes the trail claim something the row does not.
   *
   * So the predicate is written once and bound twice: as the `AuditGate`, so no entry exists for an attempt
   * that never began, and as the `INSERT … SELECT`'s own source, so the row and the entry cannot disagree.
   * The gate must precede the statement that changes it, which `auditedBatch` requires and the ordering here
   * satisfies.
   */
  const reservable = `SELECT 1 FROM recovery_codes c
     WHERE c.org_id = ? AND c.id = ? AND c.redeemed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM recovery_restores r
                        WHERE r.org_id = c.org_id AND r.code_id = c.id
                          AND r.state = 'started' AND r.started_at > ?)`;
  const reservableParams = [orgId, row.id, stale];

  const { results: opened } = await auditedBatch(
    env, ctx, orgId,
    {
      action: "recovery.restore_started",
      outcome: "ok",
      actorKind: "node",
      subject: row.id,
      detail: {
        restore: restoreId,
        escrowedContent: escrowed.content.map((key) => key.generation),
        escrowedCredential: escrowed.credential.map((key) => key.generation),
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO recovery_restores (id, org_id, code_id, state, started_at)
         SELECT ?, c.org_id, c.id, 'started', ?
           FROM recovery_codes c
          WHERE c.org_id = ? AND c.id = ? AND c.redeemed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM recovery_restores r
                             WHERE r.org_id = c.org_id AND r.code_id = c.id
                               AND r.state = 'started' AND r.started_at > ?)`,
      ).bind(restoreId, at, ...reservableParams),
      /*
       * The attempt this one displaced, marked **superseded** rather than left as a `started` row that never
       * settles.
       *
       * Both of these statements carry `EXISTS (… w.id = restoreId …)`, which is *this attempt's own row* —
       * so they run only when the insert above won. Without it a request that lost the reservation still
       * superseded the winner and stamped its own ownership, and both callers then failed to settle. That was
       * this change's own first draft: a compare-and-swap whose consequences were not swapped with it. Distinct from `failed` on purpose: failed means the vault refused and the operator should run
       * it again; superseded means somebody else already did, and running it again would be a third history of
       * one code. `doctor` reads the latest row, so a lapsed attempt left `started` for ever would go on
       * reporting an interrupted restore that has since completed.
       */
      env.CATALOG.prepare(
        `UPDATE recovery_restores SET state = 'superseded', settled_at = ?
          WHERE org_id = ? AND code_id = ? AND state = 'started' AND id <> ?
            AND EXISTS (SELECT 1 FROM recovery_restores w WHERE w.id = ? AND w.state = 'started')`,
      ).bind(at, orgId, row.id, restoreId, restoreId),
      /*
       * Ownership. Settlement is conditional on still holding this, so a worker whose lease lapsed and whose
       * code was re-claimed writes nothing — the compare-and-swap the previous version had at acquisition and
       * not at the end.
       */
      env.CATALOG.prepare(
        `UPDATE recovery_codes SET active_restore_id = ?
          WHERE org_id = ? AND id = ? AND redeemed_at IS NULL
            AND EXISTS (SELECT 1 FROM recovery_restores w WHERE w.id = ? AND w.state = 'started')`,
      ).bind(restoreId, orgId, row.id, restoreId),
    ],
    { sql: reservable, params: reservableParams },
  );

  if ((opened[1]?.meta.changes ?? 0) === 0) {
    /*
     * Re-read to say **which** term refused. One code for both states sends an operator to the wrong remedy:
     * "already being redeemed" tells them to wait, "already spent" tells them to use another, and those are
     * not interchangeable when there are nine left and an incident running.
     *
     * The spent branch here is the **interleaved** case only — a code spent between this function's first
     * read and this batch. The ordinary one is refused far above, at that read, and has been since before the
     * saga existed. So no sequential test enters this branch, which is said rather than implied; what the
     * tests do assert is the predicate it reports on, since the reservation's `redeemed_at IS NULL` is what
     * the old `NOT EXISTS`-only condition was missing.
     */
    const state = await env.CATALOG.prepare(
      `SELECT c.redeemed_at,
              (SELECT COUNT(*) FROM recovery_restores r
                WHERE r.org_id = c.org_id AND r.code_id = c.id
                  AND r.state = 'started' AND r.started_at > ?) AS live
         FROM recovery_codes c WHERE c.org_id = ? AND c.id = ?`,
    ).bind(stale, orgId, row.id).first<{ redeemed_at: string | null; live: number }>();

    if (state === null) {
      /*
       * The row is **gone**, not spent. A concurrent rotation or confirmation can retire a set between this
       * function's read and its reservation, and answering "already used" sends an operator to their next
       * code when the sheet itself has been replaced — the wrong remedy during the incident this path exists
       * for.
       *
       * **Interleaving-only**, and said rather than implied: the row has to vanish between this function's
       * first read and its reservation, and the retirement that would do it is now refused while a restore is
       * live. So this is the residue — a rotation landing in the same instant — and no sequential test reaches
       * it. What is tested is the refusal that prevents the ordinary version:
       * `test/recovery-escrow.test.ts` proves a confirmation will not retire a sheet being restored from.
       */
      throw unprocessable("E_RECOVERY_CODE_UNKNOWN", {
        what: "that code's sheet was replaced while this request was running",
        why: "a rotation or a confirmation retired the set it belongs to, which deletes its rows. The code "
          + "was real and is no longer this Node's",
        fix: "use a code from the sheet this Node last printed. If you do not have it, mint a fresh set",
      });
    }
    if (Number(state.live) > 0) {
      throw unprocessable("E_RECOVERY_RESTORE_IN_FLIGHT", {
        what: "that code is already being redeemed by another request",
        why: "a restore installs keys through the vault, which cannot join this database's transaction — so "
          + "it is reserved while it runs rather than attempted twice",
        fix: `wait for the attempt in flight to finish and check \`doctor\`. If it never finishes, the `
          + `reservation lapses after ${Math.round(RESTORE_LEASE_MS / 60_000)} minutes and the code can be `
          + "used again",
      });
    }
    throw unprocessable("E_RECOVERY_CODE_SPENT", {
      what: "that recovery code has already been used",
      why: "codes are single-use, and one was spent by a request that finished between this one reading it "
        + "and reserving it. The vault was restored by that request",
      fix: "check `doctor` before spending another — the restore that won may have installed everything this "
        + "one would have",
    });
  }

  const restored = { content: [] as number[], credential: [] as number[] };
  const conflicted = { content: [] as number[], credential: [] as number[] };
  /**
   * The subset of `restored` that displaced a generation this Node had **reserved and never sealed under**
   * (#138).
   *
   * Counted as restored, because it was: the escrowed key is in the vault and the mail it sealed opens. Named
   * separately because it is a materially different event from installing into an empty slot — something was
   * replaced — and an operator reading a recovery's record should not have to infer that from silence.
   */
  const adopted = { content: [] as number[], credential: [] as number[] };
  /*
   * `failure` records a vault refusal part way through, and the branch it feeds settles as `failed` and does
   * **not** spend the code — the difference between an operator losing one of ten to a crash and being able
   * to run it again.
   *
   * It has no data-driven trigger: `vault.restore` answers one of three outcomes for every well-formed input,
   * the escrow's shape is checked above, and two attempts to force a refusal from data both failed. It is
   * driven end to end through the `restoreKey` seam instead — see its own note — and
   * `test/recovery-escrow.test.ts` now asserts every consequence: what was installed before the refusal, the
   * detail persisted, the attempt `failed`, the ownership released, `redeemed_at` untouched, and a re-run
   * that completes.
   */
  let failure: string | null = null;
  try {
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
        const outcome = await restoreKey(purpose, key.generation, key.secret);
        if (outcome === "restored") restored[purpose].push(key.generation);
        /*
         * `adopted` is a restore. The generation was present under a different secret and nothing had ever
         * sealed with it — a number this Node reserved when `doctor` initialised the vault — so the escrowed
         * key took its place and the mail sealed under it opens. Both lists get it: `restored` because that
         * is what happened to the evidence, `adopted` because something was displaced.
         */
        else if (outcome === "adopted") {
          restored[purpose].push(key.generation);
          adopted[purpose].push(key.generation);
        }
        else if (outcome === "conflict") conflicted[purpose].push(key.generation);
      }
    }
  } catch (error) {
    // Recorded rather than thrown past the settlement. An attempt that stopped half way is exactly the state
    // this whole shape exists to make legible, and losing it to an exception would be the old behaviour with
    // extra steps.
    failure = (error as Error).message.split("\n")[0] ?? "the vault refused a generation";
  }

  const installed = restored.content.length + restored.credential.length;
  const settledAt = new Date(ctx.now()).toISOString();
  const detail = {
    restore: restoreId,
    restored: { content: restored.content, credential: restored.credential },
    conflicted: { content: conflicted.content, credential: conflicted.credential },
    // Only when something was displaced, so the trail does not carry two empty arrays on every recovery.
    ...(adopted.content.length + adopted.credential.length === 0
      ? {}
      : { adopted: { content: adopted.content, credential: adopted.credential } }),
    ...(failure === null ? {} : { error: failure }),
  };

  /*
   * The outcome, written **knowing**. `failed` when the vault refused part way, and the code is *not* spent —
   * a crash or a refusal must not cost one of ten, and re-running is safe because every step is idempotent.
   *
   * A restore that installed nothing because every generation collided is `ok`, not `failed`: the vault
   * already holds keys of those numbers, nothing was lost, and `conflicted` says so. Calling that a failure
   * would send an operator looking for a broken thing during an incident.
   */
  const { results: settled } = await auditedBatch(
    env, ctx, orgId,
    {
      action: "recovery.vault_restored",
      outcome: failure === null ? "ok" : "failed",
      actorKind: "node",
      // The row id, never the code and never its hash — enough to answer "which of the ten, and when".
      subject: row.id,
      detail,
    },
    (entry) => [entry, ...settlementStatements(env, orgId, row.id, restoreId, {
      state: failure === null ? "completed" : "failed",
      settledAt,
      detail: JSON.stringify(detail),
      spend: failure === null,
    })],
    { sql: OWNS_RESTORE, params: [orgId, row.id, restoreId] },
  );

  /*
   * The settlement's own statement changed nothing, which means this attempt no longer owns the code — its
   * lease lapsed, somebody else re-claimed it and finished. Refused rather than reported as a success, and
   * **nothing was written**: the entry is gated on the same predicate, so the trail does not gain a second
   * history of one code.
   *
   * **Reachable only under that interleaving**, said rather than implied: the takeover has to land while this
   * function is between its acquisition and its settlement, and the call that would cause it is the one that
   * takes the claim away. What is tested is the predicate — `test/recovery-escrow.test.ts` runs
   * `settlementStatements` against a hand-built takeover and asserts it changes nothing and writes no entry.
   */
  if ((settled[1]?.meta.changes ?? 0) === 0) {
    throw unprocessable("E_RECOVERY_RESTORE_SUPERSEDED", {
      what: "this restore lost its claim on the code while it was running",
      why: `the reservation lapses after ${Math.round(RESTORE_LEASE_MS / 60_000)} minutes, and another `
        + "request took the code and finished. Its result stands; nothing here was recorded, because two "
        + "settlements for one single-use code would be two histories of the same act",
      fix: "check `doctor`'s `recovery_restore_state` finding for what the attempt that won installed",
    });
  }

  if (failure !== null) {
    throw unprocessable("E_RECOVERY_RESTORE_INCOMPLETE", {
      what: `the vault refused part way through: ${failure}`,
      why: `${installed} generation(s) were installed before it stopped. The code has **not** been spent, `
        + "because a failed attempt must not cost one of ten — and every step is idempotent, so running it "
        + "again resumes rather than repeats",
      fix: "check `doctor`'s `recovery_escrow` finding, then redeem the same code again",
    });
  }

  return { restored, conflicted, adopted };
}

/**
 * What a caller must be told when a generation could not be put back (#138).
 *
 * ## Why this is words and not a status code
 *
 * `redeemForVault` settles a wholly-collided restore as `ok`, and that is right: nothing broke and nothing was
 * lost. But #92's drill measured what "nothing broke" looks like from outside — `200`, two empty arrays, two
 * non-empty ones — and every layer above it, including this repository's own CLI, called it a restore. The
 * operator had spent one of ten codes and their mail was still unreadable.
 *
 * So the outcome stays `ok` and the *answer* stops being silent. Three things a caller cannot work out from
 * integers: the code is gone, the mail sealed under the escrowed key cannot be read, and **another code will
 * not help** — all ten carry the same generations, so a retry spends a second one for the same result. That
 * last sentence is the one worth the most: without it an operator burns the sheet.
 *
 * Returns `null` when nothing collided, so a clean restore carries no warning and the field's presence is
 * itself the signal.
 */
export function conflictNotice(
  conflicted: { content: number[]; credential: number[] },
  restored: { content: number[]; credential: number[] },
): string | null {
  const collided = conflicted.content.length + conflicted.credential.length;
  if (collided === 0) return null;
  const installed = restored.content.length + restored.credential.length;
  const generations = [
    conflicted.content.length > 0 ? `content ${conflicted.content.join(", ")}` : null,
    conflicted.credential.length > 0 ? `credential ${conflicted.credential.join(", ")}` : null,
  ].filter((one) => one !== null).join("; ");

  return `${collided} escrowed key generation(s) could not be installed (${generations})`
    + (installed === 0 ? " and nothing was restored" : `; ${installed} was installed`)
    + ". This Node already holds keys of those generation numbers under a different secret, and one number "
    + "cannot hold both — it keeps the live key, because losing newer mail to recover older is the worse "
    + "trade. The code is spent, and mail sealed under the escrowed key stays unreadable. Redeeming another "
    + "code will not change this: all ten carry the same generations.";
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
 * The two statements that make one sheet the active one: retire every other set, then confirm this one.
 *
 * ## Why both are conditional, and why the order is the way round it is
 *
 * The first version gated only the **audit entry** — `auditedBatch`'s gate wraps the entry's `INSERT`, and
 * nothing else. The `UPDATE` and the `DELETE` ran unconditionally, and that made the batch's atomicity beside
 * the point: all three statements *succeed*, because a zero-row `INSERT … SELECT` and a zero-row `UPDATE` are
 * not failures. So this interleaving destroyed an organization's entire escrow:
 *
 * ```
 *   before        X active, A pending
 *   confirm       reads a code from A
 *   rotation      deletes pending A, inserts pending B, keeps X
 *   confirm       audit insert gated off, UPDATE A → 0 rows,
 *                 DELETE everything that is not A → deletes B *and* X
 *   after         no recovery codes at all
 * ```
 *
 * The `EXISTS` puts the same predicate on the destructive statement that the gate puts on the entry, so a
 * confirmation whose set has vanished deletes nothing.
 *
 * **The delete runs first**, which is not a stylistic choice. Confirming the selected set first would make its
 * rows non-`NULL`, the `EXISTS` false, and the retirement a no-op — leaving both sheets live and the vault
 * openable by the sheet the operator was just told was retired. The two statements are in one transaction, so
 * "first" here means textual order within the batch, which is the order D1 applies them.
 *
 * Exported so `test/recovery-escrow.test.ts` can run them against a hand-built vanished-set state. That
 * interleaving cannot be produced by calling the public function in sequence, and the previous round of this
 * defect survived precisely because the test constructed a state one step short of it.
 */
/**
 * Is any code in a set being restored from right now?
 *
 * Retirement deletes a set's rows, and a row deleted mid-restore takes the escrow the attempt needs to resume
 * with it — the attempt cannot settle and cannot be run again, which is the one state a resumable operation
 * must not be able to reach. Refusing for the few minutes a lease lasts is the cheaper failure.
 */
export async function setHasLiveRestore(
  env: Env,
  orgId: string,
  keepSetId: string | null,
  now: number,
): Promise<boolean> {
  const row = await env.CATALOG.prepare(
    `SELECT 1 FROM recovery_restores r JOIN recovery_codes c ON c.id = r.code_id
      WHERE r.org_id = ? AND r.state = 'started' AND r.started_at > ?
        AND c.set_id IS NOT ? LIMIT 1`,
  ).bind(orgId, new Date(now - RESTORE_LEASE_MS).toISOString(), keepSetId).first();
  return row !== null;
}

/**
 * No code in a set this statement would delete is being restored from.
 *
 * `SQL` rather than a function, because it has to sit **inside the transaction** with the delete it guards. A
 * preflight read cannot enforce this: a restore acquired between the check and the batch is one whose escrow
 * the batch then deletes, leaving an operation that can neither settle nor resume. That is the state the whole
 * saga exists to make impossible, arrived at from the outside.
 *
 * Takes `orgId`, the set being kept, and the lease cutoff — in that order, appended after the caller's own
 * parameters.
 */
const NO_LIVE_RESTORE_ELSEWHERE = `NOT EXISTS (
    SELECT 1 FROM recovery_restores r JOIN recovery_codes c ON c.id = r.code_id
     WHERE r.org_id = ? AND c.set_id IS NOT ? AND r.state = 'started' AND r.started_at > ?)`;

/** The same question for the sets a **rotation** removes: every unconfirmed one. */
const NO_LIVE_RESTORE_PENDING = `NOT EXISTS (
    SELECT 1 FROM recovery_restores r JOIN recovery_codes c ON c.id = r.code_id
     WHERE r.org_id = ? AND c.confirmed_at IS NULL AND r.state = 'started' AND r.started_at > ?)`;

export function confirmationStatements(
  env: Env,
  orgId: string,
  setId: string | null,
  at: string,
  /** The instant a reservation older than this has lapsed. Bound into the guard below. */
  staleBefore: string,
): D1PreparedStatement[] {
  return [
    env.CATALOG.prepare(
      `DELETE FROM recovery_codes
        WHERE org_id = ? AND set_id IS NOT ?
          AND EXISTS (SELECT 1 FROM recovery_codes
                       WHERE org_id = ? AND set_id IS ? AND confirmed_at IS NULL)
          AND ${NO_LIVE_RESTORE_ELSEWHERE}`,
    ).bind(orgId, setId, orgId, setId, orgId, setId, staleBefore),
    env.CATALOG.prepare(
      `UPDATE recovery_codes SET confirmed_at = ?
        WHERE org_id = ? AND set_id IS ? AND confirmed_at IS NULL
          AND ${NO_LIVE_RESTORE_ELSEWHERE}`,
    ).bind(at, orgId, setId, orgId, setId, staleBefore),
  ];
}

/**
 * Does this restore still own the code it claimed?
 *
 * The predicate is written once and used three times — as the settlement's `AuditGate`, and on both statements
 * that settle — for the reason the acquisition predicate is: three copies of one question is three chances for
 * them to answer differently, and the one that matters here decides whether a stale worker gets to write a
 * second history of a single-use code.
 */
const OWNS_RESTORE =
  `SELECT 1 FROM recovery_codes c JOIN recovery_restores r ON r.id = c.active_restore_id
    WHERE c.org_id = ? AND c.id = ? AND c.active_restore_id = ? AND r.state = 'started'`;

/**
 * Settling one restore, conditional on it still owning the code.
 *
 * Exported so a takeover can be built by hand. The state it guards against — lease lapsed, code re-claimed and
 * finished by somebody else, original worker returning — cannot be produced by calling `redeemForVault` in
 * sequence, because the second call is what takes the claim away. This is the same reason
 * `confirmationStatements` is exported, and the previous round's defect survived precisely because the test
 * stopped one step short of building the interleaving.
 */
export function settlementStatements(
  env: Env,
  orgId: string,
  codeId: string,
  restoreId: string,
  outcome: { state: "completed" | "failed"; settledAt: string; detail: string; spend: boolean },
): D1PreparedStatement[] {
  return [
    env.CATALOG.prepare(
      `UPDATE recovery_restores SET state = ?, settled_at = ?, detail = ?
        WHERE id = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM recovery_codes c
                       WHERE c.org_id = ? AND c.id = ? AND c.active_restore_id = ?)`,
    ).bind(outcome.state, outcome.settledAt, outcome.detail, restoreId, orgId, codeId, restoreId),
    /*
     * The code is spent and its ownership released together. Releasing matters: a completed restore that left
     * `active_restore_id` set would keep answering "somebody is restoring from this" for ever, and the column
     * is what `doctor` and the next acquisition read.
     */
    ...(outcome.spend
      ? [env.CATALOG.prepare(
          `UPDATE recovery_codes SET redeemed_at = ?, active_restore_id = NULL
            WHERE org_id = ? AND id = ? AND redeemed_at IS NULL AND active_restore_id = ?`,
        ).bind(outcome.settledAt, orgId, codeId, restoreId)]
      : [env.CATALOG.prepare(
          `UPDATE recovery_codes SET active_restore_id = NULL
            WHERE org_id = ? AND id = ? AND active_restore_id = ?`,
        ).bind(orgId, codeId, restoreId)]),
  ];
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
   * `set_id IS ?` and `IS NOT ?`, not `=` and `<>`. SQLite's `IS` is the null-safe comparison and `set_id` is
   * nullable, because migration 0047 leaves pre-migration rows as the legacy set. `= NULL` is `NULL`, which is
   * not true, so the `=` forms would confirm nothing for a legacy set and — far worse — retire nothing,
   * leaving both sheets live and the vault openable by one the operator has just replaced.
   *
   * Retirement is a **delete** rather than a state. Each row carries the vault sealed under its own code, so a
   * retired row left in the table is the vault still openable by the old sheet — exactly what somebody
   * rotating their codes is trying to stop being true. A `retired_at` column would have recorded the intent
   * and kept the capability.
   */
  /*
   * Refused while a code in a retiring set is being restored from. The delete would take the escrow that
   * attempt needs to resume with, leaving an operation that can neither settle nor be run again — and the
   * whole point of the saga is that an interrupted restore is resumable. A lease lasts five minutes; a
   * recovery that cannot be finished lasts as long as the mail does.
   */
  /*
   * A **preflight for the message**, not the enforcement. The guard that matters is inside the transaction
   * below; this exists so an operator gets a sentence naming the wait rather than a silent no-op, and the two
   * cannot disagree because the statements refuse whatever this misses.
   */
  if (await setHasLiveRestore(env, orgId, row.set_id, ctx.now())) {
    throw unprocessable("E_RECOVERY_RESTORE_IN_FLIGHT", {
      what: "a code from the sheet this would retire is being redeemed right now",
      why: "confirming retires every other sheet, and deleting a code mid-restore takes the escrow that "
        + "attempt needs to resume with — it could then neither finish nor be run again",
      fix: `wait for the restore to finish and confirm again. A reservation lapses after `
        + `${Math.round(RESTORE_LEASE_MS / 60_000)} minutes`,
    });
  }

  /*
   * The lease cutoff, computed once and bound into both the gate and the statements — so the entry, the
   * delete and the confirmation all decide "is a restore live" against the same instant. Three reads of the
   * clock would be three slightly different questions, which is the shape of race this whole function keeps
   * meeting.
   */
  const staleBefore = new Date(ctx.now() - RESTORE_LEASE_MS).toISOString();

  const retiring = await env.CATALOG.prepare(
    `SELECT COUNT(DISTINCT IFNULL(set_id, '')) AS sets FROM recovery_codes
      WHERE org_id = ? AND set_id IS NOT ?`,
  ).bind(orgId, row.set_id).first<{ sets: number }>();

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
    (entry) => [entry, ...confirmationStatements(env, orgId, row.set_id, at, staleBefore)],
    {
      /*
       * The gate carries the live-restore term as well, so an entry cannot be written for a retirement the
       * statements beside it refuse. Same predicate, same instant, three uses — the lesson the reservation
       * predicate above already records.
       */
      sql: `SELECT 1 FROM recovery_codes WHERE org_id = ? AND set_id IS ? AND confirmed_at IS NULL
              AND ${NO_LIVE_RESTORE_ELSEWHERE}`,
      params: [orgId, row.set_id, orgId, row.set_id, staleBefore],
    },
  );

  /*
   * The confirming `UPDATE` is the last statement, and a zero-row result means the set this request read a
   * code from is **gone** — retired by a rotation that landed between the read and the write. Reported as a
   * conflict rather than as `confirmed: 0`, because the operator typed a real code and needs to know that
   * nothing happened and why.
   *
   * **Reachable only under that interleaving, and this says so rather than implying coverage.** Called in
   * sequence the update always finds the rows the select above just matched, so no test enters this branch.
   * What is tested is the condition: `test/recovery-escrow.test.ts` runs `confirmationStatements` against a
   * hand-built vanished-set state and asserts the update changes zero rows. The branch is the mapping from
   * that fact to an answer.
   */
  const confirmed = results[results.length - 1]?.meta.changes ?? 0;
  if (confirmed === 0) {
    /*
     * Zero rows has **two** causes and they are not the same answer. The sheet may be gone — replaced by a
     * rotation between the read and the write — or it may still be here and simply confirmed already, by
     * another request that won the same race. The first version reported both as replaced, which tells an
     * operator their sheet is dead when it is the active one.
     *
     * Re-read to tell them apart. Somebody confirming a sheet that somebody else just confirmed has done no
     * harm and needs no error: it is the `alreadyConfirmed` answer, which is exactly what the sequential
     * version of that case gets from the early return far above.
     *
     * **Reachable only under that interleaving**, said plainly rather than implied — confirmed between this
     * function's read and this batch. Sequentially the read sees the confirmation and returns before getting
     * here. `test/recovery-escrow.test.ts` pins the answer through the early path; this is the same answer
     * for the race.
     */
    const still = await env.CATALOG.prepare(
      `SELECT COUNT(*) AS present,
              SUM(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS held
         FROM recovery_codes WHERE org_id = ? AND set_id IS ?`,
    ).bind(orgId, row.set_id).first<{ present: number; held: number }>();
    if (still !== null && Number(still.present) > 0 && Number(still.held) > 0) {
      return { confirmed: 0, alreadyConfirmed: true };
    }
    throw unprocessable("E_RECOVERY_SET_REPLACED", {
      what: "the set that code belongs to was replaced while this confirmation was in flight",
      why: "a rotation landed between reading your code and recording it, so the sheet you typed from is no "
        + "longer this Node's. Nothing was confirmed and nothing was retired",
      fix: "type a code from the sheet the rotation printed. If you do not have it, mint a fresh set",
    });
  }

  return { confirmed, alreadyConfirmed: false };
}

/**
 * Record that somebody has assessed a permanent key collision.
 *
 * ## What this is not
 *
 * It is **not** a repair, and the wording throughout says so. Two different secrets cannot share one
 * generation number; mail sealed under the escrowed key of that generation is unreadable and stays that way.
 * Nothing here changes a byte of evidence.
 *
 * What it changes is whether `doctor`'s verdict is decided by a fact nobody can act on any further. A
 * permanent `degraded` that no act discharges is a warning an operator learns to scroll past — and then the
 * next real one is read as the same old noise. The finding remains, `ok` stays `false`, and the severity drops
 * to `report`.
 *
 * ## Why the generations are part of the identity
 *
 * The acknowledgement names the exact conflicted set it was made about. If that restore is later found to
 * have collided with a generation nobody assessed, the key no longer matches and the finding returns to
 * `degraded` — which is the fail-closed direction, and the only one under which the record means what it
 * says. Acknowledging a restore once and for all would be acknowledging future discoveries in advance.
 *
 * Immutable and unique: a second acknowledgement of the same set is refused rather than layered, so the trail
 * cannot hold two conclusions about one incident with nothing saying which stands.
 */
export async function acknowledgeKeyConflict(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: { restoreId: string; scope: string; conclusion: string },
): Promise<{ acknowledgedAt: string; generations: string }> {
  const restore = await env.CATALOG.prepare(
    "SELECT id, state, detail FROM recovery_restores WHERE org_id = ? AND id = ?",
  ).bind(orgId, input.restoreId).first<{ id: string; state: string; detail: string | null }>();

  if (restore === null || restore.state !== "completed") {
    throw unprocessable("E_RESTORE_NOT_ACKNOWLEDGEABLE", {
      what: restore === null
        ? `no completed restore ${input.restoreId}`
        : `restore ${input.restoreId} is ${restore.state}`,
      why: "an acknowledgement is a statement about a collision that has happened, and only a completed "
        + "restore has reported one. Acknowledging an attempt still in flight would record a conclusion "
        + "about an outcome nobody has seen",
      fix: "name a completed restore — `GET /api/doctor` lists the ones that collided",
    });
  }

  const { conflicted } = restoreDetail(restore.detail);
  if (conflicted.length === 0) {
    throw unprocessable("E_RESTORE_HAD_NO_CONFLICT", {
      what: `restore ${input.restoreId} reported no key collision`,
      why: "acknowledging a collision that did not happen would put a permanent incident record against a "
        + "restore that went cleanly, and a later reader has no way to tell that apart from one that did",
      fix: "check the restore id — `recovery_key_conflicts` in the doctor report names the ones that collided",
    });
  }

  /*
   * Both refused rather than defaulted. A blank conclusion is a dismissal, and this table exists to be
   * distinguishable from one; a blank scope makes the record unreadable to whoever finds it in a year, which
   * is the only reader it has.
   */
  for (const [field, value] of [["scope", input.scope], ["conclusion", input.conclusion]] as const) {
    if (value.trim() === "") {
      throw unprocessable("E_ACKNOWLEDGEMENT_INCOMPLETE", {
        what: `${field} was empty`,
        why: "an acknowledgement with no " + field + " is a dismissal wearing the shape of an assessment, and "
          + "the only reader of this record is somebody who arrives long after everybody involved has gone",
        fix: `send a ${field} describing what was examined and what was concluded`,
      });
    }
  }

  const generations = conflictKey(conflicted);
  const at = new Date(ctx.now()).toISOString();

  /*
   * **A compare-and-swap, not a read followed by a write.**
   *
   * The first version read whether an acknowledgement existed and then inserted. Two concurrent assessments
   * both pass that read, and the unique index catches the second — as a raw constraint violation, so the
   * loser gets a generic database failure instead of `E_ALREADY_ACKNOWLEDGED` and the reason it was refused.
   * The trail stayed correct, because the batch is atomic and rolls the audit entry back with it; the caller
   * was told nothing useful, during an incident, which is when this route is used.
   *
   * `INSERT … SELECT … WHERE NOT EXISTS` decides in the same statement, and the audit entry is gated on the
   * same predicate — so an acknowledgement that changes nothing writes no entry either, rather than leaving a
   * record of an assessment that was not stored. The unique index stays as the backstop it should be, rather
   * than as the mechanism.
   */
  const NOT_YET_ACKNOWLEDGED =
    `SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM recovery_key_conflict_acknowledgements
        WHERE org_id = ? AND restore_id = ? AND generations = ?)`;

  const { results } = await auditedBatch(env, ctx, orgId, {
    action: "recovery.conflict_acknowledged",
    outcome: "ok",
    actorUserId,
    subject: input.restoreId,
    detail: { generations, scope: input.scope, conclusion: input.conclusion },
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      `INSERT INTO recovery_key_conflict_acknowledgements
         (id, org_id, restore_id, generations, assessed_by, assessed_at, scope, conclusion)
       SELECT ?,?,?,?,?,?,?,?
        WHERE NOT EXISTS (
          SELECT 1 FROM recovery_key_conflict_acknowledgements
           WHERE org_id = ? AND restore_id = ? AND generations = ?)`,
    ).bind(
      ctx.id("rka"), orgId, input.restoreId, generations, actorUserId, at, input.scope, input.conclusion,
      orgId, input.restoreId, generations,
    ),
  ], { sql: NOT_YET_ACKNOWLEDGED, params: [orgId, input.restoreId, generations] });

  if ((results[1]?.meta.changes ?? 0) === 0) {
    /*
     * Nothing was written — somebody else assessed this set. Read theirs to name them, which is the whole
     * point of refusing: the caller needs to find the conclusion that stands, not merely be told no.
     */
    const existing = await env.CATALOG.prepare(
      `SELECT assessed_by, assessed_at FROM recovery_key_conflict_acknowledgements
        WHERE org_id = ? AND restore_id = ? AND generations = ?`,
    ).bind(orgId, input.restoreId, generations).first<{ assessed_by: string; assessed_at: string }>();
    throw unprocessable("E_ALREADY_ACKNOWLEDGED", {
      what: `${input.restoreId} generations ${generations} were assessed by `
        + `${existing?.assessed_by ?? "somebody else"} on ${existing?.assessed_at ?? "an earlier date"}`,
      why: "an acknowledgement is immutable, so a second one would leave two conclusions about one incident "
        + "with nothing saying which stands",
      fix: "read the existing assessment. If the conclusion has changed, that is a new incident and belongs "
        + "in the audit trail as its own entry rather than as a replacement for this one",
    });
  }

  return { acknowledgedAt: at, generations };
}
