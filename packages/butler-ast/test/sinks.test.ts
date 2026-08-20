import { describe, expect, it } from "vitest";

import { FIELD_KIND_NAMES, shippedParameterSurface } from "../src/ast.ts";
import { checkButler } from "../src/check.ts";
import { leadIntake } from "./fixture.ts";

/**
 * The tripwire: **no shipped node exposes a sink parameter** (#52).
 *
 * ## What went wrong, because the guard is shaped by it
 *
 * §16 says untrusted content cannot select or construct *"policy, sender identity, To/CC/BCC or forwarding
 * destination, attachment, integration/egress URL, connector operation/target record, financial/account
 * identifier, secret reference, model profile or permission"*. Ten of those eleven reach no parameter of any
 * shipped node. The eleventh did: #49 charted the node set with `to: z.array(expr).min(1)` on `draft`, #52
 * later decided there would be no recipient parameter at all, the implementation followed the earlier
 * decision, and **nothing objected** — because the thing that would have objected is this file, and it did
 * not exist. The absent guard and the open sink were one omission.
 *
 * ## Why this is not a list of forbidden names
 *
 * A denylist of `to`, `cc`, `bcc` is a guard against three spellings; `escalateTo` walks past it. This
 * repository has been bitten twice by a hand-maintained list, so the two nets here are both fail-closed and
 * neither knows a single forbidden word:
 *
 * 1. **Every shipped parameter is built from a registered field kind** (`FIELD_KINDS` in `ast.ts`), matched
 *    by schema *identity*. A parameter written as a fresh construction — `z.array(expr).min(1)`,
 *    `z.string()`, `expr.optional()` at a call site — resolves to `null` and fails here. The registry
 *    contains nothing that could carry an address, a URL, a secret or a model profile, so a parameter that
 *    wanted one has nothing to be typed as.
 * 2. **The parameter surface is exactly the pinned list below.** Any parameter added to any shipped node
 *    fails this, whatever it is called and whatever it is built from. It is deliberately sensitive: adding a
 *    parameter to a node that performs an external effect is exactly the change that should make somebody
 *    re-read §16's sentence, and that is the only thing a mechanical check can honestly enforce — no
 *    schema-level rule can tell an `Expr` holding a case id from an `Expr` holding an email address, because
 *    they are the same type. **Said plainly rather than implied: this does not prove a new parameter is
 *    safe. It proves nobody added one without being told to justify it.**
 *
 * The third test is the author-facing half, and it is the one that makes "spelling-blind" a demonstration
 * rather than a claim: six different words for a recipient, one refusal, no name list behind it.
 *
 * ## Not a dataflow checker, and that reverses part of Layer 4's shape
 *
 * #52 recorded the reversal rather than making it quietly. **A checker with nothing to refuse is untestable**
 * — with the sink closed by construction there is no tainted value that could reach one, so a green suite
 * would prove only that the analysis never fired. The dataflow checker arrives with the first node that has
 * a real sink (`connector.*`, `llm.*` — both Layer 6), and it arrives with something to refuse.
 */

/**
 * The whole parameter surface of the shipped node set.
 *
 * Written out here rather than derived, for `nodes.test.ts`' reason: this list is *supposed* to be a second
 * copy, and its whole job is to disagree with the code when the code changes. Each row is `type.field →
 * field kind`, and the reviewer's question for any new row is §16's: can untrusted content select or
 * construct what this names?
 */
const SURFACE = [
  "case.assign.assignee → expr",
  "case.assign.caseId → expr",
  "case.assign.next → ref",
  "case.close.caseId → expr",
  "case.close.next → ref",
  "draft.as → nodeId",
  "draft.body → expr",
  "draft.inReplyTo → optionalExpr",
  "draft.mailboxId → expr",
  "draft.next → ref",
  "draft.subject → expr",
  "foreach.as → nodeId",
  "foreach.body → nodeId",
  "foreach.maxItems → maxItems",
  "foreach.next → ref",
  "foreach.over → expr",
  "guard.otherwise → ref",
  "guard.then → ref",
  "guard.when → expr",
  "join.next → ref",
  "lookup.as → nodeId",
  "lookup.entity → lookupEntity",
  "lookup.entityId → expr",
  "lookup.next → ref",
  "mail.send.propose.draft → expr",
  "mail.send.propose.next → ref",
  "map.as → nodeId",
  "map.body → nodeId",
  "map.collectAs → nodeId",
  "map.maxItems → maxItems",
  "map.next → ref",
  "map.over → expr",
  "stop.reason → stopReason",
  "switch.cases → switchCases",
  "switch.default → ref",
  "switch.on → expr",
  "transform.as → nodeId",
  "transform.next → ref",
  "transform.value → expr",
  "validate.next → ref",
  "validate.schema → inlineJsonSchema",
  "validate.value → expr",
  "wait.next → ref",
  "wait.seconds → waitSeconds",
];

function describeSurface(): string[] {
  return shippedParameterSurface().map((parameter) =>
    `${parameter.type}.${parameter.field} → ${parameter.kind ?? "UNREGISTERED"}`);
}

describe("no shipped node exposes a sink parameter (#52, §16)", () => {
  it("builds every shipped parameter from a registered field kind", () => {
    const unregistered = shippedParameterSurface().filter((parameter) => parameter.kind === null);
    expect(
      unregistered.map((parameter) => `${parameter.type}.${parameter.field}`),
      "a parameter built from a schema constructed at its call site rather than named in FIELD_KINDS. "
      + "§16: untrusted content cannot select or construct To/CC/BCC or forwarding destination, sender "
      + "identity, attachment, egress URL, connector operation, financial identifier, secret reference, "
      + "model profile, permission or policy. Name the schema in FIELD_KINDS and say which of those it is "
      + "not",
    ).toEqual([]);
  });

  it("has exactly this parameter surface, so a new parameter cannot arrive unnoticed", () => {
    expect(
      describeSurface(),
      "the parameter surface of the shipped node set changed. If this added a parameter, answer §16's "
      + "question about it before pinning it here: can untrusted content select or construct what it names? "
      + "A recipient cannot be added at all — the Node derives those from the delivery that triggered the "
      + "run (src/butler/parent.ts)",
    ).toEqual(SURFACE);
  });

  it("registers no field kind at all, so there is nothing an address could be typed as", () => {
    // Pinned for the same reason as the surface: a new field kind is the other way a sink parameter could
    // arrive, and it is a one-line diff in ast.ts. There is deliberately no `address`, `url`, `secretRef`
    // or `modelProfile` here, and there is deliberately no way to add a parameter without picking one.
    expect(FIELD_KIND_NAMES).toEqual([
      "nodeId", "expr", "optionalExpr", "ref", "maxItems", "lookupEntity", "inlineJsonSchema",
      "switchCases", "waitSeconds", "stopReason",
    ]);
  });

  it("refuses a Butler that names a recipient, under any spelling, with one rule that knows none of them", () => {
    // The author-facing half. Six words for the same idea, one refusal — because a shipped node's shape is
    // strict and none of these is a parameter of anything, not because any of them appears in a list.
    for (const spelling of ["to", "cc", "bcc", "recipients", "escalateTo", "forwardTo"]) {
      const ast = leadIntake();
      const node = (ast["nodes"] as Array<Record<string, unknown>>)
        .find((candidate) => candidate["id"] === "acknowledge")!;
      node[spelling] = ["attacker@evil.example"];

      const result = checkButler(ast);
      expect(result.ok, spelling).toBe(false);
      const finding = result.ok ? undefined : result.findings[0];
      expect(finding?.code, spelling).toBe("E_BUTLER_NODE_UNKNOWN_PARAMETER");
      expect(finding?.node, spelling).toBe("acknowledge");
      expect(finding?.what, spelling).toContain(JSON.stringify(spelling));
      // The refusal names the rule rather than the validator, because the reader is an agent fixing its own
      // mistake and "unrecognized key" is not something it can act on.
      expect(finding?.why, spelling).toContain("To/CC/BCC");
      expect(finding?.fix, spelling).toContain("trusted-recipient store");
    }
  });

  it("does not silently strip an unknown parameter, which is what made removing `to` insufficient on its own", () => {
    // Zod's default object strips. Had `draft` stayed non-strict, deleting `to` from the schema would have
    // let a Butler naming `to` publish with the field discarded and no refusal — an author certain they had
    // chosen the recipients of mail this Node will send. That is worse than the parameter.
    const ast = leadIntake();
    const node = (ast["nodes"] as Array<Record<string, unknown>>)
      .find((candidate) => candidate["id"] === "acknowledge")!;
    node["to"] = ["attacker@evil.example"];
    expect(checkButler(ast).ok).toBe(false);
  });
});
