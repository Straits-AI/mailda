import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every predicate that reads `relationship_tuples` must have **decided** about the sponsor term (#109).
 *
 * ## Why a scanner and not more tests
 *
 * The rule is `effective(agent) = pinned action ceiling ∩ live tuples of the agent ∩ live tuples of the
 * sponsor`. The first two terms are structural — a token that fails the ceiling never becomes a principal, and
 * the agent's own tuples are what every query already reads. The third term is **an addition to a `WHERE`
 * clause**, and the failure mode of an addition is omission.
 *
 * That is not hypothetical here. The term was added to the single-object check first, and the listing, the
 * search, the dispatch sweep, the case queues, the sends listing, the notifications feed, the seal-time parent
 * check and `isAdmin` all kept their old predicates. Every existing test passed. A comment beside the fix
 * asserted that the two copies could not drift, and named a tripwire that did not exist — this file, which is
 * why it now does.
 *
 * A behavioural test can only cover a predicate somebody remembered to write a test for, and the defect is
 * the predicate nobody remembered. So: enumerate every site, and require each to be classified. A new tuple
 * read fails this file until somebody writes down which it is.
 *
 * ## How a site passes
 *
 * Either its enclosing function appears in `INTERSECTED` — and then the source of that function must actually
 * reference the term, so listing it is not enough — or it appears in `EXEMPT` with a stated reason.
 *
 * The reason is a string in this file rather than a comment at the site, deliberately: a reader auditing
 * delegation should be able to read every exemption in one place and see the whole argument, instead of
 * finding out what was decided by grepping.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

/** Functions whose tuple predicate carries the sponsor term. Checked, not trusted — see below. */
const INTERSECTED: Record<string, string> = {
  hasAnyRelation: "the single-object check: mailbox read, send.propose and ediscovery.export all land here",
  readableMailboxes: "the readable catalogue, and it carries the sponsor term for the same reason the "
    + "listing does: it answers *which mailboxes may I read*, so an agent naming one its sponsor cannot reach "
    + "would be handed the id of a mailbox the very next request refuses.",
  mailboxesWithRelation: "the many-objects sweep, which must agree with hasAnyRelation and briefly did not",
  messagePageQuery: "the listing and both arms of the searched plan",
  isAdmin: "organization-admin, via sponsorOf — thirty callers pass a bare identifier into it",
  mailboxQueues: "GET /api/cases: which mailboxes an agent is offered work to claim in",
  notificationsFor: "GET /api/notifications: mailbox-wide notices name the mailbox and what is due on it",
  sealManifest: "the seal-time parent check, which has no Principal in reach and decided the derivation",
  route: "GET /api/sends: a manifest carries the subject line and every envelope recipient",
};

/**
 * Sites that must **not** carry the term, each with the reason it would be wrong rather than merely absent.
 *
 * "Wrong rather than absent" is the bar. A site listed here because nobody got round to it is a landmine
 * wearing an exemption, so each entry has to say why the term does not apply at all.
 */
const EXEMPT: Record<string, string> = {
  sponsorClause: "it *is* the term — the one function every intersected site reads it from",
  grant: "administration. Writes a tuple, and its read-back confirms the write rather than authorizing a "
    + "caller. `assertAdmin` above it is the authorization, and that one is intersected.",
  revoke: "administration, as `grant`",
  relationsOf: "answers *what does this subject hold*, which is the question an administrator asks about "
    + "somebody else. Intersecting it would misreport an agent's own grants as absent, and the UI that "
    + "shows them would then disagree with the trail that recorded them.",
  claimNode: "install. Writes the first administrator's tuples before any principal exists.",
  decidersByMailbox: "enumerates **other people** who may approve, for routing. Not the caller's authority; "
    + "an agent asking who must approve its send is not asking to be one of them.",
  adminsOf: "enumerates other people, as `decidersByMailbox`",
  effectiveOn: "the Butler's own three-term intersection. A separate mechanism for a separate principal "
    + "kind, worked out first and reached by a different route (`DISTINCT subject_id`).",
  effectiveOnMailbox: "the Butler's own intersection, as `effectiveOn`",
  metered: "`doctor` counting rows in a table by name. No predicate.",
  sponsorReach: "the mint surface's catalogue: every mailbox with what a **named person** holds on it. It "
    + "answers about somebody else's authority for an administrator choosing, not about a principal's own — "
    + "and applying the sponsor term to it would be asking whether the sponsor's sponsor holds the relation, "
    + "which is not a question. `org.admin` on the route is what bounds who may ask.",
  agentReach: "reports what each agent was granted and whether the sponsor still holds it — so it **computes** "
    + "the intersection rather than being bounded by one. It is the administrator's view of somebody else's "
    + "authority, not a principal reading their own: an agent asking this question would be asking about "
    + "agents, which is `GET /api/agents` and withheld from every machine. Applying the term here would hide "
    + "exactly the rows the finding exists to show, since a grant the sponsor has lost is the one an operator "
    + "needs to see.",
  mintAgent: "two sites, and neither evaluates a principal's own authority. One **is** the sponsor term, "
    + "asked up front: it reads the sponsor's tuples to refuse a grant the sponsor does not hold, so an "
    + "administrator finds out at mint rather than through an automation that quietly does nothing. "
    + "Intersecting it with itself is not a thing. The other writes the agent's tuples, and a write has no "
    + "reader to bound — what bounds it is the check beside it and the intersection on every later request.",
};

/**
 * Files that name the table without querying it.
 *
 * By file rather than by function, because the site is at module level and exempting `<module>` would exempt
 * every future module-level query along with it — an exemption that grows on its own is not one.
 */
const NOT_A_QUERY: Record<string, string> = {
  "schema.ts": "the drizzle definition. Names the table so `test/schema-drift.test.ts` can compare it against "
    + "the live database; there is no predicate here to bound.",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return entry.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every line that names the table **in code**, with the function it sits in.
 *
 * Comments are excluded, and that exclusion is the whole reason this scanner is worth having rather than a
 * grep: this repository's files discuss `relationship_tuples` at length in prose, and a scanner that counted
 * prose would have produced dozens of findings on a clean tree and been switched off. A discarded guard is
 * worse than no guard, because the next person believes one is running.
 */
function tupleSites(): Array<{ file: string; line: number; fn: string; text: string }> {
  const out: Array<{ file: string; line: number; fn: string; text: string }> = [];
  for (const file of sources(SRC)) {
    let fn = "<module>";
    let inBlockComment = false;
    readFileSync(file, "utf8").split("\n").forEach((raw, index) => {
      const line = raw.trim();
      /*
       * **Unindented declarations only.** A first version matched on the trimmed line, so a local
       * `const holds = async (…) =>` inside `isAdmin` became the enclosing function and three genuinely
       * classified sites reported as unclassified while three registrations reported as stale. The scanner was
       * wrong in the direction that produces noise, which is the survivable direction — a scanner wrong the
       * other way is a clean run over an unchecked tree.
       */
      const declaration =
        /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = (?:async )?\(/.exec(raw);
      if (declaration) fn = declaration[1] ?? declaration[2]!;

      const wasInComment = inBlockComment;
      if (/\/\*/.test(line) && !/\*\//.test(line)) inBlockComment = true;
      if (/\*\//.test(line)) inBlockComment = false;
      const isComment = wasInComment || line.startsWith("*") || line.startsWith("//")
        || line.startsWith("/*");
      if (isComment) return;

      const relative = file.slice(SRC.length);
      if (line.includes("relationship_tuples") && !(relative in NOT_A_QUERY)) {
        out.push({ file: relative, line: index + 1, fn, text: line });
      }
    });
  }
  return out;
}

describe("every tuple predicate has decided about the sponsor term", () => {
  it("finds the sites at all, so a silent zero cannot pass this file", () => {
    // The control. A scanner whose regexes stopped matching would report a clean tree, and every assertion
    // below would pass over an empty list — the failure mode this repository has hit before.
    const sites = tupleSites();
    expect(sites.length, "no tuple reads found in src — have the scanner's regexes rotted?")
      .toBeGreaterThan(15);
    expect(new Set(sites.map((s) => s.fn)).size).toBeGreaterThan(8);
  });

  it("classifies every site as intersected or exempt", () => {
    const unclassified = tupleSites()
      .filter((site) => !(site.fn in INTERSECTED) && !(site.fn in EXEMPT))
      .map((site) => `${site.file}:${site.line} in ${site.fn}()\n    ${site.text}`);

    expect(
      unclassified,
      "A new predicate reads relationship_tuples and nothing says whether an agent's sponsor bounds it.\n"
      + "Decide, then add the function to INTERSECTED (and carry sponsorTerm/sponsorClause in the query) or\n"
      + "to EXEMPT with the reason the term would be wrong rather than merely missing:\n\n"
      + unclassified.join("\n\n"),
    ).toEqual([]);
  });

  it("requires an intersected function to actually reference the term", () => {
    /*
     * The half that makes the list above evidence rather than a claim. Adding a name to `INTERSECTED` is
     * cheap and would silence the previous assertion while changing no SQL — so each named function's own
     * source has to mention the term. This is what catches somebody deleting the clause and leaving the
     * registration behind, which is exactly how the drift being guarded against would happen.
     */
    const bodies = new Map<string, string>();
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const name of Object.keys(INTERSECTED)) {
        const start = new RegExp(`(?:function ${name}\\b|const ${name} = )`).exec(text);
        if (start === null) continue;
        // To the next top-level declaration, which is a coarse but sufficient bound: the term appears inside
        // the query, and the query is inside the function.
        const rest = text.slice(start.index + 1);
        const nextDeclaration = /\n(?:export )?(?:async )?function |\n(?:export )?const \w+ = /.exec(rest);
        bodies.set(name, rest.slice(0, nextDeclaration?.index ?? rest.length));
      }
    }

    const missing = Object.keys(INTERSECTED).filter((name) => {
      const body = bodies.get(name);
      // A function named in the list but no longer present is its own failure, reported by the same message:
      // a registration for something that does not exist is a claim about nothing.
      return body === undefined || !/sponsorTerm|sponsorOf|sponsor\.sql|args\.sponsor/.test(body);
    });

    expect(
      missing,
      "These functions are registered as carrying the sponsor term and their source does not reference it.\n"
      + "Either the clause was removed and the registration left behind, or the function was renamed:\n  "
      + missing.join(", "),
    ).toEqual([]);
  });

  it("states a reason for every exemption", () => {
    // A blank or perfunctory reason is an exemption nobody argued for. The length floor is crude and it is
    // enough: it stops `foo: "n/a"`, which is how a list like this stops meaning anything.
    const thin = Object.entries(EXEMPT).filter(([, reason]) => reason.trim().length < 20);
    expect(thin.map(([name]) => name), "exemptions with no stated reason").toEqual([]);
  });

  it("keeps the two lists disjoint", () => {
    // A function in both would pass whichever assertion ran first and mean nothing.
    const both = Object.keys(INTERSECTED).filter((name) => name in EXEMPT);
    expect(both, "a function is registered as both intersected and exempt").toEqual([]);
  });

  it("has no entry that matches no site", () => {
    /*
     * The other direction, and the one that keeps this file honest as the code moves. A stale entry is a
     * decision recorded about code that no longer exists, and it reads exactly like a decision that still
     * holds. `route` is excluded: it is `index.ts`'s single enormous handler, so its name says nothing about
     * which of its queries is meant, and its registration is checked by the reference assertion instead.
     */
    const live = new Set(tupleSites().map((site) => site.fn));
    const stale = [...Object.keys(INTERSECTED), ...Object.keys(EXEMPT)]
      .filter((name) => name !== "route" && !live.has(name));
    expect(stale, "these entries name functions that no longer read relationship_tuples").toEqual([]);
  });
});
