import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { canonicalButlerJson, checkButler } from "@mailda/butler-ast";
import { createSystemCtx, ID_PREFIXES, idPattern, type Ctx } from "@mailda/runtime";

import { createButlerDraft, editButlerDraft, publishButler } from "../src/butlers.ts";

/**
 * The Butler object's lifecycle (#49): draft, publish, freeze, refuse.
 *
 * ## What each of these is really testing
 *
 * The package tests in `packages/butler-ast` prove the checker and the canonicaliser in isolation. This
 * file proves the four claims that only exist once there is a database:
 *
 *   1. a published version's AST and source text are **unwritable** — enforced by a trigger, so it is
 *      asserted by trying, not by reading the write path;
 *   2. a publish that changes nothing is **refused**, and key order is not a change;
 *   3. reformatting the source text **is** a change, because publication is the versioning event whether or
 *      not the AST moved;
 *   4. an unpublishable program never enters the store at all.
 */

const testEnv = env as unknown as Env;
const ORG = "org_butler";
const ADMIN = "usr_admin_b";
const NOBODY = "usr_nobody_b";
const AUGUST_20 = Date.parse("2026-08-20T09:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/**
 * The Butler this layer ships: check the shape of the enquiry, assign the case, draft a reply, propose the
 * send.
 *
 * The `validate` node is here for a reason found by mutating the canonicaliser rather than by design. Zod's
 * object parse rebuilds its output in **schema** order, so for every field this AST declares, two documents
 * written in opposite key orders are already identical by the time they reach the store — which made the
 * key-order test below pass with canonicalization deleted. `validate.schema` is a record of unknown, so its
 * keys are whatever the author wrote in whatever order: it is the one field where reordering survives
 * parsing, and therefore the only thing that makes the key-order refusal a real check here.
 */
function leadIntake(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name: "sales-enquiries", owner: "team:sales" },
    trigger: { event: "mail.received", mailbox: "enquiries@example.com" },
    entry: "shape",
    nodes: [
      {
        id: "shape", type: "validate", value: "${event.body}",
        schema: { type: "object", required: ["company"], additionalProperties: true },
        next: "assign",
      },
      {
        id: "assign", type: "case.assign", caseId: "${event.case_id}",
        assignee: "${org.rota.on_call}", next: "acknowledge",
      },
      {
        id: "acknowledge", type: "draft", mailboxId: "${event.mailbox_id}", to: ["${event.from}"],
        subject: "Re: ${event.subject}", body: "Thanks — somebody will reply.", as: "reply",
        next: "propose",
      },
      { id: "propose", type: "mail.send.propose", draft: "${steps.reply.draft_id}", next: null },
    ],
    ...overrides,
  };
}

function source(ast: Record<string, unknown> = leadIntake(), space?: number): string {
  return JSON.stringify(ast, null, space);
}

/** Rebuilds every object in a JSON value with its keys in reverse order. */
function reversed<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversed) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = reversed((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

async function versionRow(id: string) {
  return await testEnv.CATALOG.prepare(
    `SELECT id, version, state, ast_json, source_text, ast_sha256, source_sha256, published_by,
            published_at, superseded_at
       FROM butler_versions WHERE org_id = ? AND id = ?`,
  ).bind(ORG, id).first<{
    id: string; version: number | null; state: string; ast_json: string; source_text: string;
    ast_sha256: string; source_sha256: string; published_by: string | null; published_at: string | null;
    superseded_at: string | null;
  }>();
}

beforeEach(async () => {
  for (const table of ["butler_versions", "butlers", "relationship_tuples", "audit_entries", "users"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(ADMIN, ORG, "admin@local.invalid", at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at),
  ]);
});

describe("drafting and publishing a Butler", () => {
  it("mints btl_ and btv_ identifiers from the registry", async () => {
    const draft = await createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    expect(idPattern(ID_PREFIXES.butler).test(draft.butlerId)).toBe(true);
    expect(idPattern(ID_PREFIXES.butlerVersion).test(draft.versionId)).toBe(true);
  });

  it("stores the canonical AST, not the submitted text, in ast_json", async () => {
    const pretty = source(leadIntake(), 2);
    const draft = await createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "sales-enquiries", source: pretty,
    });
    const row = await versionRow(draft.versionId);
    expect(row?.state).toBe("draft");
    expect(row?.version).toBeNull();
    // The source is kept byte for byte; the AST beside it is canonical.
    expect(row?.source_text).toBe(pretty);
    expect(row?.ast_json).not.toContain("\n");
    const checkedAst = checkButler(JSON.parse(pretty));
    expect(checkedAst.ok).toBe(true);
    if (checkedAst.ok) expect(row?.ast_json).toBe(canonicalButlerJson(checkedAst.ast));
  });

  it("publishes version 1, then version 2, superseding the first", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const first = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    expect(first.version).toBe(1);
    expect(first.supersededVersionId).toBeNull();

    const changed = leadIntake();
    (changed["metadata"] as Record<string, unknown>)["owner"] = "team:support";
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, { source: source(changed) });
    const second = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);

    expect(second.version).toBe(2);
    expect(second.supersededVersionId).toBe(first.versionId);
    expect((await versionRow(first.versionId))?.state).toBe("superseded");
    expect((await versionRow(second.versionId))?.state).toBe("published");
  });

  it("refuses a publish with no draft", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    await expect(publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId))
      .rejects.toThrow(/E_NO_BUTLER_DRAFT/);
  });

  it("refuses somebody who is not an administrator", async () => {
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, NOBODY, {
      name: "sales-enquiries", source: source(),
    })).rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
  });

  it("refuses a second Butler under the same name", async () => {
    const ctx = atTime(AUGUST_20);
    await createButlerDraft(testEnv, ctx, ORG, ADMIN, { name: "sales-enquiries", source: source() });
    await expect(createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    })).rejects.toThrow(/E_BUTLER_NAME_TAKEN/);
  });
});

describe("a published version is frozen", () => {
  it("cannot have its AST rewritten, and the database is what refuses", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const live = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);

    // Not "the write path does not do this" — an attempt, made directly, the way a future feature or a
    // console session would. #60 proved the same property by asserting the bytes had not moved, which
    // proves the code behaves; this proves the row cannot.
    await expect(testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET ast_json = ? WHERE org_id = ? AND id = ?",
    ).bind('{"apiVersion":"mailda/v1"}', ORG, live.versionId).run())
      .rejects.toThrow(/E_BUTLER_VERSION_FROZEN/);
  });

  it("cannot have its source text, digests or version number rewritten either", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const live = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);

    for (const [column, value] of [
      ["source_text", "{}"], ["ast_sha256", "0"], ["source_sha256", "0"], ["version", 99],
    ] as const) {
      await expect(
        testEnv.CATALOG.prepare(
          `UPDATE butler_versions SET ${column} = ? WHERE org_id = ? AND id = ?`,
        ).bind(value, ORG, live.versionId).run(),
        column,
      ).rejects.toThrow(/E_BUTLER_VERSION_FROZEN/);
    }
  });

  it("cannot be walked back to a draft, which was the two-statement way round the trigger", async () => {
    /*
     * `btv_frozen` guards content *while the state is published or superseded*, and the state column is not
     * in its WHEN clause — so demoting first and rewriting second was two statements neither of which the
     * trigger saw as an edit to a published version. Demonstrated before it was closed: the demotion
     * committed, the next UPDATE moved `ast_json`, and `editButlerDraft` then deleted what had been version
     * 1, because a demoted row is indistinguishable from a draft to both `btv_one_draft` and the
     * `state = 'draft'` predicate. `btv_forward_only` is what refuses the first step.
     */
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const live = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);

    await expect(testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET state = 'draft' WHERE org_id = ? AND id = ?",
    ).bind(ORG, live.versionId).run()).rejects.toThrow(/E_BUTLER_VERSION_FROZEN/);

    // And the combined statement, which the content trigger already refused, still is — so closing the
    // split path did not open the joined one.
    await expect(testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET state = 'draft', ast_json = '{}' WHERE org_id = ? AND id = ?",
    ).bind(ORG, live.versionId).run()).rejects.toThrow(/E_BUTLER_VERSION_FROZEN/);

    // The row is untouched and still the live version, which is the property the two refusals protect.
    const row = await versionRow(live.versionId);
    expect(row?.state).toBe("published");
    expect(row?.version).toBe(1);
  });

  it("cannot be resurrected from superseded, because two live versions is the state btv_live forbids", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const first = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    const changed = leadIntake();
    (changed["metadata"] as Record<string, unknown>)["owner"] = "team:support";
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, { source: source(changed) });
    await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);

    await expect(testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET state = 'published' WHERE org_id = ? AND id = ?",
    ).bind(ORG, first.versionId).run()).rejects.toThrow(/E_BUTLER_VERSION_FROZEN/);
    // Rollback in this product is republication: the old source becomes a new version. Nothing needs the
    // backwards edge, which is why refusing it is a tripwire rather than a limitation.
    expect((await versionRow(first.versionId))?.state).toBe("superseded");
  });

  it("still allows the one lifecycle move that has to happen: published to superseded", async () => {
    // Anti-vacuity for the two refusals above. A trigger that aborted every state change would pass them
    // both and break publishing outright — which is the shape a `WHEN` clause one clause too broad has.
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const first = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    const changed = leadIntake();
    (changed["metadata"] as Record<string, unknown>)["owner"] = "team:support";
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, { source: source(changed) });
    const second = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    expect((await versionRow(first.versionId))?.state).toBe("superseded");
    expect((await versionRow(second.versionId))?.state).toBe("published");
  });

  it("refuses a NULL written into a frozen column, which `<>` would have let through", async () => {
    // The trigger uses `IS NOT` rather than `<>`. Against a NULL, `<>` yields NULL, the WHEN clause does not
    // fire, and setting a frozen column to NULL is the one edit that would have committed.
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const live = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    await expect(testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET version = NULL WHERE org_id = ? AND id = ?",
    ).bind(ORG, live.versionId).run()).rejects.toThrow(/E_BUTLER_VERSION_FROZEN/);
  });

  it("replaces a draft rather than accumulating them, and the replaced row is gone", async () => {
    // Editing is delete-then-insert in one transaction, because `btv_one_draft` permits exactly one. This
    // is the property `editButlerDraft` depends on, and the one thing about `butler_versions` that a
    // `DELETE` is allowed to do.
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const changed = leadIntake();
    (changed["metadata"] as Record<string, unknown>)["owner"] = "team:support";
    const replaced = await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, {
      source: source(changed),
    });
    expect(await versionRow(draft.versionId)).toBeNull();

    const again = leadIntake();
    (again["metadata"] as Record<string, unknown>)["owner"] = "team:billing";
    const third = await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, {
      source: source(again),
    });
    expect(await versionRow(replaced.versionId)).toBeNull();

    const { results } = await testEnv.CATALOG.prepare(
      "SELECT id FROM butler_versions WHERE org_id = ? AND butler_id = ?",
    ).bind(ORG, draft.butlerId).all<{ id: string }>();
    expect(results.map((row) => row.id)).toEqual([third.versionId]);
  });

  it("keeps a superseded version byte-identical to what was published", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const first = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    const asPublished = await versionRow(first.versionId);

    const changed = leadIntake();
    (changed["metadata"] as Record<string, unknown>)["owner"] = "team:support";
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, { source: source(changed) });
    await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);

    const asSuperseded = await versionRow(first.versionId);
    expect(asSuperseded?.ast_json).toBe(asPublished?.ast_json);
    expect(asSuperseded?.source_text).toBe(asPublished?.source_text);
    expect(asSuperseded?.version).toBe(asPublished?.version);
    // Only the lifecycle moved, which is what "freezes the content" has to mean precisely.
    expect(asSuperseded?.state).toBe("superseded");
    expect(asSuperseded?.superseded_at).not.toBeNull();
  });
});

describe("a publish that changes nothing is refused", () => {
  it("refuses a draft byte-identical to the published version", async () => {
    const ctx = atTime(AUGUST_20);
    const text = source();
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: text,
    });
    await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, { source: text });

    await expect(publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId))
      .rejects.toThrow(/E_BUTLER_UNCHANGED/);
  });

  it("mints a version for a change of key order, and records that the program did not move", async () => {
    /*
     * The load-bearing test for the canonical serialization, and its name is the exact claim rather than
     * the one it would be nicer to make. Reordering keys **does** publish: the source text is different
     * bytes, and a version freezes the source text as well as the AST, so there is something to freeze.
     * What canonicalization buys is the column beside it — `ast_sha256` does not move, so the history says
     * *"v2 is the same program as v1, written differently"* instead of leaving a reader to diff two texts.
     *
     * Said plainly because the refusal is easy to over-describe: it compares both digests, and identical
     * source bytes already imply an identical AST, so the source digest is what decides it. This test is
     * about the other digest.
     */
    const ctx = atTime(AUGUST_20);
    const forward = leadIntake();
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(forward),
    });
    const live = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    const published = await versionRow(live.versionId);

    const reorderedText = source(reversed(forward));
    // The premise: the two source texts really are different bytes.
    expect(reorderedText).not.toBe(source(forward));

    const replacement = await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, {
      source: reorderedText,
    });
    const replacementRow = await versionRow(replacement.versionId);

    // The AST digest is unchanged — the program did not move.
    expect(replacementRow?.ast_sha256).toBe(published?.ast_sha256);
    // The source digest did, because the author's text is different bytes. So publication is *allowed*,
    // and that is #49's decision rather than a loophole: publishing mints a version whether or not the AST
    // changed, and a published version freezes both.
    expect(replacementRow?.source_sha256).not.toBe(published?.source_sha256);
    const second = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    expect(second.version).toBe(2);

    // And the program really is the same one, which is the property the AST digest was asserting.
    expect((await versionRow(second.versionId))?.ast_json).toBe(published?.ast_json);
  });

  it("does mint a version for a reformat, because publication is the versioning event", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(leadIntake()),
    });
    const first = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, draft.butlerId, {
      source: source(leadIntake(), 2),
    });
    const second = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    expect(second.version).toBe(2);
    expect((await versionRow(second.versionId))?.ast_sha256)
      .toBe((await versionRow(first.versionId))?.ast_sha256);
  });
});

describe("what never reaches the store", () => {
  it("refuses a Butler with a reserved node, naming the node", async () => {
    const ast = leadIntake();
    (ast["nodes"] as unknown[]).push({ id: "classify", type: "llm.classify", profile: "p@1" });
    (ast["nodes"] as Array<Record<string, unknown>>)[1]!["next"] = "classify";
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "sales-enquiries", source: source(ast),
    })).rejects.toThrow(/E_BUTLER_DOES_NOT_CHECK[\s\S]*E_BUTLER_NODE_RESERVED[\s\S]*classify/);

    // And nothing was stored, which is what makes "the store holds only programs that check" true.
    const { results } = await testEnv.CATALOG.prepare("SELECT id FROM butlers WHERE org_id = ?")
      .bind(ORG).all();
    expect(results).toEqual([]);
  });

  it("refuses a cycle and an unbounded loop", async () => {
    const cyclic = leadIntake();
    (cyclic["nodes"] as Array<Record<string, unknown>>)[3]!["next"] = "assign";
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "cyclic", source: source(cyclic),
    })).rejects.toThrow(/E_BUTLER_CYCLE/);

    const unbounded = leadIntake();
    (unbounded["nodes"] as unknown[]).push(
      { id: "fan", type: "foreach", over: "${x}", as: "i", body: "step", next: null },
      { id: "step", type: "transform", as: "v", value: "${i}", next: null },
    );
    (unbounded["nodes"] as Array<Record<string, unknown>>)[3]!["next"] = "fan";
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "unbounded", source: source(unbounded),
    })).rejects.toThrow(/E_BUTLER_LOOP_UNBOUNDED/);
  });

  it("refuses a source that is not JSON", async () => {
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "yaml-please", source: "apiVersion: mailda/v1\nkind: Butler\n",
    })).rejects.toThrow(/E_BUTLER_SOURCE_NOT_JSON/);
  });

  it("refuses a Butler whose AST and source together exceed one D1 row", async () => {
    // The one size bound in the feature, and it is a platform limit with a receipt rather than a taste.
    const huge = leadIntake();
    (huge["nodes"] as Array<Record<string, unknown>>)[2]!["body"] = "x".repeat(1_200_000);
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "enormous", source: source(huge),
    })).rejects.toThrow(/E_BUDGET_EXCEEDED[\s\S]*d1\.max_row_bytes/);
  });

  it("refuses a Butler that cannot afford to run, at the draft, with the arithmetic (#54)", async () => {
    /*
     * `src/butlers.ts` claims that the affordability refusal *"arrives as an ordinary `Finding`, so it needs
     * no code here"* and that it *"applies to a draft as well as to a publication, deliberately"*. Both are
     * claims about this path, and until this test existed nothing enforced either: every affordability
     * assertion lived in `packages/butler-ast`, which has no store and no draft. A checker whose most
     * expensive refusal never reached a caller would satisfy all of them.
     *
     * Bounded at the boundary rather than at something obviously huge, so the test also pins that the store
     * accepts the largest loop that fits — a refusal that fired one item early would be invisible to a
     * fixture of a million.
     */
    const unaffordable = leadIntake();
    (unaffordable["nodes"] as unknown[]).push(
      { id: "fan_out", type: "foreach", over: "${steps.reply.recipients}", as: "r", maxItems: 499, body: "send_one", next: null },
      { id: "send_one", type: "mail.send.propose", draft: "${steps.reply.draft_id}", next: null },
    );
    (unaffordable["nodes"] as Array<Record<string, unknown>>)[3]!["next"] = "fan_out";
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "too-much", source: source(unaffordable),
    })).rejects.toThrow(
      /E_BUTLER_UNAFFORDABLE[\s\S]*10018 subrequests[\s\S]*workflow\.paid\.subrequest_budget_per_instance=10000/,
    );
    // The whole point of the sum: the fix names the bound that would have worked, not just the excess.
    await expect(createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "too-much", source: source(unaffordable),
    })).rejects.toThrow(/lower fan_out's maxItems to 498 or fewer/);
    // Nothing reached the store, which is what makes "only programs that check" true of this refusal too.
    const { results } = await testEnv.CATALOG.prepare("SELECT id FROM butlers WHERE org_id = ?")
      .bind(ORG).all();
    expect(results).toEqual([]);

    // And one item fewer is stored and publishable, so the refusal is a boundary rather than a wall.
    (((unaffordable["nodes"] as Array<Record<string, unknown>>)
      .find((node) => node["id"] === "fan_out"))!)["maxItems"] = 498;
    const draft = await createButlerDraft(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      name: "just-affordable", source: source(unaffordable),
    });
    expect((await publishButler(testEnv, atTime(AUGUST_20), ORG, ADMIN, draft.butlerId)).version).toBe(1);
  });

  it("refuses at publication a draft the current checker no longer admits", async () => {
    // The re-check at publish, proved the only way it can be without a second checker: write a draft
    // through the normal path, corrupt the stored source behind it, then publish. A publish that trusted
    // the draft's own earlier verdict would promote it.
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const smuggled = leadIntake();
    (smuggled["nodes"] as unknown[]).push({ id: "classify", type: "llm.classify" });
    (smuggled["nodes"] as Array<Record<string, unknown>>)[1]!["next"] = "classify";
    await testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET source_text = ? WHERE org_id = ? AND id = ? AND state = 'draft'",
    ).bind(source(smuggled), ORG, draft.versionId).run();

    await expect(publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId))
      .rejects.toThrow(/E_BUTLER_NODE_RESERVED/);
  });

  it("refuses to freeze a draft whose stored digests do not describe its own source text", async () => {
    /*
     * The other half of the same tamper, and the one the re-check alone does not catch: a source text that
     * still *checks* but is a different program from the `ast_json` beside it. Everything after the re-check
     * compares stored digests — the no-op refusal, the audit detail — so publishing here would freeze two
     * columns that disagree, permanently, with the engine reading one and a person reading the other.
     *
     * Nothing in `src/butlers.ts` can produce this row, which is what makes it a tripwire rather than a
     * guard on a normal path: `checked()` derives both digests from one submission.
     */
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    const different = leadIntake();
    (different["metadata"] as Record<string, unknown>)["owner"] = "team:somebody-else";
    // A valid program, so the checker has no complaint — only the digests disagree.
    await testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET source_text = ? WHERE org_id = ? AND id = ? AND state = 'draft'",
    ).bind(source(different), ORG, draft.versionId).run();

    await expect(publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId))
      .rejects.toThrow(/E_BUTLER_DRAFT_INCOHERENT/);
    // Nothing was published, so the incoherence never became history.
    expect((await versionRow(draft.versionId))?.state).toBe("draft");
  });
});

describe("the audit trail", () => {
  it("records the draft and the publication, and says what will fire the published version", async () => {
    const ctx = atTime(AUGUST_20);
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
      name: "sales-enquiries", source: source(),
    });
    await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);

    const { results } = await testEnv.CATALOG.prepare(
      "SELECT action, subject, detail FROM audit_entries WHERE org_id = ? ORDER BY seq",
    ).bind(ORG).all<{ action: string; subject: string; detail: string }>();

    expect(results.map((row) => row.action)).toEqual(["butler.drafted", "butler.published"]);
    for (const row of results) expect(row.subject).toBe(draft.butlerId);
    const published = JSON.parse(results[1]!.detail) as {
      version: number; trigger: { event: string; mailbox: string };
    };
    expect(published.version).toBe(1);
    /*
     * Said in the trail, not only in a comment: what will fire this version.
     *
     * This assertion was `runnable: false` until #50 landed the engine, at which point the field became a
     * lie in the one table that must not hold one. The replacement is deliberately not `runnable: true` — a
     * field whose only value is `true` says nothing — but the trigger, which is the question a reader of
     * the entry asks next.
     */
    expect(published.trigger).toEqual({ event: "mail.received", mailbox: "enquiries@example.com" });
  });
});
