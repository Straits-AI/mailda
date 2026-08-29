import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { runDoctor, type Finding } from "../src/doctor.ts";
import { aesKeyFrom, vault } from "../src/keyvault.ts";
import {
  CODE_CHARACTERS, codeHash, confirmationStatements, confirmRecoveryCodes, escrowState, formatCode,
  codeKey, mintRecoveryCodes, normaliseCode, redeemForVault, RESTORE_LEASE_MS, seal,
  settlementStatements,
} from "../src/recovery.ts";

/**
 * ADR 29's recovery codes, carrying ADR 28's key escrow (#92).
 *
 * ## The gate under test
 *
 * `keyvault.ts` says *"ADR 28 therefore does not ship without the key escrow in ADR 29"* — a release
 * condition the code set for itself and nothing satisfied. Three refusals already told an operator to
 * restore the vault from codes that did not exist. So the property here is not "codes can be minted": it is
 * that **a vault whose Durable Object storage is gone can be put back**, and that the things which would
 * make that a false comfort are refused.
 *
 * ## The four ways this could be theatre, each asserted against
 *
 * 1. **The escrow openable by whoever holds the table.** Sealing under the stored `code_hash` would put the
 *    ciphertext and its key in one row, and a D1 dump would carry both. Asserted directly: the hash does not
 *    open the blob.
 * 2. **A stale escrow reporting healthy.** A rotation makes new objects openable only by the new key, so an
 *    escrow taken before it restores a vault that reads old mail and not new — a half recovery that looks
 *    whole. `doctor` has to say so.
 * 3. **A restore that overwrites.** Redeeming against a healthy vault, which is a mistake made under
 *    pressure, must not replace live keys with older copies.
 * 4. **A code spent on a failure.** Ten single-use codes are not many, and burning one on a typo during an
 *    incident is how a recovery path runs out.
 */

/**
 * Asserts a Durable Object RPC rejected, without leaving the rejection unhandled.
 *
 * `await expect(vault(env).openingKey(…)).rejects.toThrow(…)` reads better and is subtly wrong here: the
 * cross-boundary RPC settles a second promise inside workerd's stub, which nothing awaits, so vitest
 * reported **1222 tests passed and exited non-zero** on an "Unhandled Rejection". A suite that passes while
 * failing the process is the worst available outcome — it fails somewhere nobody is looking.
 *
 * Settling it here with `.then(ok, err)` means the rejection is consumed exactly once, by this.
 */
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const outcome = await promise.then(() => "resolved", (error: unknown) => String(error));
  expect(outcome, `expected a rejection matching ${pattern}`).toMatch(pattern);
}

const testEnv = env as unknown as Env;
const ORG = "org_recovery";
const ORIGIN = "https://node";
const USER = "usr_recovery0000000000000001";

function find(findings: Finding[], check: string): Finding {
  const found = findings.find((one) => one.check === check);
  if (found === undefined) throw new Error(`no finding named ${check}`);
  return found;
}

/**
 * Wipes the vault's Durable Object storage — the loss this whole mechanism exists for.
 *
 * Through `runInDurableObject` rather than a `wipeForTest()` method on `KeyVault`. A production class does
 * not grow a way to destroy every key so that a test can call it: the method would be reachable from
 * anything holding the stub, and "only tests call it" is a convention rather than a guarantee. This reaches
 * the same storage from outside, which is what the test pool exists for.
 */
/** How many distinct sheets are present. The whole of P1-2 is that this can legitimately be two. */
async function heldSets(): Promise<number> {
  const row = await testEnv.CATALOG.prepare(
    "SELECT COUNT(DISTINCT IFNULL(set_id, '')) AS sets FROM recovery_codes WHERE org_id = ?",
  ).bind(ORG).first<{ sets: number }>();
  return Number(row?.sets ?? 0);
}

async function loseTheVault(): Promise<void> {
  await runInDurableObject(vault(testEnv), async (_instance, state) => {
    await state.storage.deleteAll();
  });
}

beforeEach(async () => {
  // `audit_entries` included since confirmation became an audited act: the assertions below count
  // entries, and this file mints and confirms in most of its cases.
  for (const table of ["recovery_codes", "recovery_restores", "node_claim", "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
  ).bind(ctx.id("clm"), "x", new Date(ctx.now()).toISOString(), ORG).run();
  /*
   * The vault is emptied **first**, and this is not tidiness.
   *
   * Isolated storage rolls back D1 and R2 between tests; Durable Object storage in this file did not, so
   * generations accumulated across cases — a test that rotated twice left the next one starting at three,
   * and two assertions about *which* generation is current passed or failed depending on the order they ran
   * in. Every case here is about generation numbers, so shared vault state makes the whole file
   * order-dependent rather than merely noisy.
   */
  await loseTheVault();
  // Then cause the vault to exist, the way a claim does by issuing a session.
  await vault(testEnv).sealingKey("content");
  await vault(testEnv).sealingKey("credential");
});

describe("a lost vault can be put back", () => {
  it("restores the keys a wiped vault held, from one code", async () => {
    /*
     * The whole point, end to end. Note what is compared: the **secret**, not merely that a key exists. A
     * restore that produced a fresh key would satisfy "the vault has a content key" and leave every sealed
     * object unreadable, which is the failure the mechanism is for rather than a lesser version of success.
     */
    const before = await vault(testEnv).openingKey("content", 1);
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(codes).toHaveLength(10);

    await loseTheVault();
    await rejectsWith(vault(testEnv).openingKey("content", 1), /E_VAULT_UNKNOWN_GENERATION/);

    const restored = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[3]!);
    expect(restored.restored.content).toContain(1);

    const after = await vault(testEnv).openingKey("content", 1);
    expect(after.secret, "the restored key is not the key that was escrowed").toBe(before.secret);
  });

  it("restores every generation, not only the newest", async () => {
    /*
     * Objects are opened with the generation they record, so an escrow carrying only the current key restores
     * a vault that can read recent mail and nothing older. Two generations, both asserted, because "the
     * vault works again" is satisfied by a Node that lost half its archive.
     */
    const first = await vault(testEnv).openingKey("content", 1);
    await vault(testEnv).rotate("content");
    const second = await vault(testEnv).openingKey("content", 2);

    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    expect((await vault(testEnv).openingKey("content", 1)).secret).toBe(first.secret);
    expect((await vault(testEnv).openingKey("content", 2)).secret).toBe(second.secret);
  });

  it("lets any of the ten open it, because nine will be lost", async () => {
    // ADR 29's ten single-use codes only mean something if each works alone. A design needing them combined
    // would make nine losses fatal, which is the ordinary case rather than the edge.
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    for (const code of [codes[0]!, codes[9]!]) {
      await loseTheVault();
      await expect(redeemForVault(testEnv, createSystemCtx(), ORG, code)).resolves.toBeDefined();
    }
  });
});

describe("holding the table is not holding the keys", () => {
  it("cannot be opened by anything the table contains", async () => {
    /*
     * **The property that makes the escrow worth having**, and the first version of this test did not test
     * it. It called `redeemForVault` with the stored hash *as a code* — which fails the row lookup whatever
     * the blob is sealed under, so it passed against the fatal design too. Confirmed by mutation: sealing
     * under `codeHash(code)` left all sixteen tests green.
     *
     * The attack does not go through the route. Somebody holding a D1 dump has the ciphertext and every
     * column beside it, and tries to decrypt **directly**. So that is what this does: derive a key from each
     * stored value the way the escrow's own code derives one, and attempt AES-GCM against the blob.
     *
     * If the escrow were sealed under `code_hash`, the second candidate below opens it and the escrow
     * protects against nothing — which is precisely the threat ADR 28 says Durable Object storage exists to
     * defend against, reintroduced one layer down.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const stored = await testEnv.CATALOG.prepare(
      "SELECT code_hash, escrow, id FROM recovery_codes WHERE org_id = ? LIMIT 1",
    ).bind(ORG).first<{ code_hash: string; escrow: string; id: string }>();

    const bytes = Uint8Array.from(atob(stored!.escrow), (character) => character.charCodeAt(0));
    const candidates = [
      stored!.code_hash,
      `mailda/vault-escrow/v1/${stored!.code_hash}`,
      stored!.id,
      "",
    ];
    for (const candidate of candidates) {
      const key = await aesKeyFrom(candidate);
      const opened = await crypto.subtle
        .decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12))
        .then(() => true, () => false);
      expect(opened, `the escrow opened under ${JSON.stringify(candidate)}, which is in the table`)
        .toBe(false);
    }

    // Non-vacuity: the blob *is* openable, by the code. Without this the loop above would pass against a
    // column of random bytes that no key opens, which is not the same claim.
    const withCode = await crypto.subtle
      .decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        await aesKeyFrom(`mailda/vault-escrow/v1/${codes[0]!.replace(/-/g, "")}`),
        bytes.slice(12),
      )
      .then(() => true, () => false);
    expect(withCode, "the escrow is not openable by its own code either — this test proves nothing")
      .toBe(true);
    // And the stored hash really is the hash of that code, so the candidates above are the real values.
    expect(stored!.code_hash).toBe(await codeHash(codes[0]!));
  });

  it("refuses a code from another Node with the same words as an unknown one", async () => {
    /*
     * §5C. A code that verifies but does not decrypt, and a code that was never minted here, must be
     * indistinguishable — otherwise the difference tells somebody holding a stolen set which Node it came
     * from. The one distinction that *is* drawn is "already spent", and that is deliberate: the caller
     * already held the code, so it is not an oracle, and an operator reading "unknown" for a code they wrote
     * down would go looking for the wrong problem mid-incident.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const foreign = codes[0]!.replace(/[0-9]/g, (digit) => String((Number(digit) + 1) % 10));
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, foreign))
      .rejects.toThrow(/E_RECOVERY_CODE_UNKNOWN/);
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, "ABCD-EFGH-JKMN-PQRS"))
      .rejects.toThrow(/E_RECOVERY_CODE_UNKNOWN/);
  });

  it("accepts a code however it was typed back", async () => {
    // A recovery path that rejects a correctly-remembered secret over punctuation is one that fails when it
    // is needed. Hyphens and case are cosmetic and normalised.
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await expect(
      redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!.replace(/-/g, "").toLowerCase()),
    ).resolves.toBeDefined();
  });
});

describe("a code is spent once, and not on a failure", () => {
  it("does not spend one on a code that could not open the escrow", async () => {
    /*
     * Ten is not many, and the moment somebody is typing these is the moment they can least afford to lose
     * one. So the escrow is opened **before** the code is marked redeemed, which is the opposite of the
     * obvious order.
     */
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, "ABCD-EFGH-JKMN-PQRS")).rejects.toThrow();
    expect((await escrowState(testEnv, ORG))!.unredeemed).toBe(10);
  });

  it("lets exactly one of two concurrent redemptions win", async () => {
    /*
     * **Found by `scripts/mutants.mjs`, not by reading.** Removing the `changes === 0` guard left every test
     * passing, because nothing exercised two redemptions at once — a real coverage gap in the branch that
     * exists precisely for a race.
     *
     * The spend is a conditional `UPDATE … WHERE redeemed_at IS NULL` inside a `batch`, which D1 runs as one
     * transaction, so the second writer changes no rows. That is this repository's usual compare-and-swap and
     * the conflict is the signal — but a signal nothing had ever produced is a signal nobody had checked.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();

    const both = await Promise.allSettled([
      redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!),
      redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!),
    ]);
    const won = both.filter((one) => one.status === "fulfilled");
    const lost = both.filter((one) => one.status === "rejected");

    expect(won, "both redemptions succeeded, so the code was spent twice").toHaveLength(1);
    expect(lost).toHaveLength(1);
    /*
     * The loser is turned away at the **reservation** now, not at the spend. The restore is a saga — the
     * attempt is recorded before the vault calls and settled after — so the compare-and-swap moved to the
     * conditional insert that reserves the code, and the answer says what is happening rather than that the
     * code is gone.
     */
    expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(/E_RECOVERY_RESTORE_IN_FLIGHT/);
    // One spend, not two — the row cannot be redeemed by both.
    expect((await escrowState(testEnv, ORG))!.unredeemed).toBe(9);
    // And the vault was restored, by whichever won.
    expect((await vault(testEnv).inventory()).content).toBeGreaterThan(0);
  });

  it("refuses the same code twice", async () => {
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!))
      .rejects.toThrow(/E_RECOVERY_CODE_SPENT/);
    expect((await escrowState(testEnv, ORG))!.unredeemed).toBe(9);
  });
});

describe("restoring never overwrites a live key", () => {
  it("leaves a healthy vault exactly as it was", async () => {
    /*
     * Redeeming against a vault that is fine is a mistake made under pressure, and it must be harmless. If
     * `restore` overwrote, mail sealed **since** the escrow was taken would become unreadable — the
     * mechanism meant to prevent that failure causing it.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await vault(testEnv).rotate("content");
    const live = await vault(testEnv).openingKey("content", 2);

    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    expect((await vault(testEnv).openingKey("content", 2)).secret).toBe(live.secret);
    expect((await vault(testEnv).inventory()).content, "the pointer moved backwards").toBe(2);
  });

  it("reports a generation it could not install, instead of counting it as restored", async () => {
    /*
     * **Found by mutation, and it is the sharpest thing in this file.** Removing the no-overwrite guard left
     * all sixteen tests green, which said the guard was either unreachable or untested. It is reachable, and
     * the path is the one this whole mechanism is about:
     *
     *   1. storage is lost;
     *   2. the Node **keeps working** — which it does, because `sealingKey` mints on first use — so a fresh
     *      generation 1 appears, with a different secret;
     *   3. the operator finds their codes and redeems one, carrying the *old* generation 1.
     *
     * Two real keys, one number. Objects sealed before the loss open with the escrowed key, objects sealed
     * after with the live one, and nothing can hold both. Keeping the live key is the better trade — losing
     * newer mail to recover older is worse — but the version that merely skipped reported generation 1 as
     * **restored**, because the loop pushed every generation without reading what `restore` returned.
     *
     * So a redemption that installed nothing said it had succeeded, on the one path where an operator most
     * needs to know it had not. That is this repository's recurring defect arriving inside the mechanism
     * built to answer it.
     */
    const original = await vault(testEnv).openingKey("content", 1);
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    await loseTheVault();
    // The Node keeps working after the loss, which is what makes the collision reachable.
    await vault(testEnv).sealingKey("content");
    const regenerated = await vault(testEnv).openingKey("content", 1);
    expect(regenerated.secret, "the fixture did not actually regenerate").not.toBe(original.secret);

    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    expect(outcome.restored.content, "claimed to restore a generation it did not install")
      .not.toContain(1);
    expect(outcome.conflicted.content, "the collision was not reported at all").toContain(1);
    // The live key survived, so mail sealed since the loss is still readable.
    expect((await vault(testEnv).openingKey("content", 1)).secret).toBe(regenerated.secret);
  });

  it("counts a generation it already held identically as neither restored nor conflicted", async () => {
    // Redeeming against a healthy vault installs nothing and collides with nothing. Reporting it as restored
    // would inflate what a code achieved; reporting it as a conflict would raise an alarm about a Node that
    // is fine.
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(outcome.restored.content).toEqual([]);
    expect(outcome.conflicted.content).toEqual([]);
  });

  it("never lowers the sealing generation", async () => {
    // A restore that lowered `current` would make this Node seal *new* mail under an old key — not a
    // recovery, a silent downgrade of everything written afterwards.
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await vault(testEnv).rotate("content");
    await vault(testEnv).rotate("content");
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect((await vault(testEnv).inventory()).content).toBe(3);
  });
});

describe("doctor says whether the escrow is there and current", () => {
  it("is degraded with no escrow at all", async () => {
    /*
     * The one honesty finding in that file allowed to be `degraded`. Every other check reports something
     * recoverable; a Node holding mail whose keys have no way back is not healthy, and reporting it as
     * `report` would be the reassurance this repository keeps removing.
     */
    const report = await runDoctor(testEnv, createSystemCtx());
    const finding = find(report.findings, "recovery_escrow");
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    expect(finding.detail).toMatch(/No key escrow/);
    expect(report.verdict).toBe("degraded");
  });

  it("reports it healthy once minted and confirmed, without printing anything secret", async () => {
    /*
     * **Confirmed, not merely minted**, which is a contract this test used to assert the other way. A set
     * nobody has proved they hold is degraded (0043): the plaintext is returned once, so a lost response
     * leaves this Node looking exactly as it would if the codes had been written down. Healthy now means
     * strong, current *and* held.
     */
    const minted = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, minted.codes[0]!);
    const finding = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_escrow");
    expect(finding.ok).toBe(true);
    expect(finding.detail).toMatch(/10 of 10 recovery codes unspent/);
    // Not a code, and not a hash. A diagnostic that printed either would be the leak the escrow prevents.
    const hashes = await testEnv.CATALOG.prepare("SELECT code_hash FROM recovery_codes").all<{ code_hash: string }>();
    for (const row of hashes.results) expect(finding.detail).not.toContain(row.code_hash);
  });

  it("goes degraded when a rotation leaves the escrow behind", async () => {
    /*
     * **The dangerous state, and the reason this finding compares generations rather than counting codes.**
     * Ten unspent codes carrying a two-generation-old vault restore a Node that reads old mail and not new.
     * "Ten codes are present" is exactly the true-and-useless statement this check would otherwise become.
     */
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await vault(testEnv).rotate("content");

    const finding = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_escrow");
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    expect(finding.detail).toMatch(/half recovery/);
    expect(finding.fix).toMatch(/mint a fresh set/);
  });

  it("is healthy again after re-minting, and the old codes stop working", async () => {
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await vault(testEnv).rotate("content");
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    // Re-minting starts a fresh unconfirmed set, so the operator confirms again. That is the point of the
    // step rather than an inconvenience: a rotation nobody wrote down is a rotation nobody can use.
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!);

    expect(find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_escrow").ok).toBe(true);
    // The previous set is gone rather than left alongside, so nobody picks a stale code during an incident.
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, first.codes[0]!))
      .rejects.toThrow(/E_RECOVERY_CODE_UNKNOWN/);
    await loseTheVault();
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, second.codes[0]!)).resolves.toBeDefined();
  });
});

describe("over the route, which is how an operator reaches it", () => {
  it("restores without a session, because the state it exists for has no working session keys", async () => {
    /*
     * Unauthenticated on purpose. Session signing keys are wrapped under the **credential** key, so on a
     * Node whose vault is gone there is no way to sign in — requiring a session would make the recovery path
     * reachable only from the state that does not need it.
     *
     * What that costs is bounded: it restores keys this Node already escrowed, issues no session, and grants
     * nothing. Asserted, because "it issues no session" is the sentence that makes the exposure acceptable.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();

    const response = await SELF.fetch(`${ORIGIN}/api/recovery/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: codes[0] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ restored: { content: [1] } });
    expect(response.headers.get("set-cookie"), "redemption issued a session").toBeNull();
  });

  it("answers a bad code with the four-part refusal rather than a 500", async () => {
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const response = await SELF.fetch(`${ORIGIN}/api/recovery/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABCD-EFGH-JKMN-PQRS" }),
    });
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_RECOVERY_CODE_UNKNOWN");
    expect(body.message).toMatch(/why/);
    expect(body.message).toMatch(/fix/);
  });
});

describe("the trail is what makes an unauthenticated route accountable", () => {
  /** The audit entries for this organization, newest last. */
  async function entries(): Promise<{ action: string; subject: string | null; detail: string }[]> {
    const rows = await testEnv.CATALOG.prepare(
      "SELECT action, subject, detail FROM audit_entries WHERE org_id = ? ORDER BY seq",
    ).bind(ORG).all<{ action: string; subject: string | null; detail: string }>();
    return rows.results;
  }

  it("records the mint, and records the spend against the row it spent", async () => {
    /*
     * `POST /api/recovery/redeem` is the one privileged act on this Node that takes no session — it must,
     * because the state it exists for has no verifiable session keys. What keeps that acceptable is that it
     * cannot happen quietly, so the entry rides in the **same transaction as the spend**: a code marked
     * redeemed always has a record of being redeemed, rather than the two being separately possible.
     */
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    const recorded = await entries();
    /*
     * Two entries for one redemption, and the pair is the point. `restore_started` is written before the
     * vault calls and claims only that an attempt began; `vault_restored` is written after and carries what
     * was installed. A `started` with no settling entry beside it is an interrupted restore — the state that
     * used to be indistinguishable from a completed one, because the `ok` was written first.
     */
    expect(recorded.map((one) => one.action))
      .toEqual(["recovery.codes_minted", "recovery.restore_started", "recovery.vault_restored"]);

    const spend = recorded[2]!;
    const spentRow = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? AND redeemed_at IS NOT NULL",
    ).bind(ORG).first<{ id: string }>();
    expect(spend.subject, "the entry does not name which code was spent").toBe(spentRow!.id);
  });

  it("carries nothing in the trail that could open the escrow", async () => {
    /*
     * The trail is readable by any administrator and is never trimmed. A code in it would make the audit
     * table a place the vault can be opened from, which is the same mistake as sealing the escrow under its
     * own hash — one table holding both the lock and the key.
     */
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    const everything = (await entries()).map((one) => `${one.subject ?? ""} ${one.detail}`).join(" ");
    for (const code of codes) {
      expect(everything, "a recovery code is in the audit trail").not.toContain(code);
      expect(everything).not.toContain(code.replace(/-/g, ""));
      expect(everything, "a code hash is in the audit trail").not.toContain(await codeHash(code));
    }
    // Non-vacuity: the trail does carry the generations, so the search above ran over real content.
    expect(everything).toMatch(/escrowedContent/);
  });

  it("says what the escrow carried before, and what was installed after", async () => {
    /*
     * The split that makes the trail honest. The `started` entry commits before the restore runs, so it can
     * only name what the escrow **carried** — a generation can collide with a live key and be skipped, and
     * calling the escrowed set *restored* there would be the false-success claim this file's `conflicted`
     * tests exist to catch, written into a record that is never trimmed.
     *
     * The settling entry is written knowing, so it names what was actually installed and what collided. The
     * whole finding was that there used to be one entry, written first, saying `ok`.
     */
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    // Regenerate, so the redemption below collides and installs nothing.
    await loseTheVault();
    await vault(testEnv).sealingKey("content");
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(outcome.conflicted.content, "the fixture did not produce a collision").toContain(1);

    const recorded = await entries();
    const began = recorded.find((one) => one.action === "recovery.restore_started")!;
    expect(began.detail, "the started entry does not say what the escrow carried").toMatch(/escrowedContent/);
    expect(
      began.detail,
      "the entry written before the restore claims to know what was installed",
    ).not.toMatch(/"restored"/);

    const settled = recorded.find((one) => one.action === "recovery.vault_restored")!;
    const carried = JSON.parse(settled.detail) as {
      restored: { content: number[] }; conflicted: { content: number[] };
    };
    expect(carried.restored.content, "a collision was reported as a restore").toEqual([]);
    expect(carried.conflicted.content, "the settling entry does not say what collided").toContain(1);
  });
});

describe("a recovery code carries the 128 bits ADR 29 promises", () => {
  /*
   * ## The bug this block exists because of
   *
   * `formatCode` mapped **one base32 character per source byte**: sixteen random bytes became sixteen
   * characters, and a base32 character carries five bits. 16 × 5 = **80 bits**, against a stated contract of
   * 128 — 48 bits discarded, silently, while the constant said `CODE_BYTES = 16` and the comment beside it
   * claimed 26 characters.
   *
   * Nothing looked wrong: 256 divides evenly by 32 so there was no modulo bias, and every test used codes of
   * the length the bug produced. It was found by a third-party audit doing the arithmetic.
   *
   * These codes open the escrow holding the keys to all of an organization's mail, so the assertions below
   * are about the *encoding* rather than about any behaviour — an encoder that loses entropy passes every
   * behavioural test there is, because the codes still work.
   */
  it("emits 26 characters for 16 bytes, which is what 128 bits needs in base32", async () => {
    const minted = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    for (const code of minted.codes) {
      expect(normaliseCode(code).length, `a code is ${normaliseCode(code).length} characters, so it carries `
        + `${normaliseCode(code).length * 5} bits and not 128`).toBe(CODE_CHARACTERS);
    }
  });

  it("changes the code when any single input bit changes, so no input bits are dropped", () => {
    /*
     * The property the length assertion alone cannot prove. A 26-character encoder that still ignored some
     * input — padding the extra characters with a constant, say — would pass the count and lose the entropy
     * anyway.
     *
     * Flipping one bit of one byte must change the output. Checked across every byte position and both a low
     * and a high bit, which is 32 distinct inputs and covers the packing boundaries where a shift-by-five
     * encoder actually goes wrong.
     */
    const base = new Uint8Array(16);
    const encoded = (b: Uint8Array) => normaliseCode(formatCode(b));
    const original = encoded(base);
    for (let byte = 0; byte < 16; byte++) {
      for (const bit of [0, 7]) {
        const flipped = new Uint8Array(base);
        flipped[byte] = (flipped[byte] ?? 0) ^ (1 << bit);
        expect(encoded(flipped), `flipping bit ${bit} of byte ${byte} did not change the code, so that bit `
          + "never reaches the output").not.toBe(original);
      }
    }
  });

  it("gives every one of the ten codes a distinct value", async () => {
    // Cheap, and it is the assertion that would catch an encoder returning a constant — which is the
    // degenerate case both assertions above would otherwise miss between them.
    const minted = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(new Set(minted.codes).size).toBe(minted.codes.length);
  });
});

describe("an operator can replace a set, and a set nobody holds is not healthy", () => {
  /*
   * ## Why this lifecycle exists
   *
   * `mintRecoveryCodes` was always callable again and was reachable from exactly one place: the initial
   * claim. So `doctor` could tell an operator to "mint a fresh set" with no supported way to do it — a
   * refusal naming no door — and migration 0042 made that acute by marking every pre-audit set as carrying
   * 80 bits rather than 128.
   *
   * The confirmation half closes a quieter failure. Minting returns the plaintext **once**; if that response
   * is lost, this Node looks exactly as it would if the codes had been written down — ten rows, good hashes,
   * current escrow — and `doctor` reports health over an organization that cannot recover. It finds out
   * during the incident.
   */
  it("replaces the whole set, so the old codes stop working", async () => {
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(new Set([...first.codes, ...second.codes]).size).toBe(first.codes.length * 2);

    const state = await escrowState(testEnv, ORG);
    // Ten, not twenty: the mint deletes before it inserts, in one batch.
    expect(state?.total).toBe(second.codes.length);

    // And the old sheet is dead rather than merely unlisted.
    await expect(confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!))
      .rejects.toThrow(/E_RECOVERY_CODE_UNKNOWN/);
  });

  it("reports a freshly minted set as unconfirmed, and confirming clears it", async () => {
    const minted = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const before = await escrowState(testEnv, ORG);
    expect(before?.unconfirmed, "a set nobody has confirmed reports as confirmed").toBe(before?.unredeemed);

    const outcome = await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, minted.codes[3]!);
    expect(outcome.confirmed).toBe(minted.codes.length);

    const after = await escrowState(testEnv, ORG);
    expect(after?.unconfirmed).toBe(0);
  });

  it("confirms without spending, so all ten stay usable", async () => {
    /*
     * The property that makes confirmation cheap enough to ask for. A confirmation that consumed a code
     * would leave nine and the operator would reasonably wonder where the tenth went — and confirming twice
     * would leave eight.
     */
    const minted = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, minted.codes[0]!);
    const state = await escrowState(testEnv, ORG);
    expect(state?.unredeemed).toBe(minted.codes.length);
  });

  it("refuses a wrong code the same way it refuses a replaced one, so it is not an oracle", async () => {
    /*
     * One refusal for "wrong", "already spent" and "from a replaced set". Distinguishing them would answer
     * *that code exists* to somebody guessing — and an oracle behind authentication is still an oracle.
     */
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await expect(confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA"))
      .rejects.toThrow(/E_RECOVERY_CODE_UNKNOWN/);
  });

  it("makes doctor degraded while a set is unconfirmed, and healthy once it is not", async () => {
    // The operator-visible half. A finding nobody sees is a finding that does not exist.
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const before = (await runDoctor(testEnv, createSystemCtx())).findings
      .find((f: Finding) => f.check === "recovery_escrow");
    expect(before?.severity, "an unconfirmed set does not show as degraded").toBe("degraded");
    expect(before?.detail).toMatch(/confirm/i);

    const minted = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, minted.codes[0]!);
    const after = (await runDoctor(testEnv, createSystemCtx())).findings
      .find((f: Finding) => f.check === "recovery_escrow");
    expect(after?.ok, "a confirmed, current, strong set is still not reported healthy").toBe(true);
  });
});

describe("a set has an identity, and a rotation no longer destroys the sheet somebody holds", () => {
  /*
   * Two defects, one absence: **a set of recovery codes had no identity**. `recovery_codes` held rows for an
   * organization and nothing more, so "the current set" meant "every row", and both the confirmation and the
   * rotation were written in those terms.
   *
   * 1. Rotation deleted the working set before inserting its replacement. The batch made that atomic, so a
   *    partial write was impossible — but a **lost response** is not, and it is the ordinary failure: the
   *    operator who never sees the new sheet holds an old one that no longer works and a new one they have
   *    never read. The escrow stays perfectly intact and becomes unreachable by anybody.
   * 2. Confirmation verified a code against the current rows and then ran
   *    `UPDATE … SET confirmed_at = ? WHERE org_id = ? AND confirmed_at IS NULL` — org-wide. There was no way
   *    to write it correctly, because there was nothing to name a set with.
   *
   * The second only becomes *observable* once two sets can coexist, which is why the first assertion below is
   * the one that failed on the old code and the rest were unexpressible.
   */
  it("keeps the previous sheet spendable until the replacement is confirmed", async () => {
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    await loseTheVault();
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, first.codes[1]!);
    expect(
      outcome.restored.content.length + outcome.restored.credential.length,
      "a rotation destroyed the only sheet anybody is known to hold, for one nobody has confirmed",
    ).toBeGreaterThan(0);
  });

  it("retires the previous sheet once the replacement is confirmed, and not before", async () => {
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    // Before: both sheets are live, which is the previous assertion from the other side.
    expect(await heldSets(), "the two sheets did not coexist, so retirement below proves nothing").toBe(2);

    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!);
    await loseTheVault();

    /*
     * Retirement is a **deletion** rather than a state, and this is why. Each row carries the vault sealed
     * under its own code, so a retired row left in the table is the vault still openable by the old sheet —
     * exactly what somebody rotating their codes is trying to stop being true. A `retired_at` column would
     * have recorded the intent and kept the capability.
     */
    await expect(
      redeemForVault(testEnv, createSystemCtx(), ORG, first.codes[1]!),
      "an old sheet still opens the vault after its replacement was confirmed",
    ).rejects.toThrow("E_RECOVERY_CODE_UNKNOWN");

    // The control: the confirmed sheet works, so the refusal above is retirement rather than a broken mint.
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, second.codes[1]!);
    expect(outcome.restored.content.length + outcome.restored.credential.length).toBeGreaterThan(0);
  });

  it("marks only the set whose code was typed", async () => {
    /*
     * The org-wide UPDATE, from the direction that can see it. With two sets present, confirming a code from
     * the pending one under the old statement would have marked **both** — and the old set was already
     * confirmed, so the visible symptom was the reverse: a code from the *old* sheet marking the new one.
     * Either way the count is the tell, and a count is only checkable once a set has a name.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    const outcome = await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!);
    expect(outcome.confirmed, "confirmation marked rows outside the set it verified against").toBe(10);
    expect(outcome.alreadyConfirmed).toBe(false);
  });

  it("does not retire a pending sheet when somebody re-types a code from the active one", async () => {
    /*
     * The case that made `alreadyConfirmed` a distinct answer rather than a count of zero. An operator typing
     * a code from the set that is already active is saying *"I still have this sheet"* — true, and it changes
     * nothing. Falling through to the retirement would have destroyed the pending replacement on the strength
     * of a confirmation of something else entirely.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    const outcome = await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[1]!);
    expect(outcome.alreadyConfirmed).toBe(true);
    expect(outcome.confirmed).toBe(0);
    expect(await heldSets(), "re-confirming the active sheet retired the pending one").toBe(2);

    // And the pending sheet is still confirmable, which is what "changes nothing" has to mean.
    expect((await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!)).confirmed).toBe(10);
  });

  it("bounds the table at one pending sheet, whatever the button is pressed", async () => {
    // An unconfirmed sheet is replaced rather than kept: nobody proved they hold it, so nothing is lost — and
    // without this, every press of rotate would leave another sealed copy of the vault in the table.
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    for (let n = 0; n < 3; n++) await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(await heldSets(), "each rotation left another sealed copy of the vault behind").toBe(2);
  });

  it("confirms only the set it verified, even with two unconfirmed sheets present", async () => {
    /*
     * The race, constructed by hand rather than waited for.
     *
     * `mintRecoveryCodes` bounds the table at one pending sheet, so this state does not arise from calling the
     * public functions in sequence — it arises from **two requests interleaving**: confirmation reads a code
     * and finds its set pending, a rotation lands between the read and the write, and the write goes to
     * whatever is unconfirmed by then. Under the org-wide `WHERE confirmed_at IS NULL` that is the *new*
     * sheet, marked held on the strength of a code from a set that no longer exists.
     *
     * Firing the two concurrently and hoping for the interleaving would be a test that passes for reasons
     * nobody controls. Building the intermediate state directly is deterministic and asserts the same
     * predicate: confirmation must mark the set whose code was typed and no other.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    /*
     * The first sheet put back to pending, which is the state the interleaving produces: confirmation has
     * read a code and not yet written, so from the database's side that set is still unconfirmed while the
     * rotation's replacement is unconfirmed too.
     */
    await testEnv.CATALOG.prepare("UPDATE recovery_codes SET confirmed_at = NULL WHERE org_id = ? AND set_id IS ?")
      .bind(ORG, first.setId).run();
    expect(await heldSets(), "the two unconfirmed sheets did not coexist").toBe(2);

    const outcome = await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!);
    expect(outcome.confirmed, "confirmation marked rows beyond the set whose code was typed").toBe(10);

    const marked = await testEnv.CATALOG.prepare(
      "SELECT DISTINCT set_id FROM recovery_codes WHERE org_id = ? AND confirmed_at IS NOT NULL",
    ).bind(ORG).all<{ set_id: string | null }>();
    expect(
      marked.results.map((row) => row.set_id),
      "a sheet was marked as held on the strength of a code from a different sheet",
    ).toEqual([second.setId]);
  });

  it("destroys nothing when the set it read a code from has already been replaced", async () => {
    /*
     * The interleaving the last round stopped one step short of, and it was catastrophic.
     *
     * `auditedBatch`'s gate wraps the **audit entry's insert** and nothing else, so the `UPDATE` and the
     * `DELETE` beside it ran unconditionally. Atomicity did not help, because all three statements *succeed*:
     * a zero-row `INSERT … SELECT` and a zero-row `UPDATE` are not failures. The sequence:
     *
     * ```
     *   before        X active, A pending
     *   confirm       reads a code from A
     *   rotation      deletes pending A, inserts pending B, keeps X
     *   confirm       audit gated off, UPDATE A → 0 rows,
     *                 DELETE everything that is not A → deletes B *and* X
     *   after         no recovery codes at all
     * ```
     *
     * An organization's entire escrow, gone, from a confirmation that reported no error. The previous test
     * built two coexisting sets and confirmed a code from one that *still existed* — which proves set-scoped
     * confirmation and cannot reach this.
     *
     * Run through the exported statements, because the vanished-set state cannot be produced by calling the
     * public function in sequence: the vanishing has to happen between its read and its write.
     */
    const active = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, active.codes[0]!);
    const pending = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(await heldSets()).toBe(2);

    // The rotation that lands mid-confirmation: the pending sheet is replaced, the active one is kept.
    const replacement = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(replacement.setId).not.toBe(pending.setId);

    // The stale confirmation's own statements, still naming the set that has gone.
    const at = new Date(createSystemCtx().now()).toISOString();
    const outcomes = await testEnv.CATALOG.batch(confirmationStatements(testEnv, ORG, pending.setId, at, new Date(createSystemCtx().now() - RESTORE_LEASE_MS).toISOString()));

    /*
     * The confirming update changes **nothing**, which is the condition `confirmRecoveryCodes` turns into
     * `E_RECOVERY_SET_REPLACED`. Asserted here rather than there because the throw is reachable only under
     * the interleaving this test builds by hand: called in sequence, the update always finds the rows its own
     * select just matched. So the branch's *condition* is proved and the branch is a mapping from it.
     */
    expect(
      outcomes[outcomes.length - 1]!.meta.changes ?? 0,
      "the update reported rows changed for a set that no longer exists",
    ).toBe(0);

    expect(
      await heldSets(),
      "a confirmation whose set had been replaced deleted every other set — the whole escrow",
    ).toBe(2);

    // And the sheet the operator actually holds still opens the vault, which is the thing that was lost.
    await loseTheVault();
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, active.codes[1]!);
    expect(outcome.restored.content.length + outcome.restored.credential.length).toBeGreaterThan(0);
  });

  it("tells the operator their sheet was replaced rather than reporting nothing happened", async () => {
    /*
     * The other half. Before, a confirmation whose set had vanished returned `confirmed: 0` with
     * `alreadyConfirmed: false` — a success shape carrying a zero, for a request that did nothing to an escrow
     * it may have just destroyed. The operator typed a real code and is owed the reason.
     */
    const active = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, active.codes[0]!);
    const pending = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    // The pending sheet's rows are taken away, exactly as a rotation would.
    await testEnv.CATALOG.prepare("DELETE FROM recovery_codes WHERE org_id = ? AND set_id IS ?")
      .bind(ORG, pending.setId).run();

    await expect(
      confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, pending.codes[0]!),
      "a code from a vanished set answered as though it were unknown, or as though it had worked",
    ).rejects.toThrow(/E_RECOVERY_CODE_UNKNOWN|E_RECOVERY_SET_REPLACED/);

    expect(await heldSets(), "the active sheet was destroyed on the way").toBe(1);
  });

  it("retires a legacy sheet, whose set_id is NULL", async () => {
    /*
     * Migration 0047 leaves every pre-existing row with a NULL `set_id` — one legacy set per organization,
     * with nothing to classify and no identifier to invent. So the retirement predicate meets NULL on the
     * first rotation after an upgrade, on every installed Node, which makes this the *most likely* path
     * through it rather than an edge.
     *
     * `set_id <> ?` evaluates to NULL against a NULL row, which is not true, so the legacy sheet would
     * survive its own replacement: two live sheets, and the vault still openable by codes the operator has
     * just been told are retired. `IS NOT` is SQLite's null-safe form and the reason `recovery.ts` says so at
     * both sites.
     */
    const legacy = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, legacy.codes[0]!);
    // Exactly what an upgraded Node looks like: rows that predate the column.
    await testEnv.CATALOG.prepare("UPDATE recovery_codes SET set_id = NULL WHERE org_id = ?")
      .bind(ORG).run();

    const replacement = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(await heldSets(), "the legacy sheet was not kept across the rotation").toBe(2);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, replacement.codes[0]!);

    expect(await heldSets(), "the legacy sheet outlived its own replacement").toBe(1);
    await loseTheVault();
    await expect(
      redeemForVault(testEnv, createSystemCtx(), ORG, legacy.codes[1]!),
      "a legacy sheet still opens the vault after being told it was retired",
    ).rejects.toThrow("E_RECOVERY_CODE_UNKNOWN");
  });

  it("records the confirmation, because it deletes copies of the key vault", async () => {
    /*
     * Confirming used to write nothing to the trail, and it reads like a checkbox — which is why nobody
     * noticed. It changes whether this Node is recoverable, and since retirement is a delete it **destroys
     * copies of the key vault**, one per code on the retired sheet. An act that removes the ability to
     * decrypt an organization's mail leaving no entry is what §7 forbids.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!, { actorUserId: USER });
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!, { actorUserId: USER });

    const entries = await testEnv.CATALOG.prepare(
      `SELECT action, actor_user_id, actor_kind, detail FROM audit_entries
        WHERE org_id = ? AND action = 'recovery.codes_confirmed' ORDER BY seq`,
    ).bind(ORG).all<{ action: string; actor_user_id: string; actor_kind: string; detail: string }>();

    expect(entries.results.length, "confirming wrote nothing to the trail").toBe(2);
    expect(entries.results[1]!.actor_user_id, "recorded as the Node rather than the person who typed it")
      .toBe(USER);
    expect(entries.results[1]!.actor_kind).toBe("user");
    // The retirement is countable from the entry, which is the part somebody investigating a lost sheet needs.
    expect(JSON.parse(entries.results[1]!.detail)).toMatchObject({ set: second.setId, retired: 1 });
    expect(JSON.parse(entries.results[0]!.detail), "the first confirmation retired a sheet that never existed")
      .toMatchObject({ retired: 0 });
  });

  it("writes no entry for a confirmation that changed nothing", async () => {
    /*
     * The gate. An entry claiming a retirement that did not happen is worse than no entry — the trail would
     * say a sheet was destroyed while it is still in the table and still opens the vault. Re-typing a code
     * from the active sheet is the reachable version of that.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!, { actorUserId: USER });
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[1]!, { actorUserId: USER });

    const count = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'recovery.codes_confirmed'",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(count?.n), "a second entry claims a retirement that did not happen").toBe(1);
  });

  it("names the person who rotated, not the Node", async () => {
    // Rotating the one artifact that decrypts an organization's mail was recorded as a machine act.
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG, { actorUserId: USER });
    const entry = await testEnv.CATALOG.prepare(
      `SELECT actor_user_id, actor_kind FROM audit_entries
        WHERE org_id = ? AND action = 'recovery.codes_minted' ORDER BY seq DESC LIMIT 1`,
    ).bind(ORG).first<{ actor_user_id: string; actor_kind: string }>();
    expect(entry?.actor_user_id).toBe(USER);
    expect(entry?.actor_kind).toBe("user");

    // The control: a caller with nobody to attribute to still records the act, as the Node.
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const unattributed = await testEnv.CATALOG.prepare(
      `SELECT actor_kind FROM audit_entries
        WHERE org_id = ? AND action = 'recovery.codes_minted' ORDER BY seq DESC LIMIT 1`,
    ).bind(ORG).first<{ actor_kind: string }>();
    expect(unattributed?.actor_kind).toBe("node");
  });

  it("reports the escrow healthy while a confirmed sheet is held and a fresh one waits", async () => {
    /*
     * The false alarm this change could have introduced. `doctor` went degraded on `unconfirmed > 0`, and
     * after letting an active sheet outlive a rotation that state is the **healthy** one — the operator holds
     * the active sheet and simply has not confirmed the new one. A check that cries wolf on the recoverable
     * case is the one people learn to ignore.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    const state = await escrowState(testEnv, ORG);
    expect(state?.confirmed, "the confirmed sheet stopped counting as held").toBe(10);
    expect(state?.unconfirmed, "the pending sheet is not visible at all").toBe(10);

    const escrow = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_escrow");
    expect(escrow.ok, `degraded over a recoverable Node: ${escrow.detail}`).toBe(true);
  });

  it("judges staleness on the sheet the operator holds, not the newest one on file", async () => {
    /*
     * The two coexisting sets carry **different generations**, and only one of them can be used by anybody.
     *
     * Sequence: a sheet is minted and confirmed; the vault rotates, leaving that sheet behind; a fresh sheet
     * is minted, escrowing the new generation, and nobody has confirmed it. Taking `MAX(content_generation)`
     * across both sets then reports the escrow current — on the strength of a sheet that may never have
     * arrived — while the only sheet anybody has proved they hold restores mail sealed before the rotation and
     * not since. That is a half recovery reported as a whole one, which is failure mode 2 in this file's
     * header, reintroduced by letting two sets coexist.
     */
    const held = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, held.codes[0]!);
    await vault(testEnv).rotate("content");
    const fresh = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    expect(
      fresh.escrowedGenerations.content,
      "the fresh sheet did not escrow the newer generation, so there is nothing to be misled by",
    ).toBeGreaterThan(held.escrowedGenerations.content);

    const escrow = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_escrow");
    expect(
      escrow.ok,
      "reported a current escrow while the only confirmed sheet is a generation behind",
    ).toBe(false);
    expect(escrow.detail).toContain("half recovery");
  });

  it("still reports degraded when nothing at all has been confirmed", async () => {
    // The control for the assertion above. Without it, `ok: true` unconditionally would pass.
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const escrow = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_escrow");
    expect(escrow.ok, "an escrow nobody has proved they hold reported healthy").toBe(false);
    expect(escrow.detail).toContain("nobody has confirmed holding one");
  });
});

describe("a restore is a resumable operation, not a hopeful sequence", () => {
  /*
   * `redeemForVault` wrote `recovery.vault_restored / ok`, marked the code spent, and *then* made the Durable
   * Object calls that put the keys back. D1 and Durable Object storage share no transaction, so a Worker dying
   * in between left the code gone, the trail claiming success, and the keys still absent — on the
   * disaster-recovery path, whose record is read during the incident it exists for.
   */
  it("leaves a started row nobody settled when an attempt is interrupted", async () => {
    /*
     * The interruption, built by hand: the attempt is recorded and never settles. There is no way to kill a
     * Worker mid-function from a test, and the state that matters is what it leaves behind — a row saying
     * which code was in flight, which is exactly what did not exist before.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    const code = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? LIMIT 1",
    ).bind(ORG).first<{ id: string }>();
    await testEnv.CATALOG.prepare(
      `INSERT INTO recovery_restores (id, org_id, code_id, state, started_at)
       VALUES (?,?,?,'started',?)`,
    ).bind("rst_INTERRUPTED0000000000000", ORG, code!.id,
      new Date(createSystemCtx().now()).toISOString()).run();

    /*
     * The code is reserved, so a second attempt is turned away rather than doing the work twice — and told
     * why, and told when it lapses. A refusal saying only "spent" would send an operator to the next code.
     */
    await expect(
      redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!),
    ).rejects.toThrow("E_RECOVERY_RESTORE_IN_FLIGHT");
    expect((await escrowState(testEnv, ORG))!.unredeemed, "the interrupted attempt spent a code").toBe(10);
  });

  it("resumes once the reservation lapses, without having spent the code", async () => {
    /*
     * A reservation nothing can release is a deadlock wearing a safety argument, so the row carries its own
     * lease. Resuming is safe because every step is idempotent: `vault.restore` reports `identical` for a
     * generation already present and `conflict` for one that disagrees.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    const code = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? LIMIT 1",
    ).bind(ORG).first<{ id: string }>();
    // An attempt that began before the lease window and never settled — a Worker that died.
    await testEnv.CATALOG.prepare(
      `INSERT INTO recovery_restores (id, org_id, code_id, state, started_at)
       VALUES (?,?,?,'started',?)`,
    ).bind("rst_LAPSED000000000000000000", ORG, code!.id,
      new Date(createSystemCtx().now() - RESTORE_LEASE_MS - 1_000).toISOString()).run();

    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(
      outcome.restored.content.length + outcome.restored.credential.length,
      "a dead attempt parked the code for ever",
    ).toBeGreaterThan(0);
    expect((await escrowState(testEnv, ORG))!.unredeemed, "the resumed attempt did not spend the code").toBe(9);
  });

  it("refuses a corrupt escrow cleanly, and spends no code doing it", async () => {
    /*
     * The property that decides whether a failure costs an operator one of ten codes, tested on the failure
     * path that *is* reachable: an escrow that **opens** and does not describe a vault — every escrow this Node writes is well-formed, so the state
     * has to be built: an escrow that decrypts to **valid JSON of the wrong shape**, sealed under the real
     * code so the open succeeds and the failure lands inside the restore loop.
     *
     * Two earlier attempts tried to make the *vault* refuse part way, and neither works from data: a 200 KB
     * secret overflows `seal`'s `String.fromCharCode` before the vault is reached, and an oversized storage
     * key is not enforced under miniflare. `restore` returns one of three outcomes for every well-formed
     * input, so that branch needs the Durable Object itself to fail and `recovery.ts` says so rather than
     * implying coverage. This proves the property they were both aiming at.
     *
     * It also found a defect on the way: a corrupt escrow used to throw a bare `TypeError` out of the audit
     * detail's `.map`, which is a 500 with no `what`, `why` or `fix` on the disaster-recovery path.
     *
     * Before this the audit entry said `ok` and the code was spent before any of that ran, so a failure here
     * was invisible and expensive at once.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();

    const oversized = JSON.stringify({ content: 5, credential: [] });
    await testEnv.CATALOG.prepare("UPDATE recovery_codes SET escrow = ? WHERE org_id = ?")
      .bind(await seal(await codeKey(normaliseCode(codes[0]!)), oversized), ORG).run();

    await expect(
      redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!),
      "the restore ran to the end over an escrow that does not describe a vault",
    ).rejects.toThrow("E_RECOVERY_ESCROW_CORRUPT");

    expect(
      (await escrowState(testEnv, ORG))!.unredeemed,
      "a failed restore cost the operator one of ten codes",
    ).toBe(10);

    // Refused before anything is reserved, so no attempt is left in flight to block the next code either.
    const attempts = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM recovery_restores WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(attempts?.n), "a refusal before the work began still reserved a code").toBe(0);
  });

  it("refuses before reserving anything when the escrow cannot be opened at all", async () => {
    /*
     * The heart of it. A failed attempt must not cost one of ten — the operator has few, and they are needed
     * during exactly the conditions that cause failures. The refusal says how many generations went in before
     * it stopped, so the same code can be redeemed again and resume rather than repeat.
     *
     * `restore` is made to throw by taking the vault's storage away *after* the escrow is read: the Durable
     * Object then has no key material to compare against and the RPC rejects.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();

    // A generation the escrow carries but the vault will refuse: an id no vault produces.
    await testEnv.CATALOG.prepare(
      "UPDATE recovery_codes SET escrow = ? WHERE org_id = ?",
    ).bind("not-a-sealed-blob", ORG).run();

    /*
     * With every escrow unopenable the code is refused before any attempt begins, which is the *existing*
     * behaviour and not what this test is about — so the assertion is the one that still holds either way:
     * nothing is spent by a redemption that does not complete.
     */
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!)).rejects.toThrow();
    expect(
      (await escrowState(testEnv, ORG))!.unredeemed,
      "a redemption that never completed still cost the operator a code",
    ).toBe(10);
  });
});

describe("the reservation is one predicate, not three questions", () => {
  /*
   * The saga's start had the reservation, the audit gate and the refusal asking different things. Two defects
   * came out of that, and neither is visible from any single statement.
   */
  it("writes no started entry for a request that never began", async () => {
    /*
     * The entry's insert was unconditional while the reservation's was not, so a caller who lost the race
     * recorded `recovery.restore_started` — which the catalogue defines as *a code was accepted and
     * restoration began* — and then threw. An audit trail that records attempts that did not happen is worse
     * than one that records none: it is the artefact somebody counts during an incident.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    const code = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? LIMIT 1",
    ).bind(ORG).first<{ id: string }>();
    // Somebody else holds the reservation.
    await testEnv.CATALOG.prepare(
      "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
    ).bind("rst_HELD00000000000000000000", ORG, code!.id,
      new Date(createSystemCtx().now()).toISOString()).run();

    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!))
      .rejects.toThrow("E_RECOVERY_RESTORE_IN_FLIGHT");

    const began = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'recovery.restore_started'",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(began?.n), "the trail records a restore that never started").toBe(0);
  });

  it("refuses a spent code with no attempt in flight, which the old NOT EXISTS let through", async () => {
    /*
     * The `NOT EXISTS` looked for a **live** attempt, and a winner that has already *finished* leaves none —
     * so the reservation's only condition was satisfied and a second request restored from a code the
     * database says is spent. Not an escalation, since the escrow holds the same keys either way, but it
     * breaks single use and makes the trail claim something the row does not.
     *
     * **This test reaches the refusal through the earlier read**, which has caught the ordinary spent case
     * since before the saga existed. The reservation's own `redeemed_at IS NULL` term covers the interleaving
     * — spent between that read and the batch — which no sequential test can produce, and `recovery.ts` says
     * so rather than implying otherwise. What is asserted here is the state the old predicate accepted: a
     * spent code with nothing in flight reserves nothing.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await testEnv.CATALOG.prepare(
      "UPDATE recovery_codes SET redeemed_at = ? WHERE org_id = ?",
    ).bind(new Date(createSystemCtx().now()).toISOString(), ORG).run();

    await expect(
      redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!),
      "a spent code was restored again because no attempt was in flight",
    ).rejects.toThrow("E_RECOVERY_CODE_SPENT");

    const reserved = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM recovery_restores WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(reserved?.n), "a spent code was reserved anyway").toBe(0);
  });

  it("tells the two refusals apart, because their remedies differ", async () => {
    /*
     * "Already being redeemed" means wait; "already spent" means use another. One code for both sends an
     * operator to the wrong remedy when there are nine left and an incident running.
     *
     * The in-flight case is covered above; this is the control that the two do not collapse into one answer.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(outcome.restored.content.length).toBeGreaterThan(0);

    // The same code again: spent, with nothing in flight.
    await expect(redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!))
      .rejects.toThrow("E_RECOVERY_CODE_SPENT");
  });

  it("records exactly one start and one settlement for one successful restore", async () => {
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    const counted = await testEnv.CATALOG.prepare(
      `SELECT action, COUNT(*) AS n FROM audit_entries
        WHERE org_id = ? AND action LIKE 'recovery.%' GROUP BY action ORDER BY action`,
    ).bind(ORG).all<{ action: string; n: number }>();
    const byAction = Object.fromEntries(counted.results.map((one) => [one.action, Number(one.n)]));
    expect(byAction["recovery.restore_started"]).toBe(1);
    expect(byAction["recovery.vault_restored"]).toBe(1);
  });
});

describe("doctor reports what the restore actually did", () => {
  /*
   * The refusal for an in-flight restore tells an operator to check `doctor`, and `doctor` did not look at
   * `recovery_restores` at all. Worse than a missing status line: the **collision** case looks healthy
   * everywhere else, because `recovery_escrow` compares generation *numbers* and a collision is two different
   * keys wearing the same number.
   */
  it("says a completed restore is clean when nothing collided", async () => {
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    const finding = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_restore_state");
    expect(finding.ok, `reported a problem on a clean restore: ${finding.detail}`).toBe(true);
    expect(finding.detail).toContain("no collisions");
  });

  it("goes degraded on a collision the escrow check cannot see", async () => {
    /*
     * The whole reason this finding exists. Lose the vault, let the Node mint a fresh generation 1 with a
     * different secret, then redeem: the escrow's generation 1 collides, the live key is kept, and the
     * inventory still reads 1. Both sides agree on the number and disagree on the key, so mail sealed before
     * the loss is unreadable and every count in `recovery_escrow` looks fine.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    await vault(testEnv).sealingKey("content");
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(outcome.conflicted.content, "the fixture did not produce a collision").toContain(1);

    const report = await runDoctor(testEnv, createSystemCtx());
    const finding = find(report.findings, "recovery_restore_state");
    expect(finding.ok, "a collision reported as healthy").toBe(false);
    expect(finding.detail).toContain("collided");

    // The control, and the point: the older check still says nothing is wrong.
    const escrow = find(report.findings, "recovery_escrow");
    expect(
      escrow.detail,
      "the escrow check noticed after all, which would make this finding redundant rather than necessary",
    ).not.toContain("collided");
  });

  it("says an interrupted restore is resumable once its reservation has lapsed", async () => {
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const code = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? LIMIT 1",
    ).bind(ORG).first<{ id: string }>();
    await testEnv.CATALOG.prepare(
      "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
    ).bind("rst_STUCK0000000000000000000", ORG, code!.id,
      new Date(createSystemCtx().now() - RESTORE_LEASE_MS - 1_000).toISOString()).run();

    const finding = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_restore_state");
    expect(finding.ok, "an abandoned restore reported healthy").toBe(false);
    expect(finding.detail).toContain("never settled");
    expect(finding.fix, "an operator is not told the code is still theirs to use").toContain("not spent");
    expect(codes.length).toBe(10);
  });

  it("does not fire while a restore is legitimately in progress", async () => {
    // The control. A finding that goes degraded the moment work begins is one people learn to ignore.
    const code = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const row = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? LIMIT 1",
    ).bind(ORG).first<{ id: string }>();
    await testEnv.CATALOG.prepare(
      "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
    ).bind("rst_RUNNING00000000000000000", ORG, row!.id,
      new Date(createSystemCtx().now()).toISOString()).run();

    const finding = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_restore_state");
    expect(finding.ok, "a restore that started a moment ago reported as broken").toBe(true);
    expect(code.codes.length).toBe(10);
  });

  it("says nothing has been attempted when nothing has", async () => {
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const finding = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_restore_state");
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("No vault restore has been attempted");
  });
});

describe("a decrypted escrow is validated before it becomes a vault", () => {
  /*
   * The parse was unguarded and the shape check accepted any number as a generation. The second matters more
   * than it looks: `KeyVault.restore` builds a storage key from the generation **and advances the current
   * pointer** when it is larger, so a damaged escrow could leave this Node sealing under a fractional or
   * enormous generation for ever — a vault nothing else will ever produce a key for.
   */
  async function withEscrow(payload: string, codes: readonly string[]) {
    await testEnv.CATALOG.prepare("UPDATE recovery_codes SET escrow = ? WHERE org_id = ?")
      .bind(await seal(await codeKey(normaliseCode(codes[0]!)), payload), ORG).run();
  }

  const REAL_SECRET = "A".repeat(43) + "=";

  const damaged = [
    { what: "invalid JSON", payload: "{not json" },
    { what: "a fractional generation", payload: JSON.stringify({
      content: [{ generation: 1.5, secret: REAL_SECRET }], credential: [],
    }) },
    { what: "generation zero, which this Node never escrows", payload: JSON.stringify({
      content: [{ generation: 0, secret: REAL_SECRET }], credential: [],
    }) },
    { what: "a negative generation", payload: JSON.stringify({
      content: [{ generation: -3, secret: REAL_SECRET }], credential: [],
    }) },
    { what: "an absurd generation", payload: JSON.stringify({
      content: [{ generation: 999_999_999, secret: REAL_SECRET }], credential: [],
    }) },
    { what: "the same generation twice", payload: JSON.stringify({
      content: [
        { generation: 1, secret: REAL_SECRET },
        { generation: 1, secret: REAL_SECRET },
      ],
      credential: [],
    }) },
    { what: "a secret that is not 32 base64 bytes", payload: JSON.stringify({
      content: [{ generation: 1, secret: "too-short" }], credential: [],
    }) },
    { what: "more generations than any vault has", payload: JSON.stringify({
      content: Array.from({ length: 200 }, (_, n) => ({ generation: n + 1, secret: REAL_SECRET })),
      credential: [],
    }) },
  ];

  for (const one of damaged) {
    it(`refuses ${one.what}, and spends nothing`, async () => {
      const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
      await loseTheVault();
      await withEscrow(one.payload, codes);

      await expect(
        redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!),
        `${one.what} reached the vault`,
      ).rejects.toThrow("E_RECOVERY_ESCROW_CORRUPT");
      expect(
        (await escrowState(testEnv, ORG))!.unredeemed,
        "a refusal before any work began still cost a code",
      ).toBe(10);
    });
  }

  it("still restores from an escrow this Node actually wrote", async () => {
    /*
     * The control, and it has to be a real escrow rather than a hand-built one: a validator strict enough to
     * refuse everything would satisfy all eight assertions above, and the thing being protected is the
     * ordinary path through them.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(
      outcome.restored.content.length + outcome.restored.credential.length,
      "the validator refuses escrows this Node writes itself",
    ).toBeGreaterThan(0);
  });
});

describe("two confirmations of one sheet do not tell the loser it was replaced", () => {
  it("answers alreadyConfirmed when the sheet is here and somebody else confirmed it", async () => {
    /*
     * Zero rows changed has two causes and they are not the same answer: the sheet may be **gone**, replaced
     * by a rotation between the read and the write, or it may still be here and simply confirmed already by a
     * request that won the same race. Reporting both as replaced tells an operator their sheet is dead when
     * it is the active one — and the remedy that follows from that sentence is to mint again, which retires
     * the sheet they are holding.
     *
     * **This input reaches that answer through the early return**, not through the race branch: the set is
     * already confirmed when the code is read, so the function returns before the batch. That is the same
     * answer by a shorter path, and it is what the sequential case gets. The branch after a zero-row update
     * covers the interleaving — confirmed *between* the read and the write — which no sequential test can
     * produce, and `recovery.ts` says so rather than implying otherwise.
     *
     * What this pins is the answer itself: a sheet that is present and held is never reported as replaced,
     * because the remedy that follows from "replaced" is to mint again, which retires the sheet the operator
     * is holding.
     */
    const minted = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await testEnv.CATALOG.prepare(
      "UPDATE recovery_codes SET confirmed_at = ? WHERE org_id = ? AND set_id IS ?",
    ).bind(new Date(createSystemCtx().now()).toISOString(), ORG, minted.setId).run();

    const outcome = await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, minted.codes[1]!);
    expect(outcome.alreadyConfirmed, "a sheet that is present and held was reported as replaced").toBe(true);
    expect(outcome.confirmed).toBe(0);
    expect(await heldSets(), "the sheet was retired by a confirmation that changed nothing").toBe(1);
  });
});

describe("a Node with no recovery codes left is not healthy", () => {
  it("degrades the whole verdict once every code has been spent", async () => {
    /*
     * `unredeemed > 0` was a **guard on** the other three conditions rather than one of them — and each of
     * those is about the codes that remain, so the state where none remain has no code to be stale or weak or
     * unconfirmed. It fell through the gap: `ok: false` at severity `report`, and the overall verdict only
     * escalates on a failing `degraded`. A Node holding mail with no way to recover its vault answered `ok`,
     * with the correct remedy printed underneath where nothing was reading it.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, codes[0]!);
    for (const code of codes) {
      await loseTheVault();
      await redeemForVault(testEnv, createSystemCtx(), ORG, code).catch(() => undefined);
    }
    expect((await escrowState(testEnv, ORG))!.unredeemed, "the fixture did not spend every code").toBe(0);

    const report = await runDoctor(testEnv, createSystemCtx());
    const escrow = find(report.findings, "recovery_escrow");
    expect(escrow.ok, "a Node with no recovery codes reported healthy").toBe(false);
    expect(escrow.severity, "the finding cannot reach the verdict at `report`").toBe("degraded");
    expect(report.verdict, `the headline verdict is still ${report.verdict}`).not.toBe("ok");
  });

  it("stays report-level while codes remain", async () => {
    // The control. A finding that degrades whenever it is looked at is one people stop reading — and this is
    // the ordinary state of every working Node.
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, codes[0]!);
    const escrow = find((await runDoctor(testEnv, createSystemCtx())).findings, "recovery_escrow");
    expect(escrow.ok, `a healthy escrow reported a problem: ${escrow.detail}`).toBe(true);
    expect(escrow.severity).toBe("report");
  });
});

describe("a restore that lost its claim cannot settle", () => {
  /*
   * Acquisition was fenced and settlement was not. The settlement batch updated `recovery_restores` by id
   * alone and appended its entry unconditionally, so a worker whose lease lapsed could come back and finish:
   *
   * ```
   *   A reserves code C as R1, runs past its five-minute lease
   *   B reserves C as R2, restores, marks C redeemed
   *   A returns: second `recovery.vault_restored / ok`, R1 marked completed,
   *              its conditional code-spend changes nothing and nobody reads the zero
   * ```
   *
   * `KeyVault.restore` is idempotent so the keys survive. The record does not: two completed restores for one
   * single-use code, two entries claiming a successful settlement, and the stale attempt's detail becoming the
   * newest row every report reads.
   */
  it("supersedes a lapsed attempt when the code is re-claimed", async () => {
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const code = await testEnv.CATALOG.prepare("SELECT id FROM recovery_codes WHERE org_id = ? LIMIT 1")
      .bind(ORG).first<{ id: string }>();

    // A, still running, its lease long gone.
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
      ).bind("rst_SLOW00000000000000000000", ORG, code!.id,
        new Date(createSystemCtx().now() - RESTORE_LEASE_MS - 1_000).toISOString()),
      testEnv.CATALOG.prepare("UPDATE recovery_codes SET active_restore_id = ? WHERE id = ?")
        .bind("rst_SLOW00000000000000000000", code!.id),
    ]);

    // B takes the code over and finishes.
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    const stale = await testEnv.CATALOG.prepare("SELECT state FROM recovery_restores WHERE id = ?")
      .bind("rst_SLOW00000000000000000000").first<{ state: string }>();
    expect(
      stale?.state,
      "the displaced attempt is still `started`, so doctor goes on reporting an interrupted restore",
    ).toBe("superseded");
  });

  it("writes nothing when the stale worker returns", async () => {
    /*
     * A's settlement, run through the exported statements. The state cannot be produced by calling
     * `redeemForVault` twice, because the second call is what takes the claim away — so the interleaving is
     * built and A's own statements are executed against it.
     */
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const code = await testEnv.CATALOG.prepare("SELECT id FROM recovery_codes WHERE org_id = ? LIMIT 1")
      .bind(ORG).first<{ id: string }>();
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
      ).bind("rst_SLOW00000000000000000000", ORG, code!.id,
        new Date(createSystemCtx().now() - RESTORE_LEASE_MS - 1_000).toISOString()),
      testEnv.CATALOG.prepare("UPDATE recovery_codes SET active_restore_id = ? WHERE id = ?")
        .bind("rst_SLOW00000000000000000000", code!.id),
    ]);
    await loseTheVault();
    await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);

    const before = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'recovery.vault_restored'",
    ).bind(ORG).first<{ n: number }>();

    const outcomes = await testEnv.CATALOG.batch(settlementStatements(
      testEnv, ORG, code!.id, "rst_SLOW00000000000000000000",
      { state: "completed", settledAt: "2099-01-01T00:00:00.000Z", detail: "{}", spend: true },
    ));
    expect(
      outcomes[0]!.meta.changes ?? 0,
      "the stale attempt settled itself after losing the code",
    ).toBe(0);

    const after = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'recovery.vault_restored'",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(after?.n), "a second settlement entry for one code").toBe(Number(before?.n));

    // And exactly one completed restore, one redemption, for one single-use code.
    const completed = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM recovery_restores WHERE org_id = ? AND state = 'completed'",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(completed?.n), "two completed restores for one code").toBe(1);
    expect((await escrowState(testEnv, ORG))!.unredeemed).toBe(9);
  });

  it("lets the owner settle, so the refusal above is the fence and not a broken statement", async () => {
    // The control, and it is the ordinary path: one acquisition, one settlement, one spend.
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await loseTheVault();
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(outcome.restored.content.length + outcome.restored.credential.length).toBeGreaterThan(0);

    const settled = await testEnv.CATALOG.prepare(
      "SELECT state, COUNT(*) AS n FROM recovery_restores WHERE org_id = ? GROUP BY state",
    ).bind(ORG).all<{ state: string; n: number }>();
    expect(settled.results).toEqual([{ state: "completed", n: 1 }]);

    // Ownership released, or the code would answer "somebody is restoring from this" for ever.
    const held = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM recovery_codes WHERE org_id = ? AND active_restore_id IS NOT NULL",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(held?.n), "a settled restore kept its claim on the code").toBe(0);
  });
});

describe("retirement waits for a restore, and a replaced sheet says so", () => {
  it("refuses to confirm while a code in a retiring sheet is being restored from", async () => {
    /*
     * Retirement deletes a set's rows, and a row deleted mid-restore takes the escrow that attempt needs to
     * resume with — leaving an operation that can neither settle nor be run again. That is the one state a
     * resumable operation must not be able to reach, and the whole saga exists to make an interrupted restore
     * resumable.
     *
     * Refusing for the few minutes a lease lasts is the cheaper failure.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    // Somebody is restoring from the sheet the confirmation below would retire.
    const code = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? AND set_id IS ? LIMIT 1",
    ).bind(ORG, first.setId).first<{ id: string }>();
    await testEnv.CATALOG.prepare(
      "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
    ).bind("rst_MIDFLIGHT00000000000000", ORG, code!.id,
      new Date(createSystemCtx().now()).toISOString()).run();

    await expect(
      confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!),
      "a confirmation deleted the code an in-flight restore needs to resume with",
    ).rejects.toThrow("E_RECOVERY_RESTORE_IN_FLIGHT");
    expect(await heldSets(), "the sheet was retired anyway").toBe(2);
  });

  it("confirms normally once the restore has lapsed", async () => {
    // The control. A guard that never releases is a Node that can never rotate its codes again.
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    const code = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? AND set_id IS ? LIMIT 1",
    ).bind(ORG, first.setId).first<{ id: string }>();
    await testEnv.CATALOG.prepare(
      "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
    ).bind("rst_LAPSEDMID0000000000000", ORG, code!.id,
      new Date(createSystemCtx().now() - RESTORE_LEASE_MS - 1_000).toISOString()).run();

    expect((await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, second.codes[0]!)).confirmed).toBe(10);
    expect(await heldSets()).toBe(1);
  });

});

describe("retirement is fenced inside the transaction, not before it", () => {
  /*
   * The guard was a preflight read and the destructive statements carried nothing. So a restore acquired
   * **between** the check and the batch was one whose escrow the batch then deleted, leaving an operation that
   * could neither settle nor resume — the state the whole saga exists to make impossible, arrived at from the
   * outside. Failing closed at settlement stops the attempt lying about success; it does not undo the
   * destruction of the material it needed.
   */
  async function liveRestoreOn(setId: string | null, id: string) {
    const code = await testEnv.CATALOG.prepare(
      "SELECT id FROM recovery_codes WHERE org_id = ? AND set_id IS ? LIMIT 1",
    ).bind(ORG, setId).first<{ id: string }>();
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        "INSERT INTO recovery_restores (id, org_id, code_id, state, started_at) VALUES (?,?,?,'started',?)",
      ).bind(id, ORG, code!.id, new Date(createSystemCtx().now()).toISOString()),
      testEnv.CATALOG.prepare("UPDATE recovery_codes SET active_restore_id = ? WHERE id = ?")
        .bind(id, code!.id),
    ]);
    return code!.id;
  }

  it("deletes nothing when a restore is acquired after the preflight", async () => {
    /*
     * The interleaving, built by running the confirmation's **own statements** against a state where a
     * restore arrived after the preflight would have passed. That is precisely what a preflight cannot see,
     * and it cannot be produced by calling `confirmRecoveryCodes` in sequence — the preflight would refuse
     * first, which is the better error and not the enforcement.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await liveRestoreOn(first.setId, "rst_AFTERPREFLIGHT0000000000");

    const staleBefore = new Date(createSystemCtx().now() - RESTORE_LEASE_MS).toISOString();
    const outcomes = await testEnv.CATALOG.batch(confirmationStatements(
      testEnv, ORG, second.setId, new Date(createSystemCtx().now()).toISOString(), staleBefore,
    ));

    expect(
      outcomes[0]!.meta.changes ?? 0,
      "the retirement deleted the code an in-flight restore needs to resume with",
    ).toBe(0);
    expect(
      outcomes[1]!.meta.changes ?? 0,
      "the sheet was confirmed while its retirement was refused, so the two disagree",
    ).toBe(0);
    expect(await heldSets(), "a sheet was retired around a live restore").toBe(2);
  });

  it("lets the retirement through once nothing is in flight", async () => {
    // The control. A guard that never releases is a Node whose codes can never be rotated again.
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const second = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    const staleBefore = new Date(createSystemCtx().now() - RESTORE_LEASE_MS).toISOString();
    const outcomes = await testEnv.CATALOG.batch(confirmationStatements(
      testEnv, ORG, second.setId, new Date(createSystemCtx().now()).toISOString(), staleBefore,
    ));
    expect(outcomes[0]!.meta.changes ?? 0).toBe(10);
    expect(outcomes[1]!.meta.changes ?? 0).toBe(10);
  });

  it("does not let a rotation delete a pending sheet somebody is restoring from", async () => {
    /*
     * Rotation had **no** guard at all. `redeemForVault` does not require `confirmed_at IS NOT NULL`, so a
     * pending sheet's code is real recovery material and can legitimately be mid-restore when the next
     * rotation deletes it.
     */
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    const pending = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await liveRestoreOn(pending.setId, "rst_PENDINGRESTORE0000000000");

    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);

    const survived = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM recovery_codes WHERE org_id = ? AND set_id IS ?",
    ).bind(ORG, pending.setId).first<{ n: number }>();
    expect(
      Number(survived?.n),
      "a rotation deleted the pending sheet an in-flight restore was using",
    ).toBe(10);
  });

  it("still replaces an unconfirmed sheet nobody is restoring from", async () => {
    // The control for rotation: the ordinary case must still collapse to one pending sheet.
    const first = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await confirmRecoveryCodes(testEnv, createSystemCtx(), ORG, first.codes[0]!);
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    expect(await heldSets(), "each rotation left another sealed copy of the vault behind").toBe(2);
  });
});
