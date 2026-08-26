import { specFor, type RouteSpec } from "@mailda/contract/routes";
import type * as z from "zod";

import { CallerError, unprocessable } from "./errors.ts";

/**
 * The request boundary: a body may not name a field a closed set in the contract does not contain (#93).
 *
 * ## The defect this closes, because it is not obvious from the outside
 *
 * `conditionsFrom` in `index.ts` reads a policy's five conditions by name and drops everything else. A
 * caller who wrote `{"conditions":{"mailbox_id":"mbx_…"}}` — snake case instead of camel — got `{}`, which
 * stores five NULLs, which is a policy version **matching every send in the organization**. The `allow`
 * meant to narrow a gate widened it; the `deny` stopped all outbound mail; the `require_approval` gated the
 * whole Node. And the caller was told the policy was created, because it was. Publishing is immutable and
 * versioned, so the wrong rule is now a numbered version doing exactly what it was written to do.
 *
 * `conditionsFrom`'s own comment named this hole and said the fix belonged with the contract in
 * `packages/contract`, *"which is where every channel's validation is generated from — a second
 * hand-written validator in this file is the correspondence problem `errors.ts` already rejected once"*.
 * That was right, and the contract did not exist. It does now (#85) — and it was **descriptive**: the only
 * thing on this Node that read it was `mcp.ts`, behind a dynamic import, to *generate tool schemas from*
 * the request specs. Nothing ever checked a body against one. So the machinery arrived and the hole stayed
 * open, which is the shape worth remembering: a package can be complete, imported, tested, and still not
 * load-bearing. This is the import that makes it load-bearing.
 *
 * ## Unknown fields only, and the name says so
 *
 * `refuseUnknownFields` is not `validateRequest`, and the difference is deliberate rather than partial.
 * The handlers already refuse bad *values* with four-part messages a schema cannot produce —
 * `E_BAD_POLICY_OUTCOME` names the four outcomes, `E_BAD_POLICY_VOLUME` explains why a floor of 0 is an
 * unconditional rule in disguise, `E_TRANSPORT_NEEDS_BOTH` explains why half a credential is worse than
 * none. Parsing the whole body here would preempt every one of them with *"Invalid input: expected
 * string"*, which is a regression dressed as validation.
 *
 * What no handler can refuse is a field it never reads, because there is nothing there to look at. That is
 * the one thing this does, for every route whose request schema declares a closed set, and nothing else.
 *
 * ## Applied centrally, before the route and before authentication
 *
 * Centrally for the reason `noStore` is: a check every future handler has to remember is a check that will
 * be forgotten, and the forgotten case here is silent by construction. Before authentication because a
 * malformed body is not a permission question and refusing it discloses only the contract, which every
 * generated client already carries. `handleMcp` re-enters this Worker's own `fetch`, so the MCP surface is
 * covered by the same check rather than by a second copy of it.
 *
 * The cost is one extra parse of a body already being parsed downstream, and only on the routes that
 * declare a closed set. Zod on the request path is the decision `docs/receipts/runtime-validator.md`
 * measured and took.
 *
 * ## What would make this wrong again
 *
 * A route that grows a request schema and is never reached by this function — which reads exactly like a
 * route that is covered. `apps/node/worker/test/node/request-shape-world.test.ts` is the closed world that
 * fails when that happens.
 */

/** One place a body named something a closed set does not have. */
interface UnknownField {
  readonly path: readonly PropertyKey[];
  readonly keys: readonly string[];
}

type Issue = z.core.$ZodIssue;

/**
 * Every unrecognised key in a parse failure, including the ones inside a union branch.
 *
 * Zod reports a strict object *inside a union* as `invalid_union` carrying one error list per branch, so an
 * unknown stage field would otherwise be invisible here. **A branch that failed only on unrecognised keys
 * is the branch the caller meant**: the value satisfied that branch's entire shape and then named a field
 * it does not have. A branch that also failed on a type never described this value at all, and reporting
 * its unknown keys would tell a caller who sent `2` that a number has no `team`.
 */
function unknownFields(issues: readonly Issue[], base: readonly PropertyKey[] = []): UnknownField[] {
  const found: UnknownField[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    // `path` is the object that did not recognise the key, not the key itself — which is exactly the
    // position the closed set has to be read from.
    if (issue.code === "unrecognized_keys") found.push({ path, keys: issue.keys });
    else if (issue.code === "invalid_union") {
      for (const branch of issue.errors) {
        if (branch.length > 0 && branch.every((one) => one.code === "unrecognized_keys")) {
          found.push(...unknownFields(branch, path));
        }
      }
    }
  }
  return found;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Zod's internal `def` is untyped by design; the
   walk below is the one place that reads it, and every branch is guarded by its own `type` tag. */
type Node = { readonly def: any; meta: () => Record<string, unknown> | undefined };

/**
 * Peels the wrappers that do not change a shape's fields, so `conditions?: {…}` reaches the object.
 *
 * A named set rather than "anything with an `innerType`", so a wrapper that *does* change the fields — a
 * `pipe`, a `lazy` — stops the walk and produces the degraded message instead of a confidently wrong list.
 */
const TRANSPARENT = new Set(["optional", "nullable", "nonoptional", "default", "prefault", "readonly", "catch"]);

function unwrap(node: Node | undefined): Node | undefined {
  let at = node;
  while (at !== undefined && TRANSPARENT.has(at.def?.type as string)) at = at.def.innerType as Node;
  return at;
}

/**
 * The closed set a body named a field outside of, walked from the request schema down the issue's path.
 *
 * Walked rather than looked up, because the refusal has to name **the five fields that exist**, and only
 * the schema knows them. A hand-written list here would be the correspondence problem this file exists to
 * avoid: the contract would gain a sixth condition and the error message would keep naming five.
 *
 * A union resolves to its object member, because a body with named fields was trying to satisfy that one.
 */
function closedSetAt(schema: unknown, path: readonly PropertyKey[]): { known: readonly string[]; code: string } | null {
  let at = unwrap(schema as Node);
  for (const key of path) {
    const def = at?.def;
    if (def === undefined) return null;
    if (def.type === "object" && typeof key === "string") at = unwrap(def.shape[key] as Node | undefined);
    else if (def.type === "array") at = unwrap(def.element as Node);
    else if (def.type === "record") at = unwrap(def.valueType as Node);
    else return null;
  }
  if (at?.def?.type === "union") {
    at = (at.def.options as Node[]).map(unwrap).find((option) => option?.def?.type === "object");
  }
  if (at?.def?.type !== "object") return null;
  return {
    known: Object.keys(at.def.shape as Record<string, unknown>),
    /*
     * The `E_` code travels with the schema (`.meta({ refusal })`) rather than living in a table here, for
     * the reason `errors.ts` gives for the status travelling with the throw: two places that must agree,
     * edited separately, where forgetting the second one silently downgrades the refusal.
     */
    code: typeof at.meta()?.["refusal"] === "string" ? at.meta()!["refusal"] as string : "E_REQUEST_FIELD_UNKNOWN",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Whether every letter of `inner` appears in `outer`, in order. A dropped letter, said without a number. */
function subsequence(inner: string, outer: string): boolean {
  let at = 0;
  for (const letter of outer) if (letter === inner[at]) at += 1;
  return at === inner.length;
}

/**
 * The field a caller probably meant, or null.
 *
 * **Not edit distance, and that is a receipt question rather than a taste one.** "Within two edits" is a
 * threshold with no measurement behind it, and AGENTS.md §2 does not exempt a number for being small. What
 * this uses instead needs none: case and punctuation are erased, and one name is offered when it contains
 * the other's letters in order. That covers the whole observed family — `mailbox_id` for `mailboxId`,
 * `conditons` for `conditions`, `teamid` for `teamId` — and it is a fact about two strings rather than a
 * tuned cutoff.
 *
 * Ambiguity resolves to null: a short key is a subsequence of several long names, and naming the wrong one
 * is worse than naming none. The closed set is listed either way, so a suggestion only ever saves a step.
 */
function nearMiss(key: string, known: readonly string[]): string | null {
  const plain = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const given = plain(key);
  const candidates = known.filter((name) => {
    const other = plain(name);
    return subsequence(given, other) || subsequence(other, given);
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * The refusal for one position's worth of unknown keys.
 *
 * **Every key at that position, and only that position.** All the keys, because a caller who sent two typos
 * should fix two typos rather than discover the second on the next round trip. Only one position, because the
 * `E_` code belongs to a closed set — a message about a stage carrying `E_POLICY_CONDITION_UNKNOWN` would
 * break the one thing a caller's error handling can key on, and there is no honest code for "two different
 * sets". A second position is a second refusal, after the first is fixed.
 */
function refusal(spec: RouteSpec, field: UnknownField): CallerError {
  const set = closedSetAt(spec.request, field.path);
  const prefix = field.path.map(String);
  const where = field.keys.map((key) => [...prefix, key].join(".")).join(", ");
  // Suggested only when there is one key to suggest for: with two, "did you mean" would silently be about
  // whichever came first.
  const near = set === null || field.keys.length > 1 ? null : nearMiss(field.keys[0]!, set.known);
  return unprocessable(set?.code ?? "E_REQUEST_FIELD_UNKNOWN", {
    what: `${spec.method} ${spec.path} was sent ${where}, which is not a field it has`,
    why: "this Node stores only the fields it names, so an unrecognised one reaches nothing — and a dropped "
      + "field is not a smaller request, it is a different one. A misspelled policy condition published a "
      + "rule matching every send in the organization and reported it as created (#93)",
    fix: set === null
      // Unreachable from the schemas as written: every strict object in the contract is walkable from its
      // request schema. Kept because the alternative to a worse message is no message.
      ? `remove ${where}, or see the request schema for ${spec.method} ${spec.path} in packages/contract/src/schemas.ts`
      : `${near === null ? "" : `did you mean ${near}? `}the fields at this position are: ${set.known.join(", ")}`,
  });
}

/**
 * Refuses a body that names a field the contract's closed set for this route does not contain.
 *
 * Returns for a body that is not JSON at all rather than refusing it: there is no closed set to compare a
 * non-object against, and the handler downstream refuses it by its own account — `{}` reaches
 * `E_POLICY_NEEDS_A_NAME`. Nothing is swallowed, because nothing was caught: the request continues to the
 * refusal that was already there.
 *
 * The body is read from a clone so the handler still gets to read it. Only for the routes that declare a
 * schema, so no route pays for a check it does not have.
 */
export async function refuseUnknownFields(request: Request, pathname: string): Promise<void> {
  const spec = specFor(request.method, pathname);
  if (spec?.request === undefined) return;

  const body = await request.clone().json().then((value: unknown) => value, () => undefined);
  if (body === undefined) return;

  const parsed = spec.request.safeParse(body);
  if (parsed.success) return;
  const fields = unknownFields(parsed.error.issues);
  // Empty for every failure that is not an unknown field — a bad outcome, a missing name — and those are
  // deliberately the handler's to refuse. See the note above on why this is not `validateRequest`.
  if (fields.length === 0) return;
  throw refusal(spec, fields[0]!);
}
