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
 * A caller submits `source` — the text they authored — and `sourceFormat`, which is `json` or `yaml`. The
 * AST is **derived** from it here. The alternative — accepting an `(ast, source)` pair — admits a mismatched
 * pair that nothing on this side can detect, so the row would hold an author's record beside a program it
 * does not describe. Deriving one from the other makes correspondence a property instead of a hope.
 *
 * **YAML arrived in #87, and it goes one way only.** `docs/receipts/butler-source-format.md` measured the
 * parser at +246.2 KiB raw and +50.8 KiB gzip and spent it for one reason: JSON cannot hold a comment, and
 * a Butler is the only program in this system whose format forbids writing down why a step exists.
 *
 * There is **no AST-to-YAML renderer, and there must not be one.** Comments, blank lines and key order are
 * not in the AST — that is what canonicalization means — so regenerating a document from one would silently
 * delete every reason its author wrote down, on the most ordinary act there is: open, change a field, save.
 * The consequence, stated rather than found later: **§16's visual builder cannot edit a YAML Butler**, since
 * a graph editor writes an AST and writing an AST back out needs the renderer that does not exist.
 *
 * ## What this file does not do, stated rather than implied
 *
 * **Nothing here runs anything, and since #50 something else does.** The engine is `src/butler/`: one
 * generic `ButlerRun extends WorkflowEntrypoint` interpreting whatever `ast_json` this file wrote. The
 * separation is the point rather than an accident of ordering — publication is a *store* operation and a run
 * is an *execution*, and the only thing they share is the row. What that buys is visible in the engine: a
 * run binds a **version**, so a run started under v3 goes on reading v3's frozen AST while v4 is live.
 *
 * **This is reachable over HTTP now, and the paragraph that said otherwise was the landmine.** Until #83's
 * round it read *"there is deliberately no authoring route, no CLI verb and no UI — so a Butler is written by
 * whoever can write the row, which today means a migration or a test"*, and it went on being read as current
 * for as long as it stayed. `POST /api/butlers`, `PUT /api/butlers/:id/draft` and
 * `POST /api/butlers/:id/publish` are the three acts of this file, with `GET /api/butlers` and
 * `GET /api/butlers/:id` to read them and `src/client/app/screens/butlers.tsx` to drive them. The engine's
 * two read routes and its release route (`/api/butler-runs`, `POST /api/sends/:id/release`) predate them.
 *
 * The zero-channel argument it made is still the right argument — a capability in one channel and absent
 * from another is the parity bug AGENTS.md names — which is exactly why a header claiming zero channels
 * after five were built is worse than no header. `test/node/route-coverage` is what holds the routes and the
 * client to each other; nothing holds prose, so prose about what exists has to be corrected by hand and
 * this is that correction.
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
 * The formats a Butler may be authored in (#87, §16), and the reason there are exactly two.
 *
 * JSON was the only one until the parser's cost was measured — `docs/receipts/butler-source-format.md`,
 * +246.2 KiB raw and +50.8 KiB gzip — and the sentence it replaced (*"§16's YAML form arrives when a YAML
 * parser arrives in the bundle"*) was a condition with no threshold, repeated for three layers.
 *
 * This list, the `CHECK` in migration 0035 and `parseSource` below are the three places a format is named,
 * and they have to agree: a stored format with no branch is a row the publish path reads and cannot
 * re-derive. `test/butlers.test.ts` asserts the database refuses a third value, so the disagreement that
 * matters is impossible rather than merely absent.
 */
export type ButlerSourceFormat = "json" | "yaml";

const SOURCE_FORMATS: readonly ButlerSourceFormat[] = ["json", "yaml"];

/**
 * Narrows a caller's string, or refuses it.
 *
 * Refused rather than defaulted. A submission naming `"yml"` or `"YAML"` is an author who believes they are
 * writing one format while this Node parses another, and the two parsers disagree about the same bytes
 * (`{"a": 1}` is valid in both; `a: 1` is valid in one) — so a silent fallback to JSON turns a typo into a
 * refusal about syntax, pointing at the document instead of at the field that was wrong.
 *
 * An absent format is the exception and means `"json"`, because every caller written before #87 omits it and
 * every one of them meant JSON. That is the same argument 0035's `DEFAULT 'json'` makes about existing rows:
 * not a plausible guess, the truth.
 */
export function readSourceFormat(value: unknown): ButlerSourceFormat {
  if (value === undefined || value === null) return "json";
  if (SOURCE_FORMATS.includes(value as ButlerSourceFormat)) return value as ButlerSourceFormat;
  throw unprocessable("E_BUTLER_SOURCE_FORMAT_UNKNOWN", {
    what: `${JSON.stringify(value)} is not a source format this Node parses`,
    why: "the AST is derived from the source text by the named format's parser, so a format with no parser "
      + "is a Butler whose program cannot be computed — and guessing one would parse the author's document "
      + "with a grammar they did not write it in",
    fix: `submit one of: ${SOURCE_FORMATS.join(", ")}. Omitting the field means json`,
  });
}

/**
 * Text to a value, by the format the author named.
 *
 * **The YAML import is deferred, and what that buys is narrower than it looks.** esbuild does no code
 * splitting for the Workers target, so `await import("yaml")` is inlined into the one `index.js` and wrapped
 * in its `__esm` lazy-init idiom — the bytes ship whatever this line says. What is actually deferred is the
 * module's *top-level* work: building `yaml`'s schema tables, resolvers and stringifier. An inbound message
 * is the hot path, it runs on every delivery, and it never authors a Butler — so it never pays for them. The
 * receipt states this in the same words, because "dynamically imported, so it is off the hot path" is the
 * sentence a reader will assume and it is false about the bytes.
 *
 * **`maxAliasCount` is the one bound YAML needs and JSON does not.** `checked` prices the stored text
 * against `d1.max_row_bytes` *after* this returns, which is sufficient for JSON — `JSON.parse` cannot
 * produce more output than it was given — and insufficient here, because alias expansion is amplification.
 * A few hundred bytes of anchors can expand past the 128 MB memory limit before any byte count is reached,
 * so the guard has to be inside the parse or it is not a guard.
 *
 * **Deleting the option changes nothing observable, and it is kept anyway — here is the argument.** `yaml`
 * 2.9's own default is 100, the number the receipt carries, so no test in this repository can tell
 * `parse(source, { maxAliasCount: 100 })` from `parse(source)`. This repository has twice deleted a defence
 * in exactly that position (`MAX(version) + 1`, the redemption CAS) on the grounds that one enforcement
 * beats two when nothing can check the second. This is not that: it is not a second enforcement of a rule
 * this Node already makes, it is the *only* thing that makes `butler.yaml_max_alias_count` true. Without
 * this argument the receipt would be documenting a dependency's default under Mailda's own namespace — a
 * number that moves when somebody runs `pnpm update`, with a receipt still claiming Mailda chose it.
 * `test/butlers.test.ts` pins the literal 100 against the budget so a change to either names the other.
 *
 * The two refusals are separate codes rather than one because the caller already knows which format they
 * submitted, and a message naming that format is the difference between "your document is broken" and "your
 * document is broken *as YAML*" — which is the actual answer when somebody pastes JSON into a YAML field
 * and it very nearly works.
 */
async function parseSource(source: string, format: ButlerSourceFormat): Promise<unknown> {
  if (format === "json") {
    try {
      return JSON.parse(source);
    } catch (error) {
      throw unprocessable("E_BUTLER_SOURCE_NOT_JSON", {
        what: `the submitted source is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        why: "the AST is derived from the source text rather than sent beside it, so an unparseable source "
          + "is a Butler with no program",
        fix: "submit the canonical JSON form, or submit YAML with source_format: yaml",
      });
    }
  }

  const { parse } = await import("yaml");
  try {
    return parse(source, { maxAliasCount: BUDGETS["butler.yaml_max_alias_count"] });
  } catch (error) {
    throw unprocessable("E_BUTLER_SOURCE_NOT_YAML", {
      what: `the submitted source is not YAML: ${error instanceof Error ? error.message : String(error)}`,
      why: "the AST is derived from the source text rather than sent beside it, so an unparseable source is "
        + "a Butler with no program. An alias-count refusal is this Node's bound rather than the format's: "
        + `butler.yaml_max_alias_count=${BUDGETS["butler.yaml_max_alias_count"]}, because alias expansion `
        + "amplifies and the byte limit is checked after the parse",
      fix: "fix the YAML above, or submit the canonical JSON form with source_format: json. receipt "
        + "docs/receipts/butler-source-format.md",
    });
  }
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
async function checked(
  source: string,
  format: ButlerSourceFormat,
): Promise<{ ast: Butler; astJson: string; digests: { ast: string; source: string } }> {
  const parsed = await parseSource(source, format);

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
  format: ButlerSourceFormat,
  digests: { ast: string; source: string },
  actorUserId: string,
  at: string,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT INTO butler_versions
       (id, org_id, butler_id, version, state, ast_json, source_text, source_format, ast_sha256,
        source_sha256, created_by, created_at, published_by, published_at, superseded_at)
     VALUES (?,?,?,NULL,'draft',?,?,?,?,?,?,?,NULL,NULL,NULL)`,
  ).bind(
    versionId, orgId, butlerId, astJson, source, format, digests.ast, digests.source, actorUserId, at,
  );
}

/** Creates a Butler and its first draft. Nothing is published until somebody publishes it. */
export async function createButlerDraft(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: { name: string; source: string; sourceFormat?: ButlerSourceFormat },
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

  const format = readSourceFormat(input.sourceFormat);
  const { ast, astJson, digests } = await checked(input.source, format);

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
      draftInsert(
        env, orgId, butlerId, versionId, astJson, input.source, format, digests, actorUserId, at,
      ),
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
  input: { source: string; sourceFormat?: ButlerSourceFormat },
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

  const format = readSourceFormat(input.sourceFormat);
  const { ast, astJson, digests } = await checked(input.source, format);
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
      draftInsert(
        env, orgId, butlerId, versionId, astJson, input.source, format, digests, actorUserId, at,
      ),
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
    `SELECT id, source_text, source_format, ast_sha256, source_sha256 FROM butler_versions
      WHERE org_id = ? AND butler_id = ? AND state = 'draft' LIMIT 1`,
  ).bind(orgId, butlerId).first<{
    id: string; source_text: string; source_format: ButlerSourceFormat;
    ast_sha256: string; source_sha256: string;
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
   *
   * **The format comes from the row, and getting that wrong would have been the whole defect #87 could
   * introduce.** Re-deriving with a hard-coded `"json"` would refuse every YAML draft here — the AST would
   * differ or the parse would fail, and the caller would be told their *digests* disagree with their source
   * when what actually disagreed was this Node with itself. The stored format is part of what a version is,
   * which is also why 0035 freezes it.
   */
  const rechecked = await checked(draft.source_text, draft.source_format);
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
    `SELECT id, version, source_format, ast_sha256, source_sha256 FROM butler_versions
      WHERE org_id = ? AND butler_id = ? AND state = 'published' LIMIT 1`,
  ).bind(orgId, butlerId).first<{
    id: string; version: number; source_format: ButlerSourceFormat;
    ast_sha256: string; source_sha256: string;
  }>();

  /*
   * The format joins the two digests in deciding "nothing changed", and the case is narrow enough to be
   * worth naming rather than leaving to be discovered.
   *
   * YAML 1.2 is a superset of JSON, so `{"steps":[]}` is valid in both and hashes the same either way. An
   * author converting a Butler from JSON to YAML *starts* by changing only the field — same bytes, same AST,
   * same both digests — and without this clause that publish is refused as a no-op. It is not one: the
   * version's record of how it was written is what the next editor reads, and the conversion is the act.
   * Adding the format here is also what makes it worth freezing in 0035, since a value that no publish can
   * change is a value nothing needs a trigger to protect.
   */
  if (
    current !== null
    && current.ast_sha256 === draft.ast_sha256
    && current.source_sha256 === draft.source_sha256
    && current.source_format === draft.source_format
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

  /*
   * The next number is the live version's plus one, and that is correct **because 0033 makes the live
   * version the highest one**.
   *
   * It was not always. 0027's `btv_forward_only` comment credited `btv_live` with preventing two live
   * versions of one Butler, and `btv_live` is a plain index on `org_id` — it prevented nothing, so only this
   * transaction stood in the way, and a transaction governs only the writes that go through it. Given a
   * published v1 beside a published v2, the read above returned v1 with `LIMIT 1` and no `ORDER BY`, this
   * computed 2, and `btv_version` rejected it — as an unhandled D1 constraint error and a **500**, not a
   * refusal anybody could act on. Found by clicking publish twice.
   *
   * `MAX(version) + 1` was written here first and then removed, which is worth recording rather than
   * quietly reverting: with `btv_one_live` there can be no live version that is not the highest, so `MAX`
   * cannot differ from this — a mutation test could not tell the two apart, and it costs a second D1 round
   * trip on every publish. One enforcement in the right place beats two, one of which nothing can check.
   */
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
        /*
         * What will fire it, in the entry for the act that made it live.
         *
         * This field was `runnable: false` until #50, which was true and is now a lie in the one table that
         * must not hold one. The honest replacement is not `runnable: true` — a field whose only value is
         * `true` is the placeholder shape `placeholder-columns.test.ts` exists to catch, one layer along —
         * but the *trigger*, which is what a reader of the trail actually wants next: this version is live,
         * and here is the mail that will start it.
         */
        trigger: { event: rechecked.ast.trigger.event, mailbox: rechecked.ast.trigger.mailbox },
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
