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

  it("allows as many unrelated new messages as somebody likes", async () => {
    // The index is partial for this reason: SQLite treats every NULL as distinct, so a new message is not
    // constrained by it. A person with three half-written new messages is not making a mistake.
    await saveDraft(testEnv, atTime(3_200_000_300_000), ORG, AUTHOR, null, { ...composition, subject: "One" });
    await saveDraft(testEnv, atTime(3_200_000_400_000), ORG, AUTHOR, null, { ...composition, subject: "Two" });
    expect(await listDrafts(testEnv, ORG, AUTHOR)).toHaveLength(2);
  });
});

describe("retiring a draft", () => {
  it("deletes the row and leaves the object for the reconciler", async () => {
    const saved = await saveDraft(testEnv, atTime(3_300_000_000_000), ORG, AUTHOR, null, composition);
    expect(await deleteDraft(testEnv, ORG, AUTHOR, saved.id)).toBe(true);
    expect(await readDraft(testEnv, ORG, AUTHOR, saved.id)).toBeNull();

    // Deliberate, per ADR 32's asymmetry: an orphan blob past grace may be collected, while a reference
    // with no blob may only be *reported*. Deleting the object inline would mean a failure between the two
    // writes leaves a row pointing at nothing — the unrepairable side.
    const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/drafts/` });
    expect(listed.objects).toHaveLength(1);
  });

  it("will not delete somebody else's", async () => {
    const saved = await saveDraft(testEnv, atTime(3_300_000_100_000), ORG, AUTHOR, null, composition);
    expect(await deleteDraft(testEnv, ORG, OTHER, saved.id)).toBe(false);
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
