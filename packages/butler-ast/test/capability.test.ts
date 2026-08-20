import { describe, expect, it } from "vitest";

import {
  CAPABILITY_ACTIONS, ceilingByAction, checkButler, mailboxAddressOf, requirementsOf, SHIPPED_KINDS,
  type ButlerNode, type CapabilityAction,
} from "../src/index.ts";
import { leadIntake } from "./fixture.ts";

/**
 * The pinned capability ceiling, at publication (#51, §16, blueprint:702).
 *
 * What is checked here is the half a checker *can* check: the ceiling's **action set is exactly the action
 * set the graph needs**. The other half — which mailbox — is unverifiable in this package by construction,
 * because a node's mailbox is an `Expr` and nothing here parses one; it is enforced per step at runtime and
 * proved in `apps/node/worker/test/butler-capability.test.ts`.
 */

function nodesOf(ast: Record<string, unknown>): Array<Record<string, unknown>> {
  return ast["nodes"] as Array<Record<string, unknown>>;
}

function capabilitiesOf(ast: Record<string, unknown>): Array<Record<string, unknown>> {
  return ast["capabilities"] as Array<Record<string, unknown>>;
}

function codes(ast: unknown): string[] {
  const result = checkButler(ast);
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

describe("the ceiling is declared in the document and frozen with it", () => {
  it("is a required key, so a Butler cannot arrive without one", () => {
    const ast = leadIntake();
    delete ast["capabilities"];
    // The envelope refuses it before any node is looked at, which is where it belongs: a program with no
    // stated authority bound is not a Butler this Node will hold.
    expect(codes(ast)).toEqual(["E_BUTLER_MALFORMED"]);
  });

  it("refuses a misspelled key rather than discarding it, which is why the document is strict", () => {
    /*
     * `z.object` strips what it does not declare. Before the top-level schema was strict, `capabilties`
     * would have been dropped in silence — and the author, having written a ceiling, would have been told
     * only that `capabilities` was missing, with their own line visible on the screen. Refusing the unknown
     * key by name is the difference between a validator's opinion and the rule.
     */
    const ast = leadIntake();
    ast["capabilties"] = ast["capabilities"];
    delete ast["capabilities"];
    const result = checkButler(ast);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]?.what).toContain("capabilties");
  });

  it("refuses an unrecognised key inside one capability, for the same reason", () => {
    const ast = leadIntake();
    capabilitiesOf(ast)[0] = { action: "send.propose", mailbox: "enquiries@example.com" };
    expect(codes(ast)).toEqual(["E_BUTLER_MALFORMED"]);
  });

  it("admits an empty ceiling, because a Butler that touches nothing needs no authority", () => {
    const ast = leadIntake();
    ast["capabilities"] = [];
    ast["entry"] = "drop";
    ast["nodes"] = [{ id: "drop", type: "stop", reason: "nothing to do" }];
    expect(codes(ast)).toEqual([]);
  });
});

describe("publication proves the ceiling and the graph agree", () => {
  it("refuses a node needing an action the ceiling does not declare, naming the node and the action", () => {
    const ast = leadIntake();
    ast["capabilities"] = [];
    const result = checkButler(ast);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.findings.find((f) => f.code === "E_BUTLER_CAPABILITY_NOT_DECLARED");
    expect(found).toBeDefined();
    // Three nodes need `send.propose` — the assign, the draft and the send — and they are reported as one
    // finding rather than three, because an author reading three copies of one sentence learns one thing.
    expect(found?.what).toContain("send.propose");
    expect(found?.what).toContain("assign");
    expect(found?.what).toContain("acknowledge");
    expect(found?.what).toContain("propose");
    expect(found?.fix).toContain("mailbox:");
  });

  it("refuses an action the ceiling declares and no node needs", () => {
    const ast = leadIntake();
    capabilitiesOf(ast).push({
      action: "mailbox.content.read", resource: "mailbox:payroll@example.com",
    });
    const result = checkButler(ast);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.findings.find((f) => f.code === "E_BUTLER_CAPABILITY_UNUSED");
    expect(found?.what).toContain("mailbox.content.read");
  });

  it("names a resource grain that names nothing, rather than admitting it and bounding nothing", () => {
    const ast = leadIntake();
    capabilitiesOf(ast)[0] = { action: "send.propose", resource: "sender:enquiries@example.com" };
    const result = checkButler(ast);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.findings.find((f) => f.code === "E_BUTLER_CAPABILITY_RESOURCE_UNKNOWN");
    expect(found?.what).toContain("sender:enquiries@example.com");
    // And the grain refusal does not swallow the under-declaration: with no interpretable resource the
    // action is still declared, so this Butler is refused once rather than twice. Asserted so that a later
    // change which made an uninterpretable resource also drop its action would be visible.
    expect(codes(ast)).toEqual(["E_BUTLER_CAPABILITY_RESOURCE_UNKNOWN"]);
  });

  it("accepts either half of a two-action requirement, and neither is padding", () => {
    // A `lookup` of a case is satisfied by metadata **or** content, so each alone publishes. The pair is the
    // one place where declaring two actions for one node is not over-declaration, and it is asserted rather
    // than reasoned about because the over-declaration pass is what would otherwise refuse it.
    for (const action of ["mailbox.metadata.read", "mailbox.content.read"] as const) {
      const ast = leadIntake();
      capabilitiesOf(ast).push({ action, resource: "mailbox:enquiries@example.com" });
      nodesOf(ast).push({
        id: "read_case", type: "lookup", entity: "case", entityId: "${event.case_id}",
        as: "row", next: "security_guard",
      });
      ast["entry"] = "read_case";
      expect(codes(ast), action).toEqual([]);
    }
  });

  it("does not price a graph whose ceiling is wrong, for the reason it does not price a broken one", () => {
    /*
     * A ceiling finding and an affordability finding at once would send an author to shrink a loop whose
     * real problem is a missing declaration. The capability pass runs first and returns, exactly as the
     * structural passes do ahead of it.
     */
    const ast = leadIntake();
    ast["capabilities"] = [];
    nodesOf(ast).push({
      id: "fan_out", type: "foreach", over: "${event.recipients}", as: "r",
      maxItems: 9_999, body: "send_one", next: null,
    });
    nodesOf(ast).push({ id: "send_one", type: "mail.send.propose", draft: "${steps.reply}", next: null });
    (nodesOf(ast).find((node) => node["id"] === "propose"))!["next"] = "fan_out";
    expect(codes(ast)).toEqual(["E_BUTLER_CAPABILITY_NOT_DECLARED"]);
  });
});

describe("the requirement map is total over the shipped node set", () => {
  it("classifies every shipped kind, so a new node cannot ship unclassified", () => {
    /*
     * The compiler already enforces this — `NEEDS` is a mapped type over `ShippedKind` — and asserting it
     * here as well is not redundant: the type would be satisfied by an entry returning `[]`, and this is the
     * place a reader can see *which* kinds return nothing and ask whether that is still true. Nine do, and
     * every one of them performs no I/O, which is the same line `cost.ts` draws for the same reason.
     */
    const free = SHIPPED_KINDS.filter((kind) =>
      requirementsOf({ id: "x", type: kind, entity: "message" } as unknown as ButlerNode).length === 0);
    expect(free.sort()).toEqual(
      ["foreach", "guard", "join", "map", "stop", "switch", "transform", "validate", "wait"],
    );
  });

  it("makes a lookup's requirement depend on the entity, because they are different disclosures", () => {
    const of = (entity: string): readonly (readonly CapabilityAction[])[] =>
      requirementsOf({ id: "x", type: "lookup", entity } as unknown as ButlerNode);
    expect(of("message")).toEqual([["mailbox.content.read"]]);
    expect(of("case")).toEqual([["mailbox.metadata.read", "mailbox.content.read"]]);
    // A draft is bounded by authorship rather than by a mailbox relation (0012), and the Butler can only
    // ever find its own — so it takes no capability at all.
    expect(of("draft")).toEqual([]);
    // An entity outside the enum — reachable only from a hand-edited stored AST — falls to the strongest
    // single requirement rather than to none. A `switch` with no default returned `undefined` here, which
    // read as "needs nothing" for exactly the input that must get the restrictive answer.
    expect(of("ledger")).toEqual([["mailbox.content.read"]]);
  });

  it("declares only actions a shipped node can require", () => {
    // `approval.decide`, `message.export`, `ediscovery.export` and `supervised.read` are real relations no
    // node checks. A ceiling naming one would be a declaration nothing reads — the `mailbox.metadata.read`
    // hole pointing the other way.
    const required = new Set(
      SHIPPED_KINDS.flatMap((kind) =>
        ["message", "case"].flatMap((entity) =>
          requirementsOf({ id: "x", type: kind, entity } as unknown as ButlerNode).flat())),
    );
    expect([...required].sort()).toEqual([...CAPABILITY_ACTIONS].sort());
  });
});

describe("the resolved ceiling, as the runtime reads it", () => {
  it("lowercases and deduplicates addresses per action, and omits an action nothing declared", () => {
    const resolved = ceilingByAction([
      { action: "send.propose", resource: "mailbox:Enquiries@Example.com" },
      { action: "send.propose", resource: "mailbox:enquiries@example.com" },
      { action: "send.propose", resource: "mailbox:invoices@example.com" },
    ]);
    expect(resolved.get("send.propose")).toEqual(["enquiries@example.com", "invoices@example.com"]);
    // Absent, not empty: the runtime treats a missing action as naming no mailbox at all and refuses
    // without issuing a query, which is what lets the refusal say "you never declared it".
    expect(resolved.has("mailbox.content.read")).toBe(false);
  });

  it("reads an address out of the one grain and refuses every other", () => {
    expect(mailboxAddressOf("mailbox:A@b.example")).toBe("a@b.example");
    expect(mailboxAddressOf("case_type:sales_lead")).toBeNull();
    expect(mailboxAddressOf("llm_profile:sales-intake@3")).toBeNull();
    expect(mailboxAddressOf("mailbox:")).toBeNull();
  });
});
