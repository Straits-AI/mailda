import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A closed world over every call site in this Worker that can destroy content — and, for the ones that can,
 * an assertion that the legal hold is consulted **in the same function** (#64).
 *
 * It also owns the two writes that decide whether a hold means anything: the single `UPDATE holds` that lifts
 * one, and the single `INSERT INTO approvals` that says what an approval is about. Both live here rather than
 * beside the feature because both are *closed-world* claims — "there is exactly one of these, and it is the
 * one that carries the guard" — which is the shape this file exists for.
 *
 * ## Why the tripwire is worth more than the mechanism
 *
 * `src/holds.ts` refuses a deletion when a hold covers it. That is only as good as the set of call sites that
 * call it, and a set maintained by remembering is the landmine AGENTS.md describes: correct on the day it is
 * written, with nothing to notice when it stops being. The failure is silent in the permissive direction — a
 * new `DELETE FROM` simply destroys held mail — and no amount of testing the hold mechanism finds it.
 *
 * This repository has now paid for that pattern four times. `cost-meter-coverage.test.ts` exists because the
 * cost meter *documented* the bindings it did not price. #67 is a comment that said a draft body was "left for
 * the reconciler" over a reconciler that never listed the prefix. #70 compared against a check name nothing
 * emitted. #71 is a hardcoded list of five block types under a comment claiming it read them from the config —
 * inside the test written to close the pattern. So this file **derives** its left-hand side from the source
 * and only the classification is written down.
 *
 * ## The world
 *
 * Every match of `DELETE FROM <table>` or `EVIDENCE.delete` in `src/` must appear in `SITES` below with its
 * target and whether that target carries content. A site marked `content: true` must name a guard, and the
 * guard's identifier has to appear **between the start of the enclosing function and the destroying line** —
 * so it is asserted rather than hoped for, and so a guard that drifted into a neighbouring function fails.
 *
 * An unlisted site fails. A listed site nothing matches fails too, in the other direction: a stale entry reads
 * as coverage of something that is not there and hides the fact that its replacement was never classified.
 *
 * ## `migrations/` is in the scan, and its rule is stricter
 *
 * A migration is raw SQL applied through `batch()`. **There is no way for one to consult a hold** — no Worker
 * code runs between the statements — so a destructive migration cannot be classified as guarded, only as
 * forbidden. The rule is therefore zero matches, and the moment one is genuinely needed this test is where the
 * decision gets made rather than the place it slipped past.
 *
 * `DROP TABLE` and `DROP COLUMN` are scanned there as well, because either destroys content and #10's
 * expand/contract rule already requires a bookmark gate in front of one. `DROP INDEX` is deliberately **not**
 * scanned: an index carries no content, and `0013_delivery_is_the_unit.sql` legitimately drops one — counted,
 * not assumed, and asserted below so that "migrations are clean" cannot be read as "migrations contain no
 * DROP at all", which is false.
 *
 * ## What this deliberately does not catch, stated because a tripwire that hides its boundary is the thing
 * it replaces
 *
 * - **Dynamically constructed SQL.** A query assembled from fragments, or a table name interpolated into a
 *   template, is invisible to a regex. Nothing in `src/` does this today (the scan finds a literal table name
 *   at every match, which is asserted below), and a site that started to would go unseen here.
 * - **`wrangler d1 execute`, and the Cloudflare dashboard.** Anything done outside the product entirely. This
 *   is not fixable from inside a Worker at all: the customer owns the database, which is the premise (ADR 2).
 * - **Whether the guard is reached on every branch.** The check is lexical: the identifier appears before the
 *   destroying line in the same function. A guard behind an `if` that can be false would pass here. The
 *   behavioural half lives in `test/legal-hold.test.ts`, which deletes real rows against real holds.
 * - **`test/`.** Fixtures clear tables between cases, which is not a product path, and scanning them would
 *   force an allowlist that grows with every fixture and stops meaning anything. Same reasoning as
 *   `placeholder-columns.test.ts`.
 */

const workerDir = join(import.meta.dirname, "..", "..");

/** What a declared site is: where it is, what it destroys, and whether that thing carries content. */
interface Site {
  /** Path relative to the worker directory. */
  file: string;
  /** The table, or `r2:evidence-object` for the one R2 delete. */
  target: string;
  content: boolean;
  /**
   * The identifier that must appear before the destroying line, in the same function. Required when
   * `content` is true, and meaningless otherwise.
   */
  guard?: string;
  /** Why this classification. Read during review, which is what makes a seven-row table worth having. */
  why: string;
}

/**
 * #64's classification, one row per call site.
 *
 * The judgement call is `merge.ts`. The merged messages survive; what `DELETE FROM cases` destroys is the
 * source case's **history** — who held it, when it was first responded to, whether its target was met — which
 * is exactly the class of fact an investigation asks about. So it is held.
 *
 * The reconciler is content-carrying for the plainest possible reason: its `EVIDENCE.delete` is the only call
 * in the product that destroys content *bytes*. Its guard is `anyActiveHold` rather than `assertNotHeld`
 * because an orphan is unattributable **by definition** — the pass finds it because its receipt is missing —
 * so there is no mailbox to test a hold against, and any hold anywhere suppresses collection org-wide.
 */
const SITES: Site[] = [
  {
    file: "src/invitations.ts",
    target: "invitations",
    content: false,
    why: "An unredeemed invitation, withdrawn because a second was minted for the same address (#83). It is "
      + "a bearer credential and nothing else — no message, no attribution, no decision. Deleting one "
      + "destroys the ability to join, which is the point of re-minting, and the two access.invited entries "
      + "in the audit chain are what record that it happened. A redeemed row is never matched: the write "
      + "path only ever deletes where redeemed_at IS NULL.",
  },
  {
    file: "src/auth/session.ts",
    target: "login_attempts",
    content: false,
    why: "Failed-sign-in counters, cleared on a successful sign-in. Timing and an email address, no content.",
  },
  {
    file: "src/auth/session.ts",
    target: "refresh_tokens",
    content: false,
    why: "Expired session credentials. Deleting one destroys the ability to sign in, not a record of anything.",
  },
  {
    file: "src/access.ts",
    target: "relationship_tuples",
    content: false,
    why: "A revoked grant. The act is audited as access.revoked, and the tuple carried no mail.",
  },
  {
    file: "src/audit.ts",
    target: "log_entries",
    content: false,
    why:
      "The operational log, trimmed by design at log.retained_entries. Its `detail` is documented in " +
      "0008_audit.sql as never content and never a credential, which is what makes trimming it safe — and " +
      "`audit_entries` is deliberately absent from this whole table, because nothing trims the audit trail.",
  },
  {
    file: "src/drafts.ts",
    target: "drafts",
    content: true,
    guard: "assertNotHeld",
    why: "A draft is a message before it becomes one, addressed from a mailbox (ADR 36), so it is coverable.",
  },
  {
    file: "src/policy.ts",
    target: "policy_versions",
    content: false,
    why:
      "The delete only ever removes a **draft**, in the same transaction that inserts its replacement — " +
      "`pv_one_draft` permits exactly one, so editing is delete-then-insert rather than an update of a " +
      "frozen row. A draft carries no mail and no message: it is an outcome and five conditions, none of " +
      "which is customer content, and it is not consulted by evaluation, so destroying one cannot destroy " +
      "any record of a decision. Published and superseded versions are what a send binds and what an " +
      "investigation would ask about, and nothing in this Worker deletes those — the `state = 'draft'` " +
      "clause in the SQL is what makes that a property rather than a promise.",
  },
  {
    file: "src/policy.ts",
    target: "policy_stages",
    content: false,
    why:
      "The stages of the **draft** being replaced, deleted in the same transaction that inserts the new "
      + "draft's — the delete is bounded by a subquery on `state = 'draft'`, exactly like the "
      + "`policy_versions` delete above it and for the same reason. A stage row is an ordinal and a count of "
      + "required approvers: no mail, no message, and not consulted by evaluation. A published version's "
      + "stages are what an approval freezes a copy of, and nothing in this Worker deletes those.",
  },
  {
    file: "src/butlers.ts",
    target: "butler_versions",
    content: false,
    why:
      "The delete only ever removes a **draft**, in the same transaction that inserts its replacement — "
      + "`btv_one_draft` permits exactly one, so editing is delete-then-insert rather than an update of a "
      + "frozen row, exactly as `policy_versions` above. A draft carries no mail and no message: it is a "
      + "program and the text somebody typed, and nothing executes it. Published and superseded versions "
      + "are what a run would bind and what an audit entry names, and the `state = 'draft'` clause in the "
      + "SQL is what keeps them out of reach — deliberately a clause rather than a trigger, because "
      + "0027's header explains that immutability and indestructibility are different properties and a "
      + "database-level delete ban would be a tripwire an organization-deletion path is entitled to hit.",
  },
  {
    file: "src/teams.ts",
    target: "team_members",
    content: false,
    why:
      "A membership, removed by an administrator (#73). It carries no mail and no message: it is a person and "
      + "a team, and what the row conferred was **authority**, not evidence — so removing it withdraws access "
      + "rather than destroying a record of anything. The act itself is preserved where records belong: "
      + "`team.member_removed` rides in the same transaction, names the person, the team and how many members "
      + "are left, and audit entries are never trimmed. This is `relationship_tuples` two entries up, reached "
      + "through the other door into the same authority.",
  },
  {
    file: "src/merge.ts",
    target: "cases",
    content: true,
    guard: "assertNotHeld",
    why:
      "The merged messages survive; the source case's history does not — who held it, when it was first " +
      "answered, whether its target was met. #64 classified this content-carrying on that basis.",
  },
  {
    file: "src/reconcile.ts",
    target: "r2:evidence-object",
    content: true,
    guard: "anyActiveHold",
    why:
      "The only call in the product that destroys content bytes, and it stayed one call when #67 gave the " +
      "pass a second prefix: raw orphans and stranded draft bodies are found by different referent rules " +
      "and collected by the same loop, so this allowlist did not have to grow. Guarded org-wide rather " +
      "than per-hold: an object with no referent is unattributable by definition, so nothing can prove one " +
      "is not responsive.",
  },
];

/** Every `.ts` under a directory, recursively, excluding declaration files. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(workerDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

interface Match {
  file: string;
  /** 1-indexed, so a failure message points at something a reader can open. */
  line: number;
  target: string;
  /** The whole line, for the failure message. */
  text: string;
}

/**
 * Whether a line is prose rather than code.
 *
 * Line-prefix based, and the direction it errs in is the safe one: a trailing comment on a code line is still
 * scanned, so a *reported* site can be one nobody calls, but a real call can never hide by being on a line
 * that starts with a comment marker unless somebody writes executable code after `*`. Four doc comments in
 * `src/` discuss `DELETE FROM drafts` and `EVIDENCE.delete` by name — `doctor.ts`, `drafts.ts`,
 * `reconcile.ts` — and every one of them would otherwise be reported as a call site in a file that has none.
 */
function isProse(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")
    || trimmed.startsWith("--");
}

/** Every content-destroying call site the source actually contains. */
function matchesIn(files: string[], patterns: RegExp[]): Match[] {
  const found: Match[] = [];
  for (const file of files) {
    const lines = readFileSync(join(workerDir, file), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (isProse(text)) return;
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          found.push({
            file,
            line: index + 1,
            // `undefined` cannot happen for `DELETE FROM (\w+)`; the R2 pattern has no group and names its
            // own target. A missing group would surface as an unclassified target, never as a silent pass.
            target: match[1] ?? "r2:evidence-object",
            text: text.trim(),
          });
        }
      }
    });
  }
  return found;
}

const SQL_DELETE = /\bDELETE\s+FROM\s+([a-z_]+)/gi;
const R2_DELETE = /\bEVIDENCE\.delete\b/g;
const SQL_DROP = /\bDROP\s+(?:TABLE|COLUMN)\b/gi;

const srcMatches = matchesIn(sourceFiles("src"), [SQL_DELETE, R2_DELETE]);

/**
 * The enclosing top-level function of a line: the nearest preceding `function` declaration.
 *
 * Approximate on purpose, and sufficient because every site in `SITES` sits inside a top-level `function`.
 * If a destroying call ever moves into a class method or a bare arrow, the search reaches the wrong function
 * and the guard check fails — which is the direction to fail in, and the point at which this should learn
 * about the new shape rather than quietly widen its window.
 */
function enclosingFunction(lines: string[], lineNumber: number): { start: number; name: string } | null {
  for (let index = lineNumber - 1; index >= 0; index--) {
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(lines[index] ?? "");
    if (declaration !== null) return { start: index + 1, name: declaration[1]! };
  }
  return null;
}

function keyOf(site: { file: string; target: string }): string {
  return `${site.file} -> ${site.target}`;
}

/**
 * The SQL of the statement on one line, with its `${…}` holes filled in — and nothing else around it.
 *
 * Written because the alternative was measured and found vacuous: a check made against a *window of the
 * enclosing function* is satisfied by that function's own comments and by constants its other branches use,
 * so `expect(body).toContain("lifted_at IS NULL")` passed with the clause deleted from the statement. A
 * tripwire that a doc comment can satisfy protects the comment.
 *
 * The statement is the string literal the match sits inside — backtick or double-quoted, found by walking
 * out from the match to the nearest delimiter on each side. A `${ident}` hole is replaced by the string
 * `const ident = "…"` assigns in the same file; a hole naming something this cannot resolve is left in place,
 * which fails the caller's `toContain` rather than passing it. That direction is the point: a predicate
 * assembled from something the scan cannot read is one it cannot vouch for.
 */
function resolvedStatementAt(source: string, lineNumber: number, pattern: RegExp): string {
  const lines = source.split("\n");
  const offset = lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0);
  const column = pattern.exec(lines[lineNumber - 1] ?? "")?.index ?? -1;
  if (column < 0) return "";
  const at = offset + column;

  const open = Math.max(source.lastIndexOf("`", at), source.lastIndexOf('"', at));
  if (open < 0) return "";
  const delimiter = source[open]!;
  const close = source.indexOf(delimiter, at);
  if (close < 0) return "";
  const raw = source.slice(open + 1, close);

  return raw.replaceAll(/\$\{(\w+)\}/g, (whole, name: string) => {
    // One alternative per delimiter rather than a back-referenced character class, because the SQL these
    // constants hold contains the *other* quote — `state = 'approved'` inside a double-quoted string — and a
    // class excluding all three stopped at it and resolved to nothing. Which is how a hole that could not be
    // read would have read as satisfied if this returned "" instead of leaving the hole in place.
    const declared = new RegExp(
      `\\b(?:const|let)\\s+${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`,
    ).exec(source);
    return declared === null ? whole : (declared[1] ?? declared[2] ?? declared[3] ?? whole);
  });
}

describe("the closed world over content-destroying call sites", () => {
  it("finds the sites, so nothing below can pass by scanning nothing", () => {
    // The vacuous-green failure mode `placeholder-columns.test.ts` names. If the scanner broke, every
    // assertion here would pass against an empty set. Anchors, not the set under test.
    expect(srcMatches.length).toBeGreaterThanOrEqual(6);
    expect(srcMatches.map(keyOf)).toContain("src/drafts.ts -> drafts");
    expect(srcMatches.map(keyOf)).toContain("src/reconcile.ts -> r2:evidence-object");
  });

  it("has exactly one R2 delete, which is the property this allowlist protects", () => {
    // #67 gave the reconciler a second prefix — `${orgId}/drafts/`, whose referent is a `drafts` row rather
    // than a receipt — and it deliberately did **not** give it a second delete: both scans fill one list and
    // one loop drains it. "The R2 delete site stays at one" was a claim in three comments and in
    // `evidence-lifecycle.md`, and nothing checked it. It does now.
    //
    // A second delete would not necessarily be *unguarded* — one inside `reconcileEvidence` would pass the
    // guard check below — so this is not redundant with it. What it protects is the reason the guard is
    // cheap to keep true: one line to reason about, in one function, rather than a set somebody maintains.
    const r2 = srcMatches.filter((match) => match.target === "r2:evidence-object");
    expect(
      r2.length === 1 ? null
        : `${r2.length} R2 delete call site(s): ${r2.map((m) => `${m.file}:${m.line}`).join(", ")}. `
          + "The product has exactly one call that destroys content bytes and every claim about the legal "
          + "hold's byte-level surface rests on that. If a second one is genuinely needed, it is a #64 "
          + "decision — classify it above, guard it, and rewrite the claims in reconcile.ts, drafts.ts and "
          + "docs/evidence-lifecycle.md that say there is one",
    ).toBeNull();
  });

  it("skips prose, so a comment discussing a delete is not reported as one", () => {
    // Four doc comments in `src/` name these patterns. `doctor.ts` has no delete in it at all, so it
    // appearing here would mean the classification table had to gain a row for a file that destroys nothing —
    // which is how a closed world becomes noise and then becomes ignored.
    expect(srcMatches.map((match) => match.file)).not.toContain("src/doctor.ts");
    expect(isProse(" * `deleteDraft` issues one DELETE FROM drafts and touches R2 not at all")).toBe(true);
    expect(isProse('    "DELETE FROM drafts WHERE org_id = ?",')).toBe(false);
  });

  it("classifies every call site that exists", () => {
    const declared = new Set(SITES.map(keyOf));
    const unclassified = srcMatches
      .filter((match) => !declared.has(keyOf(match)))
      .map((match) => `${match.file}:${match.line}  ${match.text}`);

    // If this fails, a new content-destroying call site arrived. Decide, in SITES above: does what it
    // destroys carry content? If it does, it must call the legal hold and name the guard here. Do not delete
    // the row to make this pass — that is the failure this file exists to make impossible.
    expect(
      unclassified.length === 0 ? null
        : `${unclassified.length} content-destroying call site(s) are not classified in `
          + `test/node/content-deletion-world.test.ts:\n  ${unclassified.join("\n  ")}`,
    ).toBeNull();
  });

  it("declares no site that no longer exists", () => {
    const live = new Set(srcMatches.map(keyOf));
    const stale = SITES.map(keyOf).filter((key) => !live.has(key));
    // The same landmine pointing the other way: a stale row reads as coverage of something absent, and hides
    // that whatever replaced it was never classified.
    expect(stale).toEqual([]);
  });

  it("names a guard on every content-carrying site, and no guard where there is no content", () => {
    const wrong = SITES.filter((site) => site.content === (site.guard === undefined))
      .map((site) => keyOf(site));
    expect(
      wrong.length === 0 ? null
        : `${wrong.join(", ")}: a content-carrying site must name the guard it calls, and a site that `
          + "carries no content must not name one — an unused guard reads as protection that is not there",
    ).toBeNull();
  });

  it("calls the guard in the same function as the destroying statement", () => {
    const unguarded: string[] = [];
    for (const site of SITES.filter((candidate) => candidate.content)) {
      const lines = readFileSync(join(workerDir, site.file), "utf8").split("\n");
      for (const match of srcMatches.filter((candidate) => keyOf(candidate) === keyOf(site))) {
        const enclosing = enclosingFunction(lines, match.line);
        if (enclosing === null) {
          unguarded.push(`${site.file}:${match.line} is not inside a top-level function, so this guard `
            + "cannot tell what protects it");
          continue;
        }
        const body = lines.slice(enclosing.start - 1, match.line).join("\n");
        if (!body.includes(`${site.guard}(`)) {
          unguarded.push(`${site.file}:${match.line} destroys ${site.target} inside `
            + `${enclosing.name}(), which does not call ${site.guard}() before it`);
        }
      }
    }
    // This is the assertion #64 said was worth more than the mechanism. A hold that a call site forgets to
    // ask is not a hold.
    expect(unguarded.length === 0 ? null : unguarded.join("; ")).toBeNull();
  });

  it("reads a literal table name at every site, which is what makes the scan possible", () => {
    // The blind spot named in the header, asserted rather than assumed: dynamically built SQL is invisible
    // here, and this is what tells us none exists yet. A target that is not snake_case means the regex
    // matched an interpolation, so the scan has started missing things.
    const odd = srcMatches
      .filter((match) => match.target !== "r2:evidence-object" && !/^[a-z][a-z_]*$/.test(match.target))
      .map((match) => `${match.file}:${match.line} -> ${match.target}`);
    expect(odd).toEqual([]);
  });

  it("has exactly one lift path, and it is the gated one", () => {
    /*
     * **This test was inverted, not deleted, and that distinction is the whole point.**
     *
     * It used to require *zero* `UPDATE holds` in `src/`, because there was no lift and the quiet way to
     * undo that decision was to edit a hold's bounds: an `UPDATE holds SET to_date = …` releases mail from
     * a hold without deleting anything, without two approvers and without an audit action existing to
     * record it. #64 has now built the loud lift — dual control, a mandatory reason, `hold.lifted` — and
     * **the silent one is exactly as available as it was before**. Deleting the guard because the feature
     * arrived is how the guard's point is lost.
     *
     * So the rule is now "one, and it is that one" rather than "none":
     *
     *   - exactly one `UPDATE holds` in the whole of `src/`;
     *   - it sets `lifted_at`, which is what makes it the lift rather than a window edit;
     *   - **that statement's own SQL** carries the approval gate, so no lift lands without two distinct
     *     people having approved (`state = 'approved'`) and without the hold being unlifted.
     *
     * ## The assertions are made against the statement, not against the function around it
     *
     * That is the correction of a live defect in this test, and it is worth stating rather than fixing
     * quietly. The three checks below used to read a window of the enclosing function *including its
     * comments* — so the doc comment above the statement, which names `lifted_at IS NULL` while explaining
     * why it is there, satisfied the check for `lifted_at IS NULL`; and `state = 'approved'` was satisfied
     * by the `const approved = …` the **send** branch of the same function uses. Both mutations were run:
     * deleting `AND EXISTS (${approved})` from the lift, and deleting `AND lifted_at IS NULL` from it, and
     * this test passed for both. A guard a comment can satisfy is the exact defect this repository keeps
     * finding, and it is worse in a tripwire than anywhere else, because a tripwire is the thing nobody
     * re-derives.
     *
     * So the statement's SQL is extracted from its own string literal and its `${…}` holes are resolved
     * against the `const` they name — an unresolvable hole fails rather than passes, because a predicate
     * assembled from something this scan cannot read is a predicate it cannot vouch for.
     *
     * Lexical, with the same boundary as the guard check above: it reads the source, not the behaviour.
     * `test/legal-hold.test.ts` is the behavioural half — a deletion refused under a hold, the hold lifted
     * by two people, the same deletion succeeding.
     */
    const writes = sourceFiles("src")
      .flatMap((file) => readFileSync(join(workerDir, file), "utf8").split("\n")
        .map((text, index) => ({ file, line: index + 1, text }))
        .filter((row) => !isProse(row.text) && /\bUPDATE\s+holds\b/i.test(row.text)));

    expect(
      writes.length === 1 ? null
        : `${writes.length} UPDATE holds statement(s) in src/ `
          + `(${writes.map((row) => `${row.file}:${row.line}`).join(", ") || "none"}). There must be exactly `
          + "one and it must be the lift: narrowing a hold's window is a silent lift, and #64 requires two "
          + "distinct approvers plus a mandatory reason. If a second write to this table is genuinely "
          + "needed, it is a #64 decision — not a line added quietly",
    ).toBeNull();

    const site = writes[0]!;
    const source = readFileSync(join(workerDir, site.file), "utf8");
    const lines = source.split("\n");
    const enclosing = enclosingFunction(lines, site.line);
    expect(enclosing, `${site.file}:${site.line} is not inside a top-level function`).not.toBeNull();

    const sql = resolvedStatementAt(source, site.line, /\bUPDATE\s+holds\b/i);
    // Anti-vacuity: an extractor that returned "" or lost the statement would pass every check below. This
    // is the assertion that the thing being scanned is the statement.
    expect(sql, `the SQL of ${site.file}:${site.line} could not be read`).toMatch(/\bUPDATE\s+holds\b/i);

    // The statement is the lift. A statement that touched any other column would be the silent lift wearing
    // the one write this test allows.
    expect(sql, `${site.file}:${site.line} writes to a hold without setting lifted_at`)
      .toMatch(/lifted_at\s*=/);
    // And it is gated, in its own predicate. Both halves: two distinct people approved (the approval reached
    // `approved`, which only the completion predicate can do), and the hold has not already been lifted.
    expect(sql, `${site.file}:${site.line} lifts a hold without requiring an approved approval`)
      .toContain("state = 'approved'");
    expect(sql, `${site.file}:${site.line} could lift an already-lifted hold`)
      .toContain("lifted_at IS NULL");
  });

  it("writes an approval from one place, and only with a subject kind it declares", () => {
    /*
     * The same argument as the `INSERT INTO holds` guard below, for the column that decides which subject an
     * approval is about.
     *
     * `approvals.subject_kind` carries **no CHECK constraint** — SQLite cannot add one with `ALTER TABLE`,
     * and a trigger cannot exist in this tree because `src/migrate.ts` splits migrations on semicolons — so
     * migration 0021 had to give it a `DEFAULT 'send_manifest'` to satisfy the grammar. That default is the
     * hazard: an INSERT that forgot the column would silently classify a hold lift as a send approval, and
     * the lift would be an approval nothing knows how to complete.
     *
     * Two assertions close it. One writer, so there is one place to read; and every subject-kind literal in
     * `src/` is one `APPROVAL_SUBJECT_KINDS` declares, so a third kind cannot arrive without the union that
     * `decideApproval` switches on learning about it.
     */
    const writers = sourceFiles("src").filter(
      (file) => /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+approvals\b/i.test(readFileSync(join(workerDir, file), "utf8")),
    );
    expect(
      writers.join(", ") === "src/approvals.ts" ? null
        : `approvals is written from ${writers.length === 0 ? "nowhere" : writers.join(", ")}, and it must be `
          + "written only from src/approvals.ts: subject_kind has a column default, so a writer that omitted "
          + "it would file its approval under the wrong kind and nothing would notice",
    ).toBeNull();

    const source = readFileSync(join(workerDir, "src", "approvals.ts"), "utf8");

    // The one INSERT names the column. This is the assertion the `DEFAULT 'send_manifest'` in migration 0021
    // rests on: a writer that omitted `subject_kind` would file a hold lift as a send approval, silently, and
    // the lift would be an approval nothing knows how to complete. The default exists because SQLite cannot
    // add a NOT NULL column without one, not to classify anything.
    const insert = /INSERT INTO approvals\s*\(([^)]*)\)/.exec(source);
    expect(insert, "the INSERT INTO approvals column list could not be read").not.toBeNull();
    expect(
      insert?.[1],
      "the one INSERT INTO approvals must name subject_kind — otherwise the column default decides, and a "
        + "default is not a classification",
    ).toContain("subject_kind");

    const declared = [...(/APPROVAL_SUBJECT_KINDS = \[([^\]]*)\]/.exec(source)?.[1] ?? "")
      .matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
    // Anti-vacuity: if the extractor stops finding the union, every check below passes against an empty set.
    expect(declared).toContain("send_manifest");
    expect(declared).toContain("hold_lift");

    const used = new Set<string>();
    for (const file of sourceFiles("src")) {
      const text = readFileSync(join(workerDir, file), "utf8");
      for (const match of text.matchAll(/subject_kind\s*=\s*'([a-z_]+)'/g)) used.add(match[1]!);
      for (const match of text.matchAll(/subjectKind:\s*"([a-z_]+)"/g)) used.add(match[1]!);
    }
    // Anti-vacuity again: the SQL form appears in `approvals.ts` and `dispatch.ts`, the object form in
    // `manifest.ts` and `holds.ts`. An empty set here would mean the scan, not the source, changed.
    expect(used.size).toBeGreaterThanOrEqual(2);
    expect(
      [...used].filter((kind) => !declared.includes(kind)),
      "a subject kind used in src/ that APPROVAL_SUBJECT_KINDS does not declare — nothing in the database "
        + "constrains this column, so this test is the constraint",
    ).toEqual([]);
  });

  it("is written from one place, which is what makes the lexical comparison sound", () => {
    // `coveringHolds` compares bounds as **strings**, and says the comparison is sound "only because every
    // bound written through `placeHold` is a full ISO-8601 instant … `normaliseBound` is what makes that true;
    // nothing else may write this table." That last clause was a claim with nothing behind it. A second
    // `INSERT INTO holds` anywhere would be free to store a bare `2026-08-31`, which sorts below everything
    // that happened during 31 August — a hold reporting as active while covering nothing, the one error class
    // #64 says this mechanism may not make. So the claim is now the assertion.
    const writers = sourceFiles("src")
      .filter((file) => /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+holds\b/i.test(readFileSync(join(workerDir, file), "utf8")));
    expect(
      writers.join(", ") === "src/holds.ts" ? null
        : `holds is written from ${writers.length === 0 ? "nowhere" : writers.join(", ")}, and it must be `
          + "written only from src/holds.ts: coverage is a string comparison, so a bound that did not pass "
          + "through normaliseBound would make its hold cover nothing while reporting as active",
    ).toBeNull();
  });

  it("gives every classification a reason long enough to have needed thought", () => {
    // "n/a" is not a reason. This does not check the reason is *good* — a reader does that — only that
    // somebody was made to write one. Same bar as `audit-coverage.test.ts`.
    expect(SITES.filter((site) => site.why.trim().length < 40).map(keyOf)).toEqual([]);
  });
});

/**
 * The other end of the `drafts` site: the button a person presses, and whether the refusal reaches them.
 *
 * It lives in this file because it is about the same call site. The closed world above proves the hold is
 * *asked*; `test/legal-hold.test.ts` proves it *refuses*; and `index.ts` justifies letting the 409 escape the
 * route with the words "somebody pressing discard is owed the reason". None of that reaches a person if the
 * one caller that presses discard drops the response — which is what it did, because `apiFetch` **resolves**
 * for a non-ok status rather than throwing, so an unchecked call closes the dock as though the draft had gone.
 *
 * Lexical, and stated as such: it checks that the handler reads the status before it closes, not that the
 * rendered dock behaves. There is no DOM harness in this suite, and `delivery-summary.test.ts` is the
 * precedent for reading a client source file in the Node pool rather than pretending otherwise.
 */
describe("the discard button does not drop the refusal the Node produced", () => {
  const composer = readFileSync(
    join(workerDir, "src", "client", "app", "screens", "composer.tsx"),
    "utf8",
  );

  /**
   * The body of `discard`, from its declaration to the closing brace at the same indentation.
   *
   * Indentation-delimited, which is why the first assertion below anchors on two strings the handler must
   * contain: a regex that stopped matching would otherwise hand every later assertion an empty string to
   * pass against, which is the vacuous green this whole file is written to avoid.
   */
  const discard = /\n {2}async function discard\(\)[\s\S]*?\n {2}\}\n/.exec(composer)?.[0] ?? "";

  it("finds the handler, so the assertions below cannot pass against an empty string", () => {
    expect(discard).toContain("/api/drafts/");
    expect(discard).toContain("onClose()");
  });

  it("reads the response status before it closes the dock", () => {
    // A hold answers 409. Anything that closes on every answer tells somebody their draft is gone while it
    // is being preserved on purpose, and throws away the four-part message the Node went to the trouble of
    // writing.
    expect(discard).toMatch(/response\.ok/);
  });

  it("surfaces the Node's own words rather than a paraphrase, and stops", () => {
    // `seal` in the same file sets the precedent and the reason: the Node's message names the remedy, and
    // paraphrasing it drops the half that tells somebody what to do. `return` matters as much — closing after
    // showing the reason would show it for one frame.
    expect(discard).toMatch(/setProblem\(/);
    expect(discard).toMatch(/message/);
    expect(discard).toMatch(/\breturn;/);
  });
});

describe("migrations cannot destroy content, because none of them could consult a hold", () => {
  const migrationFiles = readdirSync(join(workerDir, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => `migrations/${name}`);

  it("reads the migrations, so the emptiness below is measured rather than assumed", () => {
    // 18 files on 19 August 2026, counted by this scan. The floor is well under it: the assertion is about
    // the scanner working, not about the count.
    expect(migrationFiles.length).toBeGreaterThanOrEqual(17);
  });

  it("contains no delete and no table or column drop", () => {
    const found = matchesIn(migrationFiles, [SQL_DELETE, SQL_DROP]).map(
      (match) => `${match.file}:${match.line}  ${match.text}`,
    );
    // A migration runs as raw SQL inside `batch()`, so no Worker code can stand between its statements and a
    // hold. If one of these is genuinely needed, that is a decision to take on #64's terms — a bookmark gate
    // per #10's expand/contract rule, and an argument about what the hold means for a schema change — not a
    // line added quietly. Do not relax this to make a migration pass.
    expect(found.length === 0 ? null : `destructive statement(s) in migrations/:\n  ${found.join("\n  ")}`)
      .toBeNull();
  });

  it("does drop an index, which is why DROP INDEX is deliberately not scanned", () => {
    // Measured, and stated because the claim "migrations are clean" is otherwise read as "no DROP anywhere",
    // which is false: `0013_delivery_is_the_unit.sql` drops `ir_derived_key`. An index carries no content, so
    // it is out of scope — and this assertion is what stops that scope being widened by accident, or the
    // exception being forgotten when somebody reads the rule above.
    const sql = readFileSync(join(workerDir, "migrations", "0013_delivery_is_the_unit.sql"), "utf8");
    expect(sql).toMatch(/DROP\s+INDEX/i);
  });
});
