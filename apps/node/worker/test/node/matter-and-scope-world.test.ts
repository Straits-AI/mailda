import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MATTER_TYPES } from "../../src/matters.ts";
import { NOTIFICATION_KINDS } from "../../src/notifications.ts";
import { SUPERVISED_SCOPES } from "../../src/supervised.ts";

/**
 * Two closed enums that the **database does not constrain**, and the writers that must not multiply.
 *
 * `matters.type` and `supervised_grants.scope` carry no `CHECK`, and that is not laziness: SQLite cannot add
 * one with `ALTER TABLE`, a trigger cannot exist anywhere in this tree because `src/migrate.ts` splits
 * migrations on semicolons (`migrations.test.ts` forbids one), and recreating a table to add a `CHECK` needs a
 * `DROP TABLE`, which `content-deletion-world.test.ts` refuses in `migrations/`. So the constraint lives one
 * level up, in a TypeScript union — exactly where `APPROVAL_SUBJECT_KINDS` already lives.
 *
 * A union is only a constraint if something checks it against the source. That is this file. Without it, both
 * declarations are conventions, and a convention is what the last change to this area shipped: a helper typed
 * `Record<string, X>` whose `keyof` was `string`, which accepted any string it was handed and would have left
 * a send stuck for ever on a typo.
 *
 * ## What each assertion is worth, in the terms of the failure it prevents
 *
 *   a deleted narrowing         `openMatter` and `requestSupervisedRead` refuse an undeclared value today. If
 *                               either guard were removed while its `INSERT` stayed, the column would accept
 *                               whatever the wire sent — a matter nothing can interpret (#64 makes
 *                               `legal_hold` one of these, so an unrecognised type is a hold whose purpose
 *                               cannot be read) or a grant that matches no read path: approved, recorded, and
 *                               conferring nothing.
 *   a second writer             a second `INSERT` that never went through the narrowing at all. This is the
 *                               half a per-function guard cannot see.
 *   a second grantor            a second `UPDATE supervised_grants SET granted_at`, which would be a
 *                               supervised read made live without its two approvers and without its entry.
 *   two spellings of "live"     `granted_at IS NOT NULL AND expires_at > ?` written twice, so an expiry fixed
 *                               in one place keeps being ignored in the other.
 *
 * ## The shape, and why the left-hand side is derived
 *
 * Both declarations are **extracted from the source** and imported as values, and both are used: the import
 * proves the union is what the compiler sees, the extraction proves the literal text is what a scanner can
 * find. `#71` is why — a test in this repository once asserted against a hardcoded list under a comment
 * claiming it read the list from the config, and it was the test written to close that pattern. So the
 * anti-vacuity assertions below fail if the extractor stops finding anything, and every scan reads the source
 * with its comments stripped, because this file's own first run was broken by prose describing the thing it
 * was counting.
 */

const workerDir = join(import.meta.dirname, "..", "..");

/** Every `.ts`/`.tsx` under a directory, recursively. Same shape as `content-deletion-world.test.ts`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(workerDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

const SOURCES = sourceFiles("src");

function read(file: string): string {
  return readFileSync(join(workerDir, file), "utf8");
}

/**
 * The file with its **comments removed**, which is what every scan below reads.
 *
 * This is not tidiness. A tripwire in this repository was once satisfied by its own comments, and this file
 * reproduced the same defect on its first run: the "exactly one `UPDATE supervised_grants`" scan found three,
 * two of which were doc comments *describing* the one. A source scan that counts prose is a scan that can be
 * silenced by rewording, and it can also fail for no reason at all — both of which teach a reader to ignore it.
 *
 * Block comments first, then `//` and SQL `--` to end of line. The known limitation, stated rather than
 * discovered: a `//` or `--` inside a string literal truncates that line early. Every scan here looks for SQL
 * keywords and lowercase enum literals, none of which follow a `//` on the same line, so the cost of a false
 * cut is nothing — and the alternative is a TypeScript parser in a lexical test.
 */
function codeOf(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/--\s.*$/, ""))
    .join("\n");
}

/** The literals inside a `const NAME = [ ... ]` declaration, as the source spells them. */
function declaredIn(file: string, name: string): string[] {
  const body = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(codeOf(file))?.[1] ?? "";
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
}

/**
 * Asserts that `guard` is **called inside `enclosing`**, before that function's `INSERT INTO <table>`.
 *
 * Lexical, like `content-deletion-world.test.ts`'s guard check, and with the same declared boundary: it proves
 * the narrowing appears before the write in the same function, not that it is reached on every branch. The
 * behavioural half is `test/supervised-read.test.ts`, which sends an undeclared type and an undeclared scope
 * and watches both be refused. What this adds is that the refusal cannot be *deleted* while the insert stays.
 *
 * **The search starts at the enclosing function, and that is the whole soundness of it.** The first version
 * searched the file, which matched the guard's own `export function isMatterType(` declaration — so deleting
 * the call and leaving the definition passed. Found by mutation, which is the only way that class of vacuity
 * is ever found.
 */
function narrowsBeforeInserting(
  file: string,
  guard: string,
  table: string,
  enclosing: string,
): string | null {
  const code = codeOf(file);
  const start = code.indexOf(`function ${enclosing}`);
  if (start === -1) return `no function ${enclosing} in ${file} — this scan is guarding nothing`;
  const insert = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "i").exec(code.slice(start))?.index ?? -1;
  const narrowing = code.slice(start).indexOf(`${guard}(`);
  if (insert === -1) return `${enclosing} in ${file} does not INSERT INTO ${table} — nothing is guarded`;
  if (narrowing === -1) return `${enclosing} writes ${table} without calling ${guard} at all`;
  return narrowing < insert ? null
    : `${enclosing} calls ${guard} after its INSERT INTO ${table}, so the column is written before it is `
      + "narrowed";
}

/** Files that call `name(...)`, excluding the one that declares it. */
function writersOfCall(name: string): string[] {
  const declaration = new RegExp(`function ${name}\\b`);
  return SOURCES.filter((file) => {
    const code = codeOf(file);
    return code.includes(`${name}(`) && !declaration.test(code);
  });
}

/** Files whose text contains an `INSERT INTO <table>` of any flavour. */
function writersOf(table: string): string[] {
  const pattern = new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, "i");
  return SOURCES.filter((file) => pattern.test(codeOf(file)));
}

describe("the matter type enum is a constraint rather than a convention", () => {
  const declared = declaredIn("src/matters.ts", "MATTER_TYPES");

  it("is extractable and agrees with the exported union", () => {
    // Anti-vacuity in both directions: if the extractor stops matching, every check below passes against an
    // empty set; if the two disagree, one of them is not the thing the compiler enforces.
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...MATTER_TYPES]);
    // #64 settled this member outright, and `holds.matter_id` cites a matter. If it vanished, a legal hold's
    // purpose would become a type this Node does not recognise.
    expect(declared).toContain("legal_hold");
  });

  it("narrows the type before it stores one", () => {
    /*
     * **Deliberately not a scan for undeclared literals**, and the reason is that such a scan would be
     * vacuous today: there is no matter-type literal anywhere in `src/` outside `MATTER_TYPES` itself, because
     * `openMatter` narrows a string from the wire and never names a type. A scan over an empty set passes
     * whatever the source says, which is the vacuous green this file exists to avoid — so what is asserted
     * instead is the thing that actually holds the column: the narrowing stands in front of the write.
     *
     * If a literal ever does appear — a `doctor` finding that treats `legal_hold` specially is the obvious
     * candidate — the scan becomes worth having, and the guard below is what will still be true meanwhile.
     */
    expect(narrowsBeforeInserting("src/matters.ts", "isMatterType", "matters", "openMatter"))
      .toBeNull();
  });

  it("is written from one place, so one function narrows it", () => {
    const writers = writersOf("matters");
    expect(
      writers.join(", ") === "src/matters.ts" ? null
        : `matters is written from ${writers.length === 0 ? "nowhere" : writers.join(", ")}, and it must be `
          + "written only from src/matters.ts: the type column has no CHECK, so a second INSERT would be free "
          + "to store a type nothing can interpret — and §7's notice to the person whose mail was read is "
          + "written for a kind of matter, not for free text",
    ).toBeNull();
  });
});

describe("the supervised scope enum is a constraint rather than a convention", () => {
  const declared = declaredIn("src/supervised.ts", "SUPERVISED_SCOPES");

  it("is extractable and agrees with the exported union", () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...SUPERVISED_SCOPES]);
    // The two words are the two read relations this product already has. If either disappeared, a scope would
    // map onto a read path that does not exist.
    expect(declared).toEqual(["metadata", "content"]);
  });

  it("declares every scope the read paths accept", () => {
    // Derived from the two satisfying sets rather than from a hand-written list, because those sets are what
    // `authz-read.ts` actually passes to the grant lookup. A scope in one of them that the enum did not
    // declare would be a check nothing could ever satisfy.
    const source = codeOf("src/supervised.ts");
    const used = new Set<string>();
    for (const name of ["SCOPES_FOR_CONTENT", "SCOPES_FOR_METADATA"]) {
      const body = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source)?.[1] ?? "";
      for (const match of body.matchAll(/"([a-z_]+)"/g)) used.add(match[1]!);
    }
    // Anti-vacuity: both sets exist and together mention both scopes, or the extractor changed and not the
    // source.
    expect([...used].sort()).toEqual(["content", "metadata"]);
    expect([...used].filter((scope) => !declared.includes(scope))).toEqual([]);
  });

  it("narrows the scope before it stores one", () => {
    // Same argument as the matter type one table over, and the same declared boundary.
    expect(narrowsBeforeInserting(
      "src/supervised.ts", "isSupervisedScope", "supervised_grants", "requestSupervisedRead",
    )).toBeNull();
  });

  it("is written from one place, so one function narrows it", () => {
    const writers = writersOf("supervised_grants");
    expect(
      writers.join(", ") === "src/supervised.ts" ? null
        : `supervised_grants is written from `
          + `${writers.length === 0 ? "nowhere" : writers.join(", ")}, and it must be written only from `
          + "src/supervised.ts: the scope column has no CHECK, so a second INSERT would be free to store a "
          + "scope no read path accepts — a grant that is approved, recorded and confers nothing",
    ).toBeNull();
  });

  it("has exactly one statement that makes a grant live", () => {
    /*
     * The mirror of `content-deletion-world.test.ts`'s single `UPDATE holds`, and the argument is the same
     * one: `granted_at` **is** the authority, so a second writer would be a way to grant a supervised read
     * without two approvers, without the `supervised.granted` entry, and without anything noticing.
     *
     * The one writer is `approveStatements` in `src/approvals.ts`, gated on the approval having become
     * `approved` in the same transaction.
     */
    const writes: string[] = [];
    for (const file of SOURCES) {
      codeOf(file).split("\n").forEach((line, index) => {
        if (/\bUPDATE\s+supervised_grants\b/i.test(line)) writes.push(`${file}:${index + 1}`);
      });
    }
    expect(
      writes.length === 1 && writes[0]!.startsWith("src/approvals.ts:") ? null
        : `${writes.length} UPDATE supervised_grants statement(s) in src/ (${writes.join(", ") || "none"}); `
          + "there must be exactly one, in src/approvals.ts, because granted_at is the authority and a second "
          + "writer would be a supervised read granted without its two approvers",
    ).toBeNull();

    const source = codeOf("src/approvals.ts");
    const statement = /UPDATE supervised_grants[\s\S]{0,400}?`/.exec(source)?.[0] ?? "";
    // Anti-vacuity: the extractor found the statement, so the two clause assertions below are about SQL and
    // not about an empty string.
    expect(statement).toContain("SET granted_at");
    // Dual control at the database, and nothing grants one grant twice.
    expect(statement, "the one UPDATE must require the approval to have become approved").toContain("EXISTS");
    expect(statement, "the one UPDATE must refuse a grant that is already live").toContain("granted_at IS NULL");
    // The deadline the two approvers were shown must not move. Recomputing it here would silently extend
    // every grant by however long the decision took, which §7 makes a widening needing its own approval.
    expect(statement, "the one UPDATE must not rewrite expires_at").not.toContain("expires_at =");
  });

  it("spells the live predicate in exactly one place", () => {
    /*
     * *"May this person still read"* is `granted_at IS NOT NULL AND expires_at > ?`, and two spellings of it
     * is the drift `coveringHolds` moved `lifted_at IS NULL` into itself to avoid — the one that counts would
     * be whichever file the reader happened to open. So the string lives in `LIVE_SUPERVISED_GRANT` and every
     * query interpolates it.
     */
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file === "src/supervised.ts") continue;
      codeOf(file).split("\n").forEach((line, index) => {
        if (/granted_at IS NOT NULL\s+AND\s+expires_at/.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(
      offenders.length === 0 ? null
        : `the live-grant predicate is spelled again at ${offenders.join(", ")} — it must come from `
          + "LIVE_SUPERVISED_GRANT in src/supervised.ts, or an expiry fixed in one place will keep being "
          + "ignored in the other",
    ).toBeNull();

    // Anti-vacuity: the constant really does carry both halves, so the scan above is guarding something.
    expect(codeOf("src/supervised.ts"))
      .toContain('LIVE_SUPERVISED_GRANT = "granted_at IS NOT NULL AND expires_at > ?"');
  });
});

/* ------------------------------------------------------------------ #63 part B ----------------- */

describe("the notification kind enum is a constraint rather than a convention", () => {
  const declared = declaredIn("src/notifications.ts", "NOTIFICATION_KINDS");

  it("is extractable and agrees with the exported union", () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...NOTIFICATION_KINDS]);
    // The two obligations this table carries: §7's notice to the person whose mail was read, and #61's
    // approval request, which deferred its own notification to this mechanism explicitly rather than
    // inventing a second one.
    expect(declared).toEqual(["supervised_read", "approval_request"]);
  });

  it("declares every kind the delivering scan branches on", () => {
    // Derived from the source rather than listed, so a kind the scan handles and the enum does not declare —
    // or the reverse, a declared kind the scan silently ignores, which would sit undelivered for ever — is a
    // failure here rather than a row nobody notices.
    const scan = codeOf("src/notice-delivery.ts");
    const used = new Set([...scan.matchAll(/kind === "([a-z_]+)"/g)].map((match) => match[1]!));
    expect([...used].length).toBeGreaterThan(0);
    expect([...used].filter((kind) => !declared.includes(kind))).toEqual([]);
  });

  it("is written from one place", () => {
    const writers = writersOf("notifications");
    expect(
      writers.join(", ") === "src/notifications.ts" ? null
        : `notifications is written from ${writers.length === 0 ? "nowhere" : writers.join(", ")}, and it `
          + "must be written only from src/notifications.ts: the kind column has no CHECK, so a second "
          + "INSERT would be free to store a kind the scan does not branch on — an obligation that is owed, "
          + "recorded, and never delivered",
    ).toBeNull();
  });

  it("has no path that deletes a notice, which is what makes suppression loud", () => {
    /*
     * **The property §7's "cannot be disabled by the investigator" rests on.**
     *
     * Every notice row is inserted in the same transaction as an audit entry — the §7 one beside
     * `supervised.granted`, #61's beside `approval.requested` — so a missing row means somebody removed it,
     * and `doctor`'s `supervision_notice_missing` compares the two counts. That argument only holds while
     * **the product itself cannot delete one**: a dismiss button, a mark-read, or a tidy-up sweep would each
     * make a missing row ordinary and the finding meaningless.
     *
     * So: no `DELETE FROM notifications` anywhere in `src/`, at all.
     */
    const offenders: string[] = [];
    for (const file of SOURCES) {
      codeOf(file).split("\n").forEach((line, index) => {
        if (/\bDELETE\s+FROM\s+notifications\b/i.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(
      offenders.length === 0 ? null
        : `a notice can be deleted from ${offenders.join(", ")}. §7 requires the notification not be `
          + "disableable by the investigator, and doctor's supervision_notice_missing finding reads a "
          + "missing row as somebody having removed one — which stops being true the moment the product "
          + "can remove one itself",
    ).toBeNull();
  });
});

describe("a supervised read cannot be authorized without being recorded", () => {
  /*
   * §7 requires a record of every supervised query, result opened and attachment read, and part A shipped
   * none of them. What part B had to add was not the entries — it was the impossibility of getting the
   * authority without them.
   *
   * The **compiler** carries the single-object half: `mayRead` takes a required `SupervisedAct`, so a read
   * path that wanted authorization and no record would not compile. What a compiler cannot carry is that the
   * function still *uses* it, and that the listing paths — whose results do not exist at the moment of the
   * check — record after their rows come back. That is what this block holds.
   *
   * Lexical, with the same declared boundary as every other scan in this file: it proves the call is in the
   * function, not that it is reached on every branch. `test/supervised-recording.test.ts` is the behavioural
   * half, including a read that is refused because its entry could not be appended.
   */
  const authz = codeOf("src/authz-read.ts");

  it("appends the entry inside mayRead, where the decision is made", () => {
    const start = authz.indexOf("export async function mayRead(");
    expect(start, "no mayRead in src/authz-read.ts — this scan is guarding nothing").toBeGreaterThan(-1);
    const body = authz.slice(start, authz.indexOf("export async function", start + 10));
    // The act is the parameter the compiler enforces; this is the call that makes it mean something.
    expect(body, "mayRead must take the act it is about to authorize").toContain("act: SupervisedAct");
    expect(body, "mayRead must append the entry before it returns true").toContain("recordDisclosure(");
  });

  it("makes every listing that can be answered by a grant record what it returned", () => {
    /*
     * The two grant-accepting builders are the seam: a grant id reaches a listing from nowhere else, so a
     * caller of either owes an entry. `liveGrantsBySubject` is the message listing's, and `mayReadMetadata`
     * is the queue's — the one part A called unreachable, which was one relation too strong.
     */
    const offenders: string[] = [];
    for (const [builder, callers] of [
      ["liveGrantsBySubject", writersOfCall("liveGrantsBySubject")],
      ["mayReadMetadata", writersOfCall("mayReadMetadata")],
    ] as const) {
      // Anti-vacuity: a builder nothing calls would pass this loop by having nothing to check.
      expect(callers.length, `nothing calls ${builder} — this scan is guarding nothing`).toBeGreaterThan(0);
      for (const file of callers) {
        const code = codeOf(file);
        // Searched **from the call**, not from the top of the file: `authz-read.ts` records inside `mayRead`
        // long before `listMessages` asks the builder anything, and a first-occurrence comparison would have
        // let the listing off on the strength of a different function's entry.
        const call = code.indexOf(`${builder}(`);
        const record = code.indexOf("recordDisclosure(", call);
        if (record === -1) offenders.push(`${file} calls ${builder}`);
      }
    }
    expect(
      offenders.length === 0 ? null
        : `${offenders.join(", ")} without recording what it disclosed. A listing authorized by a supervised `
          + "grant owes §7 a supervised.query entry naming the ids it returned, and the entry has to be "
          + "written after the rows come back because the check cannot know them",
    ).toBeNull();
  });
});
