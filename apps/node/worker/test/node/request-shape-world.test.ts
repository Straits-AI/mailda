import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { path } from "@mailda/contract/routes";

import { CallerError } from "../../src/errors.ts";
import { refuseUnknownFields } from "../../src/request-shape.ts";
import { PROBE_FIELD, closedSets, probeBody, routesWithRequestSchema } from "../closed-sets.ts";

/**
 * The closed world #93 asks for: every closed set the contract declares is one the boundary enforces.
 *
 * ## Why the tripwire is shaped like this and not like a list of cases
 *
 * The defect was not a missing check. It was a check that **could not be seen to be missing**: `packages/
 * contract` had request schemas, the Worker did not import them, and a route with a schema read exactly like
 * a route that was validated. Nothing was red. A test per condition key would have the same property — it
 * would prove the five cases somebody thought of, and go on passing when a sixth closed set arrived
 * unenforced.
 *
 * So this walks the contract, finds every strict object reachable from every route's request schema, and
 * drives the boundary against each. A new strict schema is covered the moment it is written; a strict schema
 * the boundary cannot reach fails here.
 *
 * ## Node rather than workerd, and what that costs
 *
 * `src/request-shape.ts` touches no binding, no `cloudflare:` import and no clock — it is the contract, a
 * `Request` clone and a throw — so it runs here, where a failure names the schema rather than a fetch. What
 * that does **not** prove is that a real Node reaches the function at all, which is the other half of #93 and
 * is `test/request-shape.test.ts`'s job. Neither half is sufficient: this one would pass over a boundary
 * nobody called, and that one cannot enumerate.
 */

const INDEX = join(import.meta.dirname, "../../src/index.ts");

/** A probe request for one closed set: the route's own method and a filled-in path. */
function probeFor(set: { spec: { method: string; path: string }; path: readonly PropertyKey[] }): {
  request: Request; pathname: string;
} {
  const params = Object.fromEntries(
    [...set.spec.path.matchAll(/:(\w+)/g)].map((match) => [match[1]!, "probe"]),
  );
  const pathname = path(set.spec as never, params);
  return {
    request: new Request(`https://node${pathname}`, {
      method: set.spec.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(probeBody(set.path)),
    }),
    pathname,
  };
}

async function refusalFor(set: ReturnType<typeof closedSets>[number]): Promise<CallerError | null> {
  const { request, pathname } = probeFor(set);
  try {
    await refuseUnknownFields(request, pathname);
    return null;
  } catch (error) {
    if (error instanceof CallerError) return error;
    throw error;
  }
}

describe("every closed set the contract declares is a closed set the boundary enforces", () => {
  it("finds closed sets to check, so nothing below passes by iterating an empty list", () => {
    /*
     * Anti-vacuity, and it is the assertion this file most needs. Every check below is a loop over a walk of
     * Zod's internals; if the walk stopped finding objects — a Zod upgrade renaming `catchall`, a bad
     * refactor — every one of them would pass over nothing and report the world closed.
     *
     * A floor rather than an equality, so an eighth closed set does not need this line edited — and the
     * routes and positions are named below, so a walk that found *different* things fails too. There are
     * eight today: a policy body, its conditions and its stage shape, twice over, the search repair body and
     * the agent mint body.
     */
    const sets = closedSets();
    expect(sets.length).toBeGreaterThan(3);
    expect(new Set(sets.map((set) => `${set.spec.method} ${set.spec.path}`))).toEqual(new Set([
      /*
       * Minting an agent (#109 L2). Strict, and the argument is stronger than the policy body's: the payload
       * names a sponsor and a pinned ceiling, and a misspelled `actions` key silently dropped would mint a
       * credential with an empty ceiling — refused by `E_AGENT_NO_ACTIONS`, which is the right refusal for
       * the wrong reason and tells the caller nothing about the typo.
       */
      "POST /api/agents",
      "POST /api/policies",
      "PUT /api/policies/:policyId/draft",
      /*
       * Repairing the body index (0044). Strict, and the argument is the same shape as the policy body's: the
       * payload is a list of message ids and nothing else, so a misspelled key is a caller believing they
       * scoped a repair when they asked for one over an empty list. The route already refuses an empty list
       * with a 422 naming the listing route, and a silently-dropped `messageIds` would reach that refusal
       * looking like a caller who passed nothing on purpose.
       */
      "POST /api/search/repair",
    ]));
    expect(sets.some((set) => set.path.join(".") === "conditions")).toBe(true);
    expect(sets.some((set) => set.path.join(".") === "stages.0")).toBe(true);
  });

  it("refuses an unrecognised key at every one of them", async () => {
    const unenforced: string[] = [];
    for (const set of closedSets()) {
      if (await refusalFor(set) === null) {
        unenforced.push(`${set.spec.method} ${set.spec.path} at ${set.path.join(".") || "the body"}`);
      }
    }
    expect(
      unenforced.length === 0 ? null
        : `${unenforced.join("; ")} — the contract declares a closed set here and the boundary accepted a `
          + "field outside it. That is #93 exactly: a route that has a schema and does not apply it reads "
          + "like a route that is covered.",
    ).toBeNull();
  });

  it("names the offending field, the fields that exist, and a stable code", async () => {
    const wrong: string[] = [];
    for (const set of closedSets()) {
      const refusal = await refusalFor(set);
      if (refusal === null) continue;   // the check above is the one that fails for this.
      const where = [...set.path, PROBE_FIELD].join(".");
      // AGENTS.md §3: the code, the thing and the ask, the identifiers, and what would change it. Here the
      // "ask" is the field that was sent and the "budget" is the set of fields that exist.
      if (!refusal.message.includes(where)) wrong.push(`${refusal.code} does not name ${where}`);
      for (const field of set.known) {
        if (!refusal.message.includes(field)) wrong.push(`${refusal.code} does not name ${field}`);
      }
      if (refusal.status !== 422) wrong.push(`${refusal.code} answers ${refusal.status}, not 422`);
      /*
       * The code comes from the schema, so a closed set that declares none would refuse with the generic
       * fallback — greppable, but not the *stable* code a caller's error handling can key on. Asserting the
       * declaration here is what stops the fallback becoming the normal case.
       */
      if (set.refusal === undefined) {
        wrong.push(`${set.spec.method} ${set.spec.path} at ${set.path.join(".") || "the body"} declares no `
          + "refusal code — add .meta({ refusal: \"E_…\" }) beside the .strict()");
      } else if (refusal.code !== set.refusal) {
        wrong.push(`refused with ${refusal.code} where the schema declares ${set.refusal}`);
      }
    }
    expect(wrong.length === 0 ? null : wrong.join("; ")).toBeNull();
  });

  it("suggests the near miss for the spellings #93 was reported against", async () => {
    /*
     * The suggestion is the difference between a caller fixing this in ten seconds and a caller reading the
     * schema, so it is asserted on the shapes a real client actually produces: a snake-case language, and a
     * dropped letter. Both are covered without a threshold — see `nearMiss`.
     */
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ conditions: { mailbox_id: "mbx_1" } }, "did you mean mailboxId?"],
      [{ conditions: { ORGDAILYVOLUMEMIN: 1 } }, "did you mean orgDailyVolumeMin?"],
      [{ conditons: {} }, "did you mean conditions?"],
      /*
       * `teem` gets no suggestion, and that is the rule working rather than failing: a *substituted* letter
       * is neither a subsequence nor a superstring, and admitting it would mean "one position may differ",
       * which is a threshold. The closed set is listed either way — `count, team, teamId` is three words
       * long — so the caller loses a hint and not the answer. Asserted so the absence is a decision.
       */
      [{ stages: [{ count: 1, teem: "tm_1" }] }, "the fields at this position are: count, team, teamId"],
    ];
    for (const [body, expected] of cases) {
      let refusal: CallerError | null = null;
      try {
        await refuseUnknownFields(
          new Request("https://node/api/policies", { method: "POST", body: JSON.stringify(body) }),
          "/api/policies",
        );
      } catch (error) {
        refusal = error as CallerError;
      }
      expect(refusal?.message, JSON.stringify(body)).toContain(expected);
    }
  });

  it("names every unknown key at the position, so two typos are one round trip", async () => {
    // And no suggestion, because with two keys "did you mean" would silently be about whichever came first.
    let refusal: CallerError | null = null;
    try {
      await refuseUnknownFields(
        new Request("https://node/api/policies", {
          method: "POST",
          body: JSON.stringify({ conditions: { mailbox_id: "mbx_1", is_reply: true } }),
        }),
        "/api/policies",
      );
    } catch (error) { refusal = error as CallerError; }
    expect(refusal?.message).toContain("conditions.mailbox_id, conditions.is_reply");
    expect(refusal?.message).not.toContain("did you mean");
  });

  it("says nothing when it cannot tell, rather than naming the wrong field", async () => {
    // `id` is a subsequence of both `mailboxId` and `actorUserId`. A confident wrong suggestion sends a
    // caller to change a field that was never the problem, so ambiguity resolves to the list alone.
    let refusal: CallerError | null = null;
    try {
      await refuseUnknownFields(
        new Request("https://node/api/policies", { method: "POST", body: JSON.stringify({ conditions: { id: 1 } }) }),
        "/api/policies",
      );
    } catch (error) { refusal = error as CallerError; }
    expect(refusal?.message).not.toContain("did you mean");
    expect(refusal?.message).toContain("mailboxId, actorUserId");
  });
});

describe("the boundary refuses unknown fields and nothing else", () => {
  it("leaves a bad value to the handler, whose refusal says more than a schema can", async () => {
    /*
     * `outcome: 7` is not a policy outcome, and the handler answers `E_BAD_POLICY_OUTCOME` naming the four
     * that exist and *why* there cannot be a fifth — conflict resolution is a maximum over a total order.
     * Parsing the whole body here would replace that with "expected string", which is a regression wearing
     * the clothes of validation. Hence `refuseUnknownFields`, not `validateRequest`.
     */
    await expect(refuseUnknownFields(
      new Request("https://node/api/policies", {
        method: "POST", body: JSON.stringify({ name: "x", outcome: 7 }),
      }),
      "/api/policies",
    )).resolves.toBeUndefined();
  });

  it("passes a body that is not JSON straight through, because there is no set to compare it against", async () => {
    // Not swallowed: the handler's `request.json().catch(() => ({}))` reaches `E_POLICY_NEEDS_A_NAME`, which
    // is a refusal a person can act on. A 500 from a parse in the middleware would not be.
    await expect(refuseUnknownFields(
      new Request("https://node/api/policies", { method: "POST", body: "not json" }),
      "/api/policies",
    )).resolves.toBeUndefined();
  });

  it("leaves the body readable, so the handler still gets it", async () => {
    const request = new Request("https://node/api/policies", {
      method: "POST", body: JSON.stringify({ name: "x", outcome: "deny" }),
    });
    await refuseUnknownFields(request, "/api/policies");
    expect(await request.json()).toEqual({ name: "x", outcome: "deny" });
  });

  it("ignores a route with no request schema at all", async () => {
    await expect(refuseUnknownFields(
      new Request("https://node/api/sends", { method: "POST", body: JSON.stringify({ anything: 1 }) }),
      "/api/sends",
    )).resolves.toBeUndefined();
  });

  it("ignores a path no route serves, rather than turning a stray URL into a 500", async () => {
    // `specFor` returns null instead of throwing for exactly this. An unmatched `/api/…` path is the
    // handler's 404 to give, and a boundary that threw would make every typo an internal error.
    await expect(refuseUnknownFields(
      new Request("https://node/api/policiez", { method: "POST", body: JSON.stringify({ anything: 1 }) }),
      "/api/policiez",
    )).resolves.toBeUndefined();
    // And the same path under a verb no route registers: method is part of a route's identity.
    await expect(refuseUnknownFields(
      new Request("https://node/api/policies", { method: "PATCH", body: JSON.stringify({ anything: 1 }) }),
      "/api/policies",
    )).resolves.toBeUndefined();
  });
});

describe("strictness is decided per route, not turned on globally", () => {
  /**
   * #93's "deliberately not in this ticket" is this line: **making every request schema strict**. Some
   * routes genuinely want to tolerate an added field, and the ones that do not have an argument written
   * beside them in `packages/contract/src/schemas.ts`.
   *
   * Asserted as an exact set, in both directions, so neither drift is quiet: a route acquiring strictness
   * without the argument fails, and so does a route losing it. The second is the one worth having — it is how
   * the policy body would go back to publishing rules nobody wrote.
   */
  it("names exactly the routes that refuse an unknown field, and exactly the ones that accept one", async () => {
    const strict: string[] = [];
    const tolerant: string[] = [];
    for (const spec of routesWithRequestSchema()) {
      const name = `${spec.method} ${spec.path}`;
      const params = Object.fromEntries(
        [...spec.path.matchAll(/:(\w+)/g)].map((match) => [match[1]!, "probe"]),
      );
      const pathname = path(spec as never, params);
      const request = new Request(`https://node${pathname}`, {
        method: spec.method, body: JSON.stringify({ [PROBE_FIELD]: "x" }),
      });
      try {
        await refuseUnknownFields(request, pathname);
        tolerant.push(name);
      } catch {
        strict.push(name);
      }
    }
    expect(strict.sort()).toEqual([
      "POST /api/agents", "POST /api/policies", "POST /api/search/repair",
      "PUT /api/policies/:policyId/draft",
    ]);
    expect(tolerant.sort()).toEqual([
      "POST /api/auth/login",
      "POST /api/auth/passkeys/challenge",
      "POST /api/butlers",
      "POST /api/butlers/:butlerId/simulate",
      /*
       * A recovery code (#92). Tolerant, and the reasoning is the same shape as `POST /api/auth/login`
       * beside it: the body is one credential, an extra field changes nothing about what the Node does with
       * it, and there is no closed set for a misspelling to silently empty. A missing or misspelled `code`
       * is refused by name — `E_RECOVERY_CODE_UNKNOWN` — rather than quietly becoming an unconstrained
       * anything, which is the failure #93 exists to prevent and the reason the policy routes are strict.
       */
      /*
       * Confirming a recovery code shares the redeem route's request schema, so it inherits its tolerance —
       * and the reasoning carries across intact: the body is one credential, an extra field changes nothing,
       * and a wrong or missing code is refused by name (`E_RECOVERY_CODE_UNKNOWN`) rather than becoming an
       * unconstrained anything. It is listed separately rather than derived from the shared schema, because
       * two routes sharing a shape today is not an argument that they always will.
       */
      /*
       * Opening a matter, and saving a draft. Both acquired a request schema when the machine surface was
       * corrected — a route with no declared request publishes an MCP tool that takes **no body**, so the one
       * writing act an agent is offered could not say what the draft said.
       *
       * Tolerant rather than strict, and the distinction is #93's own: the policy and Butler bodies are strict
       * because every field decides which sends a rule catches, so a misspelling silently empties a closed
       * set. A draft is text a person reads before anything leaves, and a matter is a folder with a type the
       * domain refuses by name (`E_MATTER_TYPE_UNKNOWN`, which lists the four). Nothing here can be silently
       * emptied, and strictness would refuse a client that sent a field a newer Node had added.
       */
      "POST /api/matters",
      "POST /api/recovery-codes/confirm",
      /*
       * Acknowledging a key collision. Tolerant, for the reason the routes around it are: the two fields are
       * free text a person wrote, both are refused when blank by the domain, and there is no closed set a
       * misspelling could silently empty.
       */
      "POST /api/recovery/conflicts/:restoreId/acknowledge",
      "POST /api/recovery/redeem",
      "PUT /api/butlers/:butlerId/draft",
      "PUT /api/drafts",
      "PUT /api/transport",
    ]);
  });
});

describe("the contract's five conditions are the five the Node stores", () => {
  /**
   * The other correspondence #93 could break, and the reason to hold it here rather than trust it.
   *
   * The refusal names the fields **from the schema**, so the message cannot go stale on its own. What can go
   * stale is the schema against the code: a sixth condition added to `PolicyConditions` and the five columns
   * but not to `policyConditions` would be refused at the boundary as unknown — a field the Node supports,
   * rejected by its own contract, with a message listing five.
   *
   * Read lexically for the reason `route-registry.test.ts` reads lexically: `src/index.ts` is a Worker module
   * and cannot be imported under Node. The narrowness is stated rather than hidden — this sees `source.x`
   * inside `conditionsFrom` and nothing else — and it fails in the safe direction, because a read the
   * extractor cannot see is a name missing from the left-hand set.
   */
  it("agrees with `conditionsFrom` about which keys are read", () => {
    const source = readFileSync(INDEX, "utf8");
    const body = /function conditionsFrom\(raw: unknown\): PolicyConditions \{([\s\S]{0,2000}?)\n\}/.exec(source);
    expect(body, "conditionsFrom is no longer where this test expects it").not.toBeNull();
    const read = [...body![1]!.matchAll(/source\.(\w+)/g)].map((match) => match[1]!);
    // Anti-vacuity: a regex that matched nothing would agree with an empty schema.
    expect(read.length).toBe(5);

    const conditions = closedSets().find((set) => set.path.join(".") === "conditions");
    expect([...read].sort()).toEqual([...conditions!.known].sort());
  });
});
