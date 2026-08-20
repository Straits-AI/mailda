import { BUDGETS } from "@mailda/budgets";
import {
  astSha256, canonicalButlerJson, checkButler, describeFindings, textSha256, type Butler, type Finding,
} from "@mailda/butler-ast";
import { ID_PREFIXES, type Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { isAdmin } from "./access.ts";
import { CallerError, conflict, notFound, unprocessable } from "./errors.ts";

/**
 * The Butler object: a name, a draft, and a history of published versions (#49, Layer 4, §16).
 *
 * ## Publication is the versioning event, and it is the whole lifecycle
 *
 * Editing produces a **draft**. Publishing mints the version, whether or not the AST changed. A published
 * version cannot be edited at all — which *dissolves* the question of what a comment-only edit does rather
 * than answering it: there is no such thing as editing a published Butler, so the question is only ever
 * about a draft, and publishing is a deliberate second act. `src/policy.ts` already inherited this shape
 * from #49 one layer up; this is the object it was decided for.
 *
 * **A publish that changes nothing is refused.** Byte-identical canonical AST *and* byte-identical source
 * text to the currently published version means there is nothing to publish, in the same idiom as refusing
 * to merge a conversation into itself.
 *
 * **Which of the two digests actually decides that refusal, said exactly rather than gestured at.** The
 * source text is what a version is derived from, so identical source bytes give an identical AST and the
 * conjunction collapses: in practice `source_sha256` decides. The canonical serialization is therefore
 * *not* what makes this refusal work, and a comment saying it was would be a claim nothing enforces. What
 * it makes true is the other column: `ast_sha256` is a fingerprint of the **program** rather than of its
 * formatting or of the order some editor happened to write its keys in. That is what makes the second
 * question — *"between v3 and v4, did the program change or only its text?"* — answerable from the row, and
 * it is why a reformat mints a version whose `ast_sha256` is unchanged and says so.
 *
 * ## What arrives, and why it is one field rather than two
 *
 * A caller submits `source`: the JSON text they authored. The AST is **derived** from it here. The
 * alternative — accepting an `(ast, source)` pair — admits a mismatched pair that nothing on this side can
 * detect, so the row would hold an author's record beside a program it does not describe. Deriving one from
 * the other makes correspondence a property instead of a hope. §16's YAML form arrives when a YAML parser
 * arrives in the bundle, with the same derivation.
 *
 * ## What this file does not do, stated rather than implied
 *
 * **Nothing here runs anything.** #50 owns the engine — one generic `ButlerRun extends WorkflowEntrypoint`
 * interpreting whatever `ast_json` it reads — and this Node declares no Workflow binding. A Butler that can
 * be published and not run is the correct end state for this piece, and `doctor`'s `butler_execution` check
 * says so out loud rather than leaving a reader to infer it from an absence.
 *
 * **Nothing here is reachable over HTTP.** There is deliberately no route, no CLI verb and no UI. AGENTS.md
 * calls a capability present in one channel and absent from another a parity bug; zero channels is parity,
 * and an authoring surface for a program nothing executes would advertise a capability that cannot act.
 * The channels arrive with the engine.
 *
 * **A Butler's effects pass through Layer 5, and none of that is duplicated here.** `mail.send.propose`
 * seals a manifest, which is where `policy.ts` decides, `approvals.ts` gates and `breakers.ts` trips.
 * Nothing in this file re-implements a policy check, and nothing in it may: a Butler is an author of sends,
 * not an exception to the rules about them.
 *
 * ## Authorship is `org.admin`, and the ownership model is not built
 *
 * §16 gives a Butler six ownership kinds and three of them name objects that do not exist — no `teams`
 * table, no agent delegation, no service identity. So `metadata.owner` is recorded as an opaque string and
 * the authority to write one is `org.admin`, the same authority `policy.ts` requires and for the same
 * reason: a program that proposes sends from other people's mailboxes is governance, and writing it takes
 * the authority granting access takes.
 */

export type ButlerState = "draft" | "published" | "superseded";

export interface ButlerDraft {
  butlerId: string;
  versionId: string;
  ast: Butler;
  astSha256: string;
  sourceSha256: string;
}

export interface PublishedButler {
  butlerId: string;
  versionId: string;
  version: number;
  supersededVersionId: string | null;
}

function requireAdminOrThrow(actorUserId: string): CallerError {
  return new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
    what: `${actorUserId} is not an administrator of this organization`,
    why: "a Butler proposes sends from other people's mailboxes without a person present, so writing one "
      + "takes the same authority as granting access (#39) or writing a policy (#60)",
    fix: "ask somebody who holds org.admin",
  });
}

function refuseFindings(findings: readonly Finding[]): CallerError {
  return unprocessable("E_BUTLER_DOES_NOT_CHECK", {
    what: `this Butler has ${findings.length} problem(s):\n${describeFindings(findings)}`,
    why: "a stored AST is read by the checker and by the engine, and a store that can hold a program which "
      + "does not check would make every later reader validate it again, defensively, forever",
    fix: "fix the findings above and submit again. Each one names its node",
  });
}

/**
 * Parses, checks and prices one submission.
 *
 * **The re-check at publication is not redundant.** A draft is checked when it is written and checked again
 * when it is published, and the two can legitimately disagree: the node set is a declaration in
 * `packages/butler-ast`, and a node moving from shipped to reserved — which is exactly what happened to
 * `template.render` — makes a stored draft unpublishable. Failing closed at the second gate is the only
 * behaviour that does not publish a program the current checker refuses.
 *
 * **"Prices" now means two things, and both refusals come back through this one path.** `checkButler` prices
 * the graph against one Workflow instance's subrequest pot (#54) and refuses a Butler that cannot afford to
 * run; the size bound below prices the *bytes* against the row that stores them. The cost refusal arrives as
 * an ordinary `Finding`, so it needs no code here — which is what one vocabulary for every refusal buys.
 *
 * It applies to a **draft** as well as to a publication, deliberately. AGENTS.md: a developer sees the limit
 * before they hit it. An author who saves an unaffordable Butler and is told at publication has already
 * written it; being told at the save is the earlier of the two moments this Node has.
 *
 * Both of those are claims about *this* path, so `test/butlers.test.ts` holds them here rather than in
 * `packages/butler-ast`, which has no store and no draft: a `maxItems` of 499 is refused at
 * `createButlerDraft` with its arithmetic and its 498, and 498 is stored and published. A checker whose most
 * expensive refusal never reached a caller would have satisfied every assertion in the package.
 */
async function checked(source: string): Promise<{ ast: Butler; astJson: string; digests: { ast: string; source: string } }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw unprocessable("E_BUTLER_SOURCE_NOT_JSON", {
      what: `the submitted source is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      why: "the AST is derived from the source text rather than sent beside it, so an unparseable source is "
        + "a Butler with no program",
      fix: "submit the canonical JSON form. §16's YAML form needs a parser this Node does not carry yet",
    });
  }

  const result = checkButler(parsed);
  if (!result.ok) throw refuseFindings(result.findings);

  const astJson = canonicalButlerJson(result.ast);

  /*
   * The one size bound, and it is a platform limit rather than a taste.
   *
   * Both texts live in one D1 row. `d1.max_row_bytes` is the ceiling that row cannot cross, so the sum is
   * what has to fit — and refusing here names the budget, the limit and the ask, rather than letting D1
   * refuse the INSERT with a message about a row. There is deliberately no *node count* or *string length*
   * bound anywhere in this feature: AGENTS.md's rule is that you cannot write the number, only the
   * receipt, and no measurement exists behind "a Butler may have 500 nodes".
   */
  const bytes = new TextEncoder().encode(astJson).byteLength + new TextEncoder().encode(source).byteLength;
  const limit = BUDGETS["d1.max_row_bytes"];
  if (bytes > limit) {
    throw unprocessable("E_BUDGET_EXCEEDED", {
      what: `d1.max_row_bytes=${limit}, this Butler's AST and source together are ${bytes} bytes`,
      why: "a version's canonical AST and its source text are two columns of one row, and D1 cannot store a "
        + "row above that size — so the refusal belongs here, where it can name the ask",
      fix: "split the Butler into smaller ones. receipt docs/receipts/d1-platform-limits.md",
    });
  }

  return {
    ast: result.ast,
    astJson,
    digests: { ast: await astSha256(result.ast), source: await textSha256(source) },
  };
}

function draftInsert(
  env: Env,
  orgId: string,
  butlerId: string,
  versionId: string,
  astJson: string,
  source: string,
  digests: { ast: string; source: string },
  actorUserId: string,
  at: string,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT INTO butler_versions
       (id, org_id, butler_id, version, state, ast_json, source_text, ast_sha256, source_sha256,
        created_by, created_at, published_by, published_at, superseded_at)
     VALUES (?,?,?,NULL,'draft',?,?,?,?,?,?,NULL,NULL,NULL)`,
  ).bind(versionId, orgId, butlerId, astJson, source, digests.ast, digests.source, actorUserId, at);
}

/** Creates a Butler and its first draft. Nothing is published until somebody publishes it. */
export async function createButlerDraft(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: { name: string; source: string },
): Promise<ButlerDraft> {
  if (!(await isAdmin(env, orgId, actorUserId))) throw requireAdminOrThrow(actorUserId);

  const name = input.name.trim();
  if (name.length === 0) {
    throw unprocessable("E_BUTLER_NEEDS_A_NAME", {
      what: "a Butler was submitted with no name",
      why: "the name is what somebody reads when a run is paused or a send is attributed, and "
        + "'butler btl_01J…' answers nothing",
      fix: "give the Butler a short name saying what it automates",
    });
  }

  const { ast, astJson, digests } = await checked(input.source);

  // Checked here for the message; enforced by `btl_name`. Two concurrent creations of the same name lose at
  // the UNIQUE index rather than here — worse wording, correct outcome, and the outcome is the part that
  // must not be left to a check-then-act window.
  const existing = await env.CATALOG.prepare(
    "SELECT id FROM butlers WHERE org_id = ? AND name = ? LIMIT 1",
  ).bind(orgId, name).first<{ id: string }>();
  if (existing !== null) {
    throw conflict("E_BUTLER_NAME_TAKEN", {
      what: `a Butler called ${JSON.stringify(name)} already exists`,
      why: "two programs under one name is either a duplicate somebody forgot or an edit meant for the first",
      fix: `edit ${existing.id}, or choose a different name`,
    });
  }

  const butlerId = ctx.id(ID_PREFIXES.butler);
  const versionId = ctx.id(ID_PREFIXES.butlerVersion);
  const at = new Date(ctx.now()).toISOString();

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "butler.drafted", outcome: "ok", actorUserId, subject: butlerId,
      detail: { name, versionId, astSha256: digests.ast, nodes: ast.nodes.length },
    },
    (entry) => [
      env.CATALOG.prepare(
        "INSERT INTO butlers (id, org_id, name, created_by, created_at) VALUES (?,?,?,?,?)",
      ).bind(butlerId, orgId, name, actorUserId, at),
      draftInsert(env, orgId, butlerId, versionId, astJson, input.source, digests, actorUserId, at),
      entry,
    ],
  );

  return { butlerId, versionId, ast, astSha256: digests.ast, sourceSha256: digests.source };
}

/**
 * Edits a Butler: replaces its draft, or creates one if the Butler is currently all-published.
 *
 * The old draft goes and the new one arrives in one transaction, because `btv_one_draft` permits exactly
 * one — so a delete that committed without its insert would leave a Butler that is published-only and an
 * edit that vanished. The delete is written as a predicate on the *state* rather than on a version id this
 * function happens to know, for the reason `editPolicyDraft` gives about leftover stage rows: a predicate
 * on the thing being replaced cannot miss a row somebody else created in the meantime.
 *
 * **What keeps this DELETE off published history is the `state = 'draft'` clause, and nothing else.** There
 * is deliberately no delete trigger — 0027's header argues that immutability and indestructibility are
 * different properties and that an organization-deletion path is a good widget a database-level ban would
 * trap forever — so the clause is the whole guarantee, in the same position `policy_versions` is in. It is
 * held to that by `test/node/content-deletion-world.test.ts`, which classifies this site: a second,
 * unbounded delete against this table fails that closed world rather than passing unnoticed. Said plainly
 * because the alternative is a comment naming a constraint that does not exist.
 */
export async function editButlerDraft(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  butlerId: string,
  input: { source: string },
): Promise<ButlerDraft> {
  if (!(await isAdmin(env, orgId, actorUserId))) throw requireAdminOrThrow(actorUserId);

  const butler = await env.CATALOG.prepare(
    "SELECT id FROM butlers WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, butlerId).first<{ id: string }>();
  if (butler === null) {
    throw notFound("E_NO_SUCH_BUTLER", {
      what: `${butlerId} is not a Butler in this organization`,
      why: "an edit needs something to edit",
      fix: "create the Butler first",
    });
  }

  const { ast, astJson, digests } = await checked(input.source);
  const versionId = ctx.id(ID_PREFIXES.butlerVersion);
  const at = new Date(ctx.now()).toISOString();

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "butler.drafted", outcome: "ok", actorUserId, subject: butlerId,
      detail: {
        versionId, astSha256: digests.ast, nodes: ast.nodes.length, replacedDraft: true,
      },
    },
    (entry) => [
      env.CATALOG.prepare(
        "DELETE FROM butler_versions WHERE org_id = ? AND butler_id = ? AND state = 'draft'",
      ).bind(orgId, butlerId),
      draftInsert(env, orgId, butlerId, versionId, astJson, input.source, digests, actorUserId, at),
      entry,
    ],
  );

  return { butlerId, versionId, ast, astSha256: digests.ast, sourceSha256: digests.source };
}

/**
 * Publishes a Butler's draft, which is the versioning event.
 *
 * The transaction shape is `publishPolicy`'s, and the reasoning transfers whole: `btv_version` is UNIQUE on
 * `(butler_id, version)` so two concurrent publishes cannot both take version 3, and **the supersede
 * carries the same gate as the promotion**. Without that shared predicate a publish that lost the race
 * would still supersede the live version and promote nothing — leaving the Butler with *no* published
 * version, which is an automation plane failing silently as a side effect of a conflict.
 */
export async function publishButler(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  butlerId: string,
): Promise<PublishedButler> {
  if (!(await isAdmin(env, orgId, actorUserId))) throw requireAdminOrThrow(actorUserId);

  const draft = await env.CATALOG.prepare(
    `SELECT id, source_text, ast_sha256, source_sha256 FROM butler_versions
      WHERE org_id = ? AND butler_id = ? AND state = 'draft' LIMIT 1`,
  ).bind(orgId, butlerId).first<{
    id: string; source_text: string; ast_sha256: string; source_sha256: string;
  }>();

  if (draft === null) {
    throw conflict("E_NO_BUTLER_DRAFT", {
      what: `Butler ${butlerId} has no draft to publish`,
      why: "publication is the versioning event (#49), so it needs something unpublished to publish",
      fix: "edit the Butler first; an edit produces a draft",
    });
  }

  /*
   * Fails closed against a checker that has moved since the draft was written — see `checked` — and against
   * a row whose stored digests no longer describe its own `source_text`.
   *
   * The second half is why the derived digests are compared rather than discarded. Everything after this
   * line compares *stored* digests: the no-op refusal, and the audit entry that records which program was
   * published. A row whose `ast_json` and `source_text` disagree would be frozen in that state forever, the
   * engine reading one column and a person reading the other — which is the exact failure "the AST is
   * derived from the source rather than sent beside it" was chosen to make impossible. Derivation makes
   * correspondence a property at insert; re-deriving it here makes it a property at the moment it is frozen,
   * which is the moment that matters. Nothing in this file can produce a mismatch, so this refusal is a
   * tripwire: only a direct write to a draft row reaches it.
   */
  const rechecked = await checked(draft.source_text);
  if (
    rechecked.digests.ast !== draft.ast_sha256
    || rechecked.digests.source !== draft.source_sha256
  ) {
    throw conflict("E_BUTLER_DRAFT_INCOHERENT", {
      what: `draft ${draft.id} stores digests that do not describe its own source text`
        + ` (ast ${draft.ast_sha256} vs ${rechecked.digests.ast},`
        + ` source ${draft.source_sha256} vs ${rechecked.digests.source})`,
      why: "publication freezes the AST and the source text together, so publishing a row whose two "
        + "halves disagree would freeze the disagreement — the engine would read one and a person the other",
      fix: "edit the Butler again; an edit rewrites the draft and both digests from one submission",
    });
  }

  const current = await env.CATALOG.prepare(
    `SELECT id, version, ast_sha256, source_sha256 FROM butler_versions
      WHERE org_id = ? AND butler_id = ? AND state = 'published' LIMIT 1`,
  ).bind(orgId, butlerId).first<{
    id: string; version: number; ast_sha256: string; source_sha256: string;
  }>();

  if (
    current !== null
    && current.ast_sha256 === draft.ast_sha256
    && current.source_sha256 === draft.source_sha256
  ) {
    throw conflict("E_BUTLER_UNCHANGED", {
      what: `Butler ${butlerId} draft is byte-identical to published version ${current.version}`,
      why: "publication is the versioning event, and a version representing no decision is a version a run "
        + "would bind, an audit entry would name and a reader would be asked about for no reason",
      fix: "change the program or its text, or discard the draft. Any change to the text — a reformat or a "
        + "reordering of keys — counts, and mints a version; what a reordering does not change is the "
        + "published ast_sha256, so the new version records that the program stayed the same",
    });
  }

  const version = (current?.version ?? 0) + 1;
  const at = new Date(ctx.now()).toISOString();

  const draftStillDraft =
    "EXISTS (SELECT 1 FROM butler_versions WHERE org_id = ? AND id = ? AND state = 'draft')";
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "butler.published", outcome: "ok", actorUserId, subject: butlerId,
      detail: {
        versionId: draft.id, version, astSha256: draft.ast_sha256,
        supersededVersionId: current?.id ?? null,
        // Said in the trail rather than only in a comment: publication here mints a version and nothing
        // executes it, so a reader of the audit log is not left to wonder why nothing happened next.
        runnable: false,
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE butler_versions SET state = 'superseded', superseded_at = ?
          WHERE org_id = ? AND butler_id = ? AND state = 'published' AND ${draftStillDraft}`,
      ).bind(at, orgId, butlerId, orgId, draft.id),
      env.CATALOG.prepare(
        `UPDATE butler_versions SET state = 'published', version = ?, published_by = ?, published_at = ?
          WHERE org_id = ? AND id = ? AND state = 'draft'`,
      ).bind(version, actorUserId, at, orgId, draft.id),
    ],
    {
      sql: "SELECT 1 FROM butler_versions WHERE org_id = ? AND id = ? AND state = 'draft'",
      params: [orgId, draft.id],
    },
  );

  if ((results[2]?.meta.changes ?? 0) === 0) {
    throw conflict("E_BUTLER_PUBLISH_RACED", {
      what: `draft ${draft.id} was no longer a draft when this publish committed`,
      why: "another publish of the same Butler won; nothing committed, because the promotion and the audit "
        + "entry share one transaction",
      fix: "re-read the Butler and publish again if the change is still wanted",
    });
  }

  return { butlerId, versionId: draft.id, version, supersededVersionId: current?.id ?? null };
}

/*
 * Deliberately no read accessor and no count.
 *
 * There is no channel yet (see the header), so a `butlerVersion(id)` or a `publishedButlerCount(org)` here
 * would have exactly one caller — a test — and would be a guess about the shape the engine's reads will
 * want. `doctor`'s `butler_execution` check costs zero subrequests precisely because it asks no question of
 * this table: it reports a capability gap, which varies with nothing an organization has stored.
 */
