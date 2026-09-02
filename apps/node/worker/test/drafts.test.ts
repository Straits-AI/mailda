import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { deleteDraft, draftForReply, listDrafts, readDraft, saveDraft } from "../src/drafts.ts";
import { CallerError } from "../src/errors.ts";

const testEnv = env as unknown as Env;
const ORG = "org_drafts";
const MAILBOX = "mbx_drafts";
const AUTHOR = "usr_author";
const OTHER = "usr_other";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  for (const table of ["drafts", "relationship_tuples", "mailboxes"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  // R2 as well as D1, because several of these tests assert on the *number* of stored objects — the whole
  // point of a stable key is that one draft is one object. Left uncleared, they counted the previous tests'
  // drafts and failed for a reason that had nothing to do with what they were checking.
  const stale = await testEnv.EVIDENCE.list({ prefix: `${ORG}/drafts/` });
  for (const object of stale.objects) await testEnv.EVIDENCE.delete(object.key);
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    // Composing is authorized by send.propose, not by owning the draft — see the module header.
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, AUTHOR, "send.propose", "mailbox", MAILBOX, at),
  ]);
});

const composition = {
  mailboxId: MAILBOX,
  to: ["customer@example.net"],
  subject: "Re: Invoice 4500219877",
  body: "We have revised the schedule.",
};

describe("a draft survives a reload", () => {
  it("stores the body and reads it back byte for byte", async () => {
    const saved = await saveDraft(testEnv, atTime(3_000_000_000_000), ORG, AUTHOR, null, composition);
    expect(saved.id).toMatch(/^dft_/);

    // The point of the feature: a different request, with nothing carried over in memory.
    const reloaded = await readDraft(testEnv, ORG, AUTHOR, saved.id);
    expect(reloaded?.body).toBe("We have revised the schedule.");
    expect(reloaded?.subject).toBe("Re: Invoice 4500219877");
    expect(reloaded?.to).toEqual(["customer@example.net"]);
  });

  it("keeps the body out of D1, because a draft is content", async () => {
    const saved = await saveDraft(testEnv, atTime(3_000_000_100_000), ORG, AUTHOR, null, composition);
    const row = await testEnv.CATALOG.prepare("SELECT * FROM drafts WHERE id = ?")
      .bind(saved.id).first<Record<string, unknown>>();

    // Every other piece of customer content on this Node is encrypted at rest in R2 with D1 holding a
    // pointer. A draft body in a D1 column would be an exception to that promise for the convenience of
    // the feature that needed it least, so this asserts the pointer rather than the prose.
    expect(row).not.toBeNull();
    expect(Object.values(row!)).not.toContain("We have revised the schedule.");
    expect(row!.body_key).toBe(`${ORG}/drafts/${saved.id}.txt`);
    expect(row!.body_bytes).toBe(29);
  });

  it("overwrites one object rather than accumulating one per save", async () => {
    const first = await saveDraft(testEnv, atTime(3_000_000_200_000), ORG, AUTHOR, null, composition);
    await saveDraft(testEnv, atTime(3_000_000_260_000), ORG, AUTHOR, first.id, {
      ...composition, body: "Second version.",
    });
    await saveDraft(testEnv, atTime(3_000_000_320_000), ORG, AUTHOR, first.id, {
      ...composition, body: "Third version.",
    });

    // A stable key is what bounds storage to one object per draft — otherwise an afternoon's typing is an
    // afternoon's worth of R2 objects, and the autosave becomes the most expensive thing on the Node.
    const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/drafts/` });
    expect(listed.objects.map((object) => object.key)).toEqual([`${ORG}/drafts/${first.id}.txt`]);
    expect((await readDraft(testEnv, ORG, AUTHOR, first.id))?.body).toBe("Third version.");
  });

  it("writes no object at all for a draft with no body yet", async () => {
    const saved = await saveDraft(testEnv, atTime(3_000_000_400_000), ORG, AUTHOR, null, {
      ...composition, body: "",
    });
    expect((await testEnv.EVIDENCE.list({ prefix: `${ORG}/drafts/` })).objects).toHaveLength(0);
    // NULL rather than an empty object: nothing has been written, which is a different fact from a body
    // that is deliberately blank.
    const row = await testEnv.CATALOG.prepare("SELECT body_key FROM drafts WHERE id = ?")
      .bind(saved.id).first<{ body_key: string | null }>();
    expect(row?.body_key).toBeNull();
  });
});

describe("who may read a draft", () => {
  it("does not show one person's draft to another", async () => {
    const saved = await saveDraft(testEnv, atTime(3_100_000_000_000), ORG, AUTHOR, null, composition);
    // Even with send.propose on the same mailbox: Layer 3 decides what sharing unfinished work means, and
    // until it does, nobody reads a half-written sentence about a customer but its author.
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind("rt_other", ORG, OTHER, "send.propose", "mailbox", MAILBOX, "2026-08-08T00:00:00.000Z").run();

    expect(await readDraft(testEnv, ORG, OTHER, saved.id)).toBeNull();
    expect(await listDrafts(testEnv, ORG, OTHER)).toEqual([]);
  });

  it("refuses to hold a draft for a mailbox the author may not send as", async () => {
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();
    // The check is on the *save*, not only on the send. A composer that let somebody write for an hour and
    // refused at the end is the failure `withheld` exists to report, not a design.
    await expect(
      saveDraft(testEnv, atTime(3_100_000_100_000), ORG, AUTHOR, null, composition),
    ).rejects.toThrow(CallerError);
  });

  it("stops serving a draft once the authority that allowed it is withdrawn", async () => {
    const saved = await saveDraft(testEnv, atTime(3_100_000_200_000), ORG, AUTHOR, null, composition);
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();

    // Re-checked on read, because a draft outlives the grant. §7 and §28 require withdrawn authority to
    // stop working immediately, and a long-lived draft is exactly where "immediately" quietly becomes
    // "next time you sign in".
    await expect(readDraft(testEnv, ORG, AUTHOR, saved.id)).rejects.toThrow(CallerError);
  });
});

describe("replying twice resumes rather than forking", () => {
  it("finds the draft already in progress for a reply", async () => {
    const saved = await saveDraft(testEnv, atTime(3_200_000_000_000), ORG, AUTHOR, null, {
      ...composition, inReplyToMessageId: "<original@example.net>",
    });
    const found = await draftForReply(testEnv, ORG, AUTHOR, "<original@example.net>");
    expect(found?.id).toBe(saved.id);
    expect(found?.body).toBe("We have revised the schedule.");
  });

  it("cannot hold two drafts for the same reply", async () => {
    await saveDraft(testEnv, atTime(3_200_000_100_000), ORG, AUTHOR, null, {
      ...composition, inReplyToMessageId: "<original@example.net>",
    });
    // The unique index is the guard. Without it a person replies twice, writes in the second dock, and the
    // first draft rots — with the interface unable to say which one to open.
    await expect(
      saveDraft(testEnv, atTime(3_200_000_200_000), ORG, AUTHOR, null, {
        ...composition, inReplyToMessageId: "<original@example.net>",
      }),
    ).rejects.toThrow();
  });

  it("takes a person's recipients from the person, even on a reply (#52)", async () => {
    /*
     * The other side of #52, asserted here so the constraint stays where it was put. **A Butler cannot name
     * recipients; a person can** — including a reply addressed somewhere other than the message being replied
     * to, which is an ordinary thing to do and which no Butler may do.
     *
     * `saveDraft` derives nothing from `inReplyToMessageId`: it stores the caller's list, and the API hands it
     * `body.to` straight from the request (`src/index.ts`). A change that made this function look up the
     * parent and address the reply itself would fail here — and it would also silently give every Butler a
     * recipient again, because a Butler's draft goes through this same function.
     */
    const saved = await saveDraft(testEnv, atTime(3_200_000_250_000), ORG, AUTHOR, null, {
      ...composition,
      inReplyToMessageId: "<from-a-customer@example.net>",
      to: ["colleague@acme.example", "supervisor@acme.example"],
      cc: ["records@acme.example"],
    });
    expect(saved.to).toEqual(["colleague@acme.example", "supervisor@acme.example"]);
    expect(saved.cc).toEqual(["records@acme.example"]);
    const reloaded = await readDraft(testEnv, ORG, AUTHOR, saved.id);
    expect(reloaded?.to).toEqual(["colleague@acme.example", "supervisor@acme.example"]);
    expect(reloaded?.inReplyToMessageId).toBe("<from-a-customer@example.net>");
  });

  it("allows as many unrelated new messages as somebody likes", async () => {
    // The index is partial for this reason: SQLite treats every NULL as distinct, so a new message is not
    // constrained by it. A person with three half-written new messages is not making a mistake.
    await saveDraft(testEnv, atTime(3_200_000_300_000), ORG, AUTHOR, null, { ...composition, subject: "One" });
    await saveDraft(testEnv, atTime(3_200_000_400_000), ORG, AUTHOR, null, { ...composition, subject: "Two" });
    expect(await listDrafts(testEnv, ORG, AUTHOR)).toHaveLength(2);
  });
});

describe("retiring a draft", () => {
  // This name has now been wrong twice. It was "leaves the object for the reconciler" while the reconciler
  // listed `raw/` only — a hand-off to a component that had never been given the prefix — and then "which no
  // code path collects", which #67 made false by giving it that prefix. What it asserts is what `deleteDraft`
  // does: the row, and only the row. Which component collects the object afterwards is
  // `test/stranded-draft-bodies.test.ts`'s claim to make, against a real pass, so this name no longer makes
  // any claim about it at all.
  it("deletes the row and leaves the object, because an inline delete is the unrepairable order", async () => {
    const ctx = atTime(3_300_000_000_000);
    const saved = await saveDraft(testEnv, ctx, ORG, AUTHOR, null, composition);
    expect(await deleteDraft(testEnv, ctx, ORG, AUTHOR, saved.id)).toBe(true);
    expect(await readDraft(testEnv, ORG, AUTHOR, saved.id)).toBeNull();

    // Deliberate, per ADR 32's asymmetry: an object past grace whose referent is gone may be collected, while
    // a reference with no object may only be *reported*. Deleting the object here would mean a failure
    // between the two writes leaves a row pointing at nothing — the unrepairable side.
    const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/drafts/` });
    expect(listed.objects).toHaveLength(1);
  });

  it("will not delete somebody else's", async () => {
    const ctx = atTime(3_300_000_100_000);
    const saved = await saveDraft(testEnv, ctx, ORG, AUTHOR, null, composition);
    expect(await deleteDraft(testEnv, ctx, ORG, OTHER, saved.id)).toBe(false);
    expect(await readDraft(testEnv, ORG, AUTHOR, saved.id)).not.toBeNull();
  });
});

describe("a draft that cannot be fully read is still a draft", () => {
  it("returns the recipients and subject when the body object is gone", async () => {
    const saved = await saveDraft(testEnv, atTime(3_400_000_000_000), ORG, AUTHOR, null, composition);
    await testEnv.EVIDENCE.delete(`${ORG}/drafts/${saved.id}.txt`);

    // The alternative is a draft nobody can open, which loses the recipients and the subject as well as the
    // writing. The missing blob is the reconciler's business to report (ADR 32), not this read's to fail on.
    const reloaded = await readDraft(testEnv, ORG, AUTHOR, saved.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.subject).toBe("Re: Invoice 4500219877");
    expect(reloaded?.body).toBe("");
  });

  it("keeps the body when the addresses are unreadable", async () => {
    const saved = await saveDraft(testEnv, atTime(3_400_000_100_000), ORG, AUTHOR, null, composition);
    await testEnv.CATALOG.prepare("UPDATE drafts SET to_addresses = ? WHERE id = ?")
      .bind("{not json", saved.id).run();

    const reloaded = await readDraft(testEnv, ORG, AUTHOR, saved.id);
    // Recipients are retypable in seconds; the writing is not. If only one can survive, it is the writing.
    expect(reloaded?.to).toEqual([]);
    expect(reloaded?.body).toBe("We have revised the schedule.");
  });
});

describe("a save that changes nothing writes nothing", () => {
  it("leaves updated_at where it was", async () => {
    const first = await saveDraft(testEnv, atTime(3_500_000_000_000), ORG, AUTHOR, null, composition);

    // Ten minutes later, the same content — which is what resuming a draft to read it produces.
    const again = await saveDraft(testEnv, atTime(3_500_000_600_000), ORG, AUTHOR, first.id, composition);

    // `updated_at` is shown as "saved on your node · HH:MM:SS". If merely opening a draft moved it, the
    // interface would be reporting a save that did not happen — found by reloading the page and reading the
    // timestamp, not by a test, which is why there is one now.
    expect(again.updatedAt).toBe(first.updatedAt);
    const row = await testEnv.CATALOG.prepare("SELECT updated_at FROM drafts WHERE id = ?")
      .bind(first.id).first<{ updated_at: string }>();
    expect(row?.updated_at).toBe(first.updatedAt);
  });

  it("still saves when a single character changes", async () => {
    const first = await saveDraft(testEnv, atTime(3_500_000_700_000), ORG, AUTHOR, null, composition);
    const edited = await saveDraft(testEnv, atTime(3_500_000_800_000), ORG, AUTHOR, first.id, {
      ...composition, body: `${composition.body}.`,
    });
    // The guard must not be so eager that it swallows a real edit — the failure mode on that side is
    // losing somebody's writing, which is worse than a redundant write.
    expect(edited.updatedAt).not.toBe(first.updatedAt);
    expect((await readDraft(testEnv, ORG, AUTHOR, first.id))?.body).toBe("We have revised the schedule..");
  });

  it("notices a change to the recipients alone", async () => {
    const first = await saveDraft(testEnv, atTime(3_500_000_900_000), ORG, AUTHOR, null, composition);
    const edited = await saveDraft(testEnv, atTime(3_500_001_000_000), ORG, AUTHOR, first.id, {
      ...composition, to: ["someone.else@example.net"],
    });
    expect(edited.updatedAt).not.toBe(first.updatedAt);
    expect((await readDraft(testEnv, ORG, AUTHOR, first.id))?.to).toEqual(["someone.else@example.net"]);
  });
});

/**
 * A body this Node cannot read (#143).
 *
 * ## Measured, on a restored Node
 *
 * `GET /api/drafts/:id` answered `200` with `body: ""` and `bodyBytes: 180` beside it. The row contradicted
 * the answer and nothing said which of two very different states it was: the object gone, or the object
 * present and sealed under a key this vault does not hold — the ADR 28 loss the recovery codes exist for,
 * which **clears** when one is redeemed.
 *
 * ## Two losses were reachable from the empty box, and neither announced itself
 *
 * An empty body in a composer is an invitation to type. From there:
 *
 *   - a **non-empty** save re-seals to `bodyKeyFor(orgId, id)`, which is deterministic, so it overwrites the
 *     object it could not open — evidence that was recoverable becomes evidence that is gone;
 *   - an **empty** save leaves `body_key` pointing at the old object while writing `body_sha256 = NULL` and
 *     `body_bytes = 0`. The bytes survive and stop being verifiable, because the verifier skips a row with
 *     no recorded hash.
 *
 * The second is the one reasoning alone would have missed, and it is why these tests assert on the stored
 * object and the row rather than only on the refusal.
 */
describe("a draft body the vault cannot open", () => {
  /** Replaces a saved draft's object with bytes no key opens, leaving the row exactly as it was. */
  async function makeItUnreadable(draftId: string): Promise<string> {
    const row = await testEnv.CATALOG.prepare("SELECT body_key FROM drafts WHERE id = ?")
      .bind(draftId).first<{ body_key: string }>();
    const key = row!.body_key;
    const object = await testEnv.EVIDENCE.get(key);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    // The 32-byte header is left intact and the last byte of the body flipped, so the object parses as
    // evidence and fails **authentication** — which is what a wrong key looks like, and not what a truncated
    // object looks like.
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    await testEnv.EVIDENCE.put(key, bytes, {
      customMetadata: { ...(object!.customMetadata ?? {}) },
    });
    return key;
  }

  it("says the body is unreadable rather than reporting an empty one", async () => {
    const saved = await saveDraft(testEnv, atTime(3_100_000_000_000), ORG, AUTHOR, null, composition);
    await makeItUnreadable(saved.id);

    const read = await readDraft(testEnv, ORG, AUTHOR, saved.id);

    expect(read?.body).toBe("");
    expect(read?.bodyUnavailable).toBe("unreadable");
    /*
     * The contradiction that used to be the only clue, and it is deliberately still here: the row's own
     * count says there was writing. What changed is that the answer now explains itself rather than leaving
     * a reader to notice the mismatch.
     */
    expect(read?.bodyBytes).toBeGreaterThan(0);
    // The recipients and subject are intact, which is why the read does not simply fail.
    expect(read?.subject).toBe(composition.subject);
    expect(read?.to).toEqual(composition.to);
  });

  it("says nothing when the body reads, so the field is a signal and not decoration", async () => {
    const saved = await saveDraft(testEnv, atTime(3_100_000_100_000), ORG, AUTHOR, null, composition);
    const read = await readDraft(testEnv, ORG, AUTHOR, saved.id);
    expect(read?.body).toBe(composition.body);
    expect(read?.bodyUnavailable).toBeNull();
  });

  it("distinguishes a body that is gone from one that will not open", async () => {
    /*
     * Different fixes: `missing` is ADR 32's reportable-only side and nothing recovers it, `unreadable` is
     * recoverable with a recovery code. Collapsing them into one word would send somebody hunting for a key
     * that would not help, or give up on writing that is still there.
     */
    const saved = await saveDraft(testEnv, atTime(3_100_000_200_000), ORG, AUTHOR, null, composition);
    const row = await testEnv.CATALOG.prepare("SELECT body_key FROM drafts WHERE id = ?")
      .bind(saved.id).first<{ body_key: string }>();
    await testEnv.EVIDENCE.delete(row!.body_key);

    expect((await readDraft(testEnv, ORG, AUTHOR, saved.id))?.bodyUnavailable).toBe("missing");
  });

  it("refuses to write over it, which is the loss that used to be reachable", async () => {
    const saved = await saveDraft(testEnv, atTime(3_100_000_300_000), ORG, AUTHOR, null, composition);
    const key = await makeItUnreadable(saved.id);
    const before = new Uint8Array(await (await testEnv.EVIDENCE.get(key))!.arrayBuffer());

    const typedOver = saveDraft(testEnv, atTime(3_100_000_360_000), ORG, AUTHOR, saved.id, {
      ...composition, body: "rewriting this from scratch because the box was empty",
    });

    await expect(typedOver).rejects.toThrow(/E_DRAFT_BODY_UNREADABLE/);
    // The bytes are still there, which is the whole point: they were never lost, only unopenable.
    const after = new Uint8Array(await (await testEnv.EVIDENCE.get(key))!.arrayBuffer());
    expect([...after]).toEqual([...before]);
  });

  it("refuses an empty save too, which would have stranded the object instead of destroying it", async () => {
    /*
     * The subtler of the two. An empty body skips the `putEvidence` branch, so the bytes survive — and the
     * row is rewritten with `body_sha256 = NULL` and `body_bytes = 0`, which makes the surviving object
     * unverifiable: the verifier skips a row carrying no recorded hash, so it becomes an object nothing
     * accounts for. A refusal written only for the overwrite would have let this through.
     */
    const saved = await saveDraft(testEnv, atTime(3_100_000_400_000), ORG, AUTHOR, null, composition);
    await makeItUnreadable(saved.id);

    await expect(saveDraft(testEnv, atTime(3_100_000_460_000), ORG, AUTHOR, saved.id, {
      ...composition, body: "",
    })).rejects.toThrow(/E_DRAFT_BODY_UNREADABLE/);

    const row = await testEnv.CATALOG.prepare("SELECT body_sha256, body_bytes FROM drafts WHERE id = ?")
      .bind(saved.id).first<{ body_sha256: string | null; body_bytes: number }>();
    expect(row?.body_sha256, "the row's hash was nulled, so the object is no longer verifiable").not.toBeNull();
    expect(row?.body_bytes).toBeGreaterThan(0);
  });

  it("lets a save carrying the same text through, and that repairs the object", async () => {
    /*
     * The cost gate, and it turns out to be more than an optimisation — this is what the test measured
     * rather than what it was written to expect.
     *
     * The check costs an R2 get and a decrypt, and drafts autosave, so it is skipped when the incoming body
     * digest matches the stored hash. The reasoning was "nothing would be replaced". What actually happens
     * is better: the save re-seals the **same plaintext** to the same deterministic key under the current
     * generation, so the unreadable object becomes readable again.
     *
     * And that is sound rather than lucky. A caller can only produce a matching digest by already holding
     * the text, which is proof the writing was never lost — so writing it back cannot destroy anything. A
     * client that rendered an empty box would send an empty body, whose digest does **not** match, and the
     * refusal catches it.
     */
    const saved = await saveDraft(testEnv, atTime(3_100_000_500_000), ORG, AUTHOR, null, composition);
    await makeItUnreadable(saved.id);
    expect((await readDraft(testEnv, ORG, AUTHOR, saved.id))?.bodyUnavailable).toBe("unreadable");

    const again = await saveDraft(testEnv, atTime(3_100_000_560_000), ORG, AUTHOR, saved.id, {
      ...composition, subject: "Re: Invoice 4500219877 (corrected)",
    });

    expect(again.subject).toBe("Re: Invoice 4500219877 (corrected)");
    const read = await readDraft(testEnv, ORG, AUTHOR, saved.id);
    expect(read?.bodyUnavailable, "the same text written back should have repaired it").toBeNull();
    expect(read?.body).toBe(composition.body);
  });

  it("lets a save through when the body is genuinely gone, rather than stranding the draft", async () => {
    /*
     * The limit of the refusal, and a mutation found this untested: making the write treat a **missing**
     * object as unreadable passed every other test here.
     *
     * `missing` is ADR 32's reportable-only side. The writing is already lost and no key brings it back, so
     * blocking the write would strand the recipients and subject too — punishing somebody for a loss they
     * cannot undo, on a draft they are trying to salvage. Only `unreadable` is refused, because only
     * `unreadable` is recoverable.
     */
    const saved = await saveDraft(testEnv, atTime(3_100_000_700_000), ORG, AUTHOR, null, composition);
    const row = await testEnv.CATALOG.prepare("SELECT body_key FROM drafts WHERE id = ?")
      .bind(saved.id).first<{ body_key: string }>();
    await testEnv.EVIDENCE.delete(row!.body_key);
    expect((await readDraft(testEnv, ORG, AUTHOR, saved.id))?.bodyUnavailable).toBe("missing");

    const rewritten = await saveDraft(testEnv, atTime(3_100_000_760_000), ORG, AUTHOR, saved.id, {
      ...composition, body: "written again, because the original is gone",
    });

    expect(rewritten.body).toBe("written again, because the original is gone");
    expect((await readDraft(testEnv, ORG, AUTHOR, saved.id))?.bodyUnavailable).toBeNull();
  });

  it("still refuses a body that never reads, rather than deleting the draft to make progress", async () => {
    // A draft is not a thing to discard on the Node's initiative. Deleting is an operator's act, and the
    // refusal names it as the way out rather than taking it.
    const saved = await saveDraft(testEnv, atTime(3_100_000_600_000), ORG, AUTHOR, null, composition);
    await makeItUnreadable(saved.id);
    const failed = await saveDraft(testEnv, atTime(3_100_000_660_000), ORG, AUTHOR, saved.id, {
      ...composition, body: "anything",
    }).catch((error: CallerError) => error);

    expect((failed as CallerError).status).toBe(422);
    /*
     * **The `fix` line specifically**, not the message as a whole. Asserting the whole message survived a
     * mutation that replaced the fix with "the body cannot be replaced", because `why` mentions recovery
     * codes too — so the test passed while the refusal had stopped naming any way forward, which is the one
     * thing a refusal during an incident has to do.
     */
    const message = (failed as CallerError).message;
    expect(message.slice(message.indexOf("fix "))).toContain("redeeming one of the ten recovery codes");
    // And the draft is still there to be recovered or deleted deliberately.
    expect(await readDraft(testEnv, ORG, AUTHOR, saved.id)).not.toBeNull();
  });
});
