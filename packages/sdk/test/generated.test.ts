import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NOT_JSON, ROUTES, type RouteSpec } from "@mailda/contract/routes";

import { exposureOf } from "@mailda/contract/agent";

import { emit, methodNameFor } from "../src/generate.ts";
import { emitSkill } from "../src/skill.ts";
import { GeneratedClient, createClient } from "../src/index.ts";
import { ContractViolation, MaildaError } from "../src/transport.ts";

/**
 * The SDK is generated, and this is what makes that a fact rather than a habit (#85 step 3, ADR 12).
 *
 * ## The drift guard, and why it is a test rather than only a CI step
 *
 * `pnpm sdk:check` regenerates and fails on a diff — the same shape `receipts:check` has used since Layer 1.
 * That guards the repository. This guards the **developer**: a generated file that only CI re-derives is one
 * somebody edits by hand for an afternoon before finding out.
 */

const ALL: readonly RouteSpec[] = ROUTES;
const GENERATED = join(import.meta.dirname, "../src/generated.ts");

/** The tiers the Skill lists as withheld rather than offered. */
const WITHHELD_TIERS = new Set(["governed", "operator", "surface"]);

describe("the committed client is what the generator produces", () => {
  it("is byte for byte what the generator emits", () => {
    /*
     * **The first version of this test was vacuous, and it took a deliberate hand edit to notice.**
     *
     * It read the file, shelled out to the generator, and compared. But `generate.ts` ended with a top-level
     * `writeFileSync`, so importing it — which this file does, for `methodNameFor` — had already regenerated
     * the file before the test body ran. `before` was never the edited content, and the comparison could not
     * fail.
     *
     * Emitting is pure now and `src/write.ts` is the only thing that writes, so this compares the committed
     * bytes against a value computed in memory. A hand edit fails it.
     */
    expect(readFileSync(GENERATED, "utf8")).toBe(emit());
  });

  it("has one method per route, and the names are derived", () => {
    const source = readFileSync(GENERATED, "utf8");
    for (const spec of ALL) {
      const name = methodNameFor(spec);
      expect(source, `${spec.method} ${spec.path} has no method`).toContain(`  async ${name}(`);
    }
    // Anti-vacuity: the scan would pass over an empty registry, and this is the whole surface.
    expect(ALL.length).toBeGreaterThan(90);
  });

  it("derives a distinct name for every route", () => {
    /*
     * The generator throws on a collision rather than emitting one — two routes under one name would make
     * one of them silently unreachable, which is the absence-shaped failure this repository keeps finding.
     * Asserted here too, because the generator's throw is only reached when somebody runs it.
     */
    const names = ALL.map(methodNameFor);
    expect(new Set(names).size).toBe(names.length);
  });

  it("types the four non-JSON routes as Response, not as a parsed shape", () => {
    /*
     * They answer the interface shell, stored bytes, submitted bytes and an export object. Handing back a
     * parsed shape would be a description of the message rather than the message.
     */
    const source = readFileSync(GENERATED, "utf8");
    expect(NOT_JSON).toHaveLength(4);
    for (const entry of NOT_JSON) {
      const [method, path] = entry.split(" ");
      const spec = ALL.find((one) => one.method === method && one.path === path)!;
      // The parameterised ones take a `params` argument, so the return type is what is matched on.
      expect(source, entry).toMatch(
        new RegExp(`async ${methodNameFor(spec)}\\([^)]*\\): Promise<Response> \\{`),
      );
    }
  });
});

describe("the client talks to a Node and holds it to the contract", () => {
  /** A Node that answers whatever the test says, so the SDK's own behaviour is what is under test. */
  function clientAnswering(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []) {
    return createClient({
      origin: "https://node",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), {
          status, headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
    });
  }

  it("builds the path from the contract, encoding parameters", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = clientAnswering(200, {
      published: {
        butlerId: "btl_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        versionId: "btv_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        version: 1, supersededVersionId: null,
      },
    }, calls);

    await client.postButlersByButlerIdPublish({ butlerId: "btl_01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(calls[0]!.url).toBe("https://node/api/butlers/btl_01ARZ3NDEKTSV4RRFFQ69G5FAV/publish");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("throws a refusal as a MaildaError carrying the code", async () => {
    /*
     * Thrown rather than returned as a union, deliberately: a refusal is not an ordinary outcome of sealing
     * a send, and a caller that forgot to check a discriminant would send nothing and believe it had.
     */
    const client = clientAnswering(422, {
      error: "E_BUTLER_SOURCE_NOT_YAML", message: "the submitted source is not YAML",
    });
    await expect(client.getButlers()).rejects.toThrow(MaildaError);
    await expect(client.getButlers()).rejects.toMatchObject({
      status: 422, code: "E_BUTLER_SOURCE_NOT_YAML",
    });
  });

  it("throws a ContractViolation when the Node answers a shape the contract does not describe", async () => {
    /*
     * **The difference between this and a wrapper around `fetch`.** A Node that has drifted is caught at the
     * boundary, in the caller's process, with the offending field named — rather than three layers later
     * when something reads a field that is not there.
     *
     * Distinct from `MaildaError` on purpose: a refusal means *you* asked for something disallowed, and this
     * means the **Node** is wrong.
     */
    const client = clientAnswering(200, { health: "fine" });
    await expect(client.getHealth()).rejects.toThrow(ContractViolation);
  });

  it("does not validate when told not to, which is the rolling-upgrade case", async () => {
    /*
     * Response schemas are `.strict()`, so a newer Node that has added a field is a parse error — the right
     * default for catching drift and the wrong one for surviving an upgrade in progress. Naming the escape
     * hatch is what stops somebody reaching for `catch {}` instead.
     */
    const client = createClient({
      origin: "https://node",
      validate: false,
      fetch: (async () => new Response(JSON.stringify({ health: "fine" }), { status: 200 })) as never,
    });
    await expect(client.getHealth()).resolves.toEqual({ health: "fine" });
  });

  it("reads a refusal before validating, so a 4xx is never a contract violation", async () => {
    /*
     * The order matters and would be easy to get backwards: a 4xx body is a refusal shape rather than the
     * route's success shape, so validating first would report a contract violation for a Node that behaved
     * perfectly.
     */
    const client = clientAnswering(404, { error: "not_found", message: "No such Butler." });
    await expect(client.getButlersByButlerId({ butlerId: "btl_x" })).rejects.toThrow(MaildaError);
  });

  it("is one class, so every route is reachable from one client", () => {
    const client = createClient({ origin: "https://node" });
    expect(client).toBeInstanceOf(GeneratedClient);
    // A spot check that the surface is real rather than a type-level illusion.
    expect(typeof client.getHealth).toBe("function");
    expect(typeof client.postAuthPasskeysVerify).toBe("function");
    expect(typeof client.deleteAuthPasskeys).toBe("function");
  });
});

describe("the committed Skill is what the generator produces", () => {
  /*
   * The Skill had drifted, and the reason it drifted is the point of this block.
   *
   * `docs/machine-surfaces.md` says the Skill is *"generated by `pnpm skill`; `pnpm skill:check` fails on a
   * diff"* — and that script is real. Nothing runs it. The SDK beside it has the test above, so a stale
   * `generated.ts` fails `pnpm test`; a stale `SKILL.md` failed nothing, and was found only because an
   * unrelated change happened to regenerate it. It was wrong about the size of its own subject in both
   * directions at once: **52 capabilities against an actual 48, and 44 withheld against 56.**
   *
   * A document that tells an agent what it may not do, and is wrong by twelve acts about what is withheld, is
   * worse than no document. Some of those twelve are the ones that were reclassified *because* a machine must
   * not have them — so the stale copy was advertising exactly the acts somebody had decided to withhold.
   *
   * `emitSkill` was already pure and `src/write-skill.ts` already the only writer, which is the shape the
   * test above needed a bug to arrive at. So this costs one assertion and closes a document nothing watched.
   */
  const SKILL = join(import.meta.dirname, "../../../skills/mailda/SKILL.md");

  it("is byte for byte what the generator emits", () => {
    expect(
      readFileSync(SKILL, "utf8"),
      "skills/mailda/SKILL.md is not what `pnpm skill` produces. It tells an agent what this Node withholds, "
      + "so a stale copy advertises acts somebody decided a machine must not have. Run `pnpm skill`.",
    ).toBe(emitSkill());
  });

  it("counts what the registry counts, so its own numbers cannot go stale silently", () => {
    /*
     * Derived from the emitted text rather than restated, and the reason is `docs/machine-surfaces.md`'s tier
     * table: five hand-written counts, all five wrong at once, for five layers. The byte comparison above
     * already covers this — but it fails with a diff, and a diff of a 300-line document does not say *"the
     * headline number is wrong"*. This one names it.
     */
    const text = emitSkill();
    const offered = ALL.filter((spec) => !WITHHELD_TIERS.has(exposureOf(spec).tier)).length;
    const withheld = ALL.length - offered;
    expect(text, `the offered count is not ${offered}`).toContain(`${offered} capabilities`);
    expect(text, `the withheld count is not ${withheld}`).toContain(`${withheld} withheld`);
  });
});
