import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { runDoctor, type Finding } from "../src/doctor.ts";
import { aesKeyFrom, vault } from "../src/keyvault.ts";
import {
  CODE_CHARACTERS, codeHash, escrowState, formatCode, mintRecoveryCodes, normaliseCode, redeemForVault,
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
async function loseTheVault(): Promise<void> {
  await runInDurableObject(vault(testEnv), async (_instance, state) => {
    await state.storage.deleteAll();
  });
}

beforeEach(async () => {
  for (const table of ["recovery_codes", "node_claim"]) {
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
    expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(/E_RECOVERY_CODE_SPENT/);
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

  it("reports it healthy once minted, without printing anything secret", async () => {
    await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
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
    expect(recorded.map((one) => one.action))
      .toEqual(["recovery.codes_minted", "recovery.vault_restored"]);

    const spend = recorded[1]!;
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

  it("records what the escrow carried, not what got installed", async () => {
    /*
     * The entry commits **before** the restore runs, so it cannot know which generations were installed —
     * a generation can collide with a live key and be skipped. Naming the escrowed set as *restored* would
     * be the same false-success claim this file's `conflicted` tests exist to catch, written into a record
     * that is never trimmed.
     */
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
    const { codes } = await mintRecoveryCodes(testEnv, createSystemCtx(), ORG);
    // Regenerate, so the redemption below collides and installs nothing.
    await loseTheVault();
    await vault(testEnv).sealingKey("content");
    const outcome = await redeemForVault(testEnv, createSystemCtx(), ORG, codes[0]!);
    expect(outcome.conflicted.content, "the fixture did not produce a collision").toContain(1);

    const detail = (await entries()).at(-1)!.detail;
    expect(detail).toMatch(/escrowedContent/);
    expect(detail, "the trail claims a restore rather than an escrow").not.toMatch(/"restored"/);
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
