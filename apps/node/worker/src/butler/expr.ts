/**
 * The expression language a Butler's `Expr` fields are written in, and the JSON Schema subset `validate`
 * checks against (#50).
 *
 * ## Why this is here and not in `packages/butler-ast`
 *
 * #49 left an `Expr` as *"an opaque non-empty string"* and said so in as many words: *"the engine (#50) is
 * what has to evaluate it"*, and a grammar invented in the AST package would have been a third opinion about
 * a syntax whose first two readers did not exist. This is the second reader. #52 — the taint checker — is
 * the third, and it needs to understand the *inside* of an expression, so what matters most about this file
 * is that the language is small enough to be analysable rather than expressive enough to be convenient.
 *
 * ## The whole language, stated because a language nobody can enumerate is a language nobody can check
 *
 * Three forms, and nothing else:
 *
 * | Form | Where §16 uses it | Result |
 * |:--|:--|:--|
 * | a **path** — `event.subject`, `steps.reply.id` | `guard.when`'s left side | the value at that path |
 * | an **interpolation** — `"Re: ${event.subject}"` | every value field | a string, or the value itself when the whole expression is one `${…}` |
 * | a **comparison** — `event.security.malware != "clean"` | `guard.when`, `switch.on` | a boolean |
 *
 * Three operators: `==`, `!=`, `contains`. No arithmetic, no function calls, no indexing, no boolean
 * combinators. Each of those is a decision to add later with a taint rule attached, and each would widen
 * what #52 has to reason about. **Anything else is refused by name at runtime**, which is the whole point of
 * keeping the set closed: an author who writes `event.count > 3` is told that `>` is not in the language,
 * rather than having it silently evaluate as a string comparison.
 *
 * ## Two roots, and a missing path is a fault rather than `undefined`
 *
 * `event` is what the trigger carried. `steps` is what `as` bound. `butler` is the running program's own
 * identity, which is there because a Butler's principal is the Butler (see `principal.ts`) and a
 * `case.assign` that wants to assign to the Butler itself has to be able to name it.
 *
 * A path that does not resolve **throws**. The alternative — `undefined`, stringified into a subject line as
 * `"undefined"` — is the silent direction, and this repository's rule is that a wrong value ends a reader's
 * question while a blank prompts one. A Butler naming a field the trigger does not carry is a program
 * reading something that is not there, and the run says which path and what roots exist.
 *
 * ## Interpolating a non-primitive is refused
 *
 * `"${steps.rows}"` where `rows` is an array would produce `[object Object]` or a comma-joined string in a
 * recipient list. Refused, naming the path and its type. The one exception is the **whole-expression** case:
 * `over: "${steps.rows}"` returns the array itself, because a loop's `over` has to be one, and that is why
 * `evaluate` distinguishes the two rather than always returning a string.
 */

/** The four-part refusal AGENTS.md §3 requires, for a fault inside a run rather than in a caller's request. */
export class ButlerFault extends Error {
  constructor(
    readonly code: string,
    detail: { what: string; why: string; fix: string },
    /** The node being interpreted when this happened, when there is one. */
    readonly node?: string,
  ) {
    super(
      `${code}  ${detail.what}${node === undefined ? "" : `\n  node     ${node}`}`
      + `\n  why      ${detail.why}\n  fix      ${detail.fix}`,
    );
    this.name = code;
  }
}

/** The roots a path may start at. Closed, and named in every refusal so an author is not left guessing. */
export const STATE_ROOTS = ["event", "steps", "butler"] as const;

export interface RunState {
  /** What the trigger carried: the facts about the delivery that fired this run. */
  readonly event: Readonly<Record<string, unknown>>;
  /** The running program's own identity — `butler.id` is its principal. */
  readonly butler: Readonly<Record<string, unknown>>;
  /** What `as` bound, keyed by binding name. Mutable: the interpreter writes to it as the run proceeds. */
  readonly steps: Record<string, unknown>;
}

const PATH = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/i;

/**
 * The value at a dotted path, or a fault naming the path.
 *
 * Deliberately does **not** support array indexing (`steps.rows.0.id`). A loop is the way this language
 * reaches into a collection, and it declares a bound; indexing would be a second way with no bound at all.
 */
export function resolve(path: string, state: RunState, node?: string): unknown {
  if (!PATH.test(path)) {
    throw new ButlerFault("E_BUTLER_EXPR_NOT_A_PATH", {
      what: `${JSON.stringify(path)} is not a path`,
      why: "a path is dotted lowercase segments starting with a letter; there is no indexing, no arithmetic "
        + "and no function call in this language",
      fix: `write one of ${STATE_ROOTS.join(", ")} followed by dotted field names`,
    }, node);
  }
  const [root, ...rest] = path.split(".");
  if (!(STATE_ROOTS as readonly string[]).includes(root!)) {
    throw new ButlerFault("E_BUTLER_EXPR_UNKNOWN_ROOT", {
      what: `${JSON.stringify(path)} starts at ${JSON.stringify(root!)}, which is not a root of a run's state`,
      why: "a run's state has exactly three roots: what the trigger carried, what this Butler's own nodes "
        + "bound, and the Butler's own identity",
      fix: `start the path at one of: ${STATE_ROOTS.join(", ")}`,
    }, node);
  }

  let cursor: unknown = state[root as keyof RunState];
  const walked: string[] = [root!];
  for (const segment of rest) {
    if (cursor === null || typeof cursor !== "object") {
      throw new ButlerFault("E_BUTLER_EXPR_UNRESOLVED", {
        what: `${JSON.stringify(path)} cannot be resolved: ${walked.join(".")} is `
          + `${cursor === null ? "null" : typeof cursor}, so it has no field ${JSON.stringify(segment)}`,
        why: "a path that resolves to nothing would be interpolated as the word \"undefined\" and sent, "
          + "which is a wrong value ending a reader's question where a blank would have prompted one",
        fix: `read a field that exists. ${walked.join(".")} carries no fields`,
      }, node);
    }
    if (!Object.hasOwn(cursor as object, segment)) {
      const available = Object.keys(cursor as object).sort();
      throw new ButlerFault("E_BUTLER_EXPR_UNRESOLVED", {
        what: `${JSON.stringify(path)} cannot be resolved: ${walked.join(".")} has no field `
          + JSON.stringify(segment),
        why: "a path that resolves to nothing would be interpolated as the word \"undefined\" and sent",
        fix: available.length === 0
          ? `${walked.join(".")} is empty`
          : `${walked.join(".")} carries: ${available.join(", ")}`,
      }, node);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
    walked.push(segment);
  }
  return cursor;
}

/** `${…}`, non-greedy, so two in one string are two substitutions rather than one spanning both. */
const INTERPOLATION = /\$\{([^}]*)\}/g;

function primitive(value: unknown, path: string, node?: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new ButlerFault("E_BUTLER_EXPR_NOT_PRIMITIVE", {
    what: `\${${path}} is ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}, `
      + "which cannot be interpolated into a string",
    why: "an array or an object rendered into a subject line or a recipient list produces "
      + "\"[object Object]\" or a comma-joined string, and both would be sent",
    fix: `interpolate a field of ${path}, or — if a whole value is wanted — make the expression exactly `
      + `"\${${path}}" so the value is used as it is`,
  }, node);
}

/**
 * Evaluates one `Expr` field.
 *
 * The **whole-expression** case is the reason this returns `unknown` rather than `string`: `over:
 * "${steps.rows}"` has to yield the array, and `draft: "${steps.reply.id}"` has to yield the id rather than
 * a one-element template. Everything else with a `${` in it is a template and comes back a string.
 *
 * A field with no `${` and no operator is a **literal string**, not a path. That asymmetry is deliberate and
 * it follows §16: `subject: "Thanks"` is a subject line, while `when: event.x != "y"` is a predicate — so
 * the value fields read literals and only `guard.when` and `switch.on` go through `predicate`.
 */
export function evaluate(text: string, state: RunState, node?: string): unknown {
  const whole = /^\$\{([^}]*)\}$/.exec(text);
  if (whole !== null) return resolve(whole[1]!.trim(), state, node);
  if (!text.includes("${")) return text;
  return text.replace(INTERPOLATION, (_match, path: string) =>
    primitive(resolve(path.trim(), state, node), path.trim(), node));
}

/** The three operators, longest first so `!=` is not read as a bare path followed by `=`. */
const OPERATORS = ["==", "!=", " contains "] as const;

/** An operand: `${path}`, a bare path, a quoted string, an integer, or `true` / `false` / `null`. */
function operand(text: string, state: RunState, node?: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ButlerFault("E_BUTLER_EXPR_EMPTY_OPERAND", {
      what: "a comparison has an empty side",
      why: "both sides of a comparison have to be something; an empty one is a typo rather than a value",
      fix: "write a path, a quoted string, an integer, or true / false / null on both sides",
    }, node);
  }
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const braced = /^\$\{([^}]*)\}$/.exec(trimmed);
  return resolve((braced === null ? trimmed : braced[1]!).trim(), state, node);
}

/**
 * Evaluates a predicate — `guard.when` — or the subject of a `switch`.
 *
 * Returns the **value**, not a boolean, because `switch.on` compares it against each case's `equals` while
 * `guard` asks whether it is true. One evaluator for both, so the two nodes cannot disagree about what an
 * expression means.
 *
 * A bare operand is its own value: `guard.when: steps.matched` is truthiness, which is what a predicate over
 * a boolean binding should be. Truthiness here is JavaScript's, with one narrowing stated rather than
 * inherited: the empty string and `0` are false, which is what an author writing `when: event.subject`
 * means.
 */
export function evaluateOperand(text: string, state: RunState, node?: string): unknown {
  const found = findOperator(text);
  if (found === null) return operand(text, state, node);

  const left = operand(found.left, state, node);
  const right = operand(found.right, state, node);

  switch (found.operator) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default: {
      // `contains` is the one predicate that makes a `mail.received` trigger useful — "the subject mentions
      // an invoice" — and it is deliberately the only one, because a substring test is total (it cannot
      // throw on any pair of strings) while a regular expression built from data is a denial of service.
      if (typeof left === "string" && typeof right === "string") return left.includes(right);
      if (Array.isArray(left)) return left.includes(right);
      throw new ButlerFault("E_BUTLER_EXPR_CONTAINS_TYPE", {
        what: `contains was asked about a ${typeof left} and a ${typeof right}`,
        why: "contains tests a string for a substring or an array for a member; on anything else it would "
          + "have to guess, and a guess in a predicate decides whether mail goes out",
        fix: "compare a string against a string, or an array against one of its members",
      }, node);
    }
  }
}

/** Whether a predicate holds. Separated from the value so `switch` and `guard` share one evaluator. */
export function isTrue(text: string, state: RunState, node?: string): boolean {
  const value = evaluateOperand(text, state, node);
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The operator in an expression, or `null` when there is none.
 *
 * Scanned outside quotes, because `event.subject == "a == b"` is one comparison and not two. There is no
 * operator precedence to get wrong: exactly one operator is permitted, and a second one is refused rather
 * than being read left-to-right, which is how `a == b == c` becomes a program whose meaning depends on the
 * reader.
 */
function findOperator(text: string): { left: string; operator: string; right: string } | null {
  let quote: string | null = null;
  const found: Array<{ operator: string; at: number }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator !== undefined) {
      found.push({ operator, at: index });
      index += operator.length - 1;
    }
  }
  if (found.length === 0) return null;
  if (found.length > 1) {
    throw new ButlerFault("E_BUTLER_EXPR_TOO_MANY_OPERATORS", {
      what: `${JSON.stringify(text)} has ${found.length} operators`,
      why: "one comparison per expression. Chaining them would make the meaning depend on a precedence rule "
        + "this language does not have",
      fix: "split it into two guards, or compare once",
    });
  }
  const { operator, at } = found[0]!;
  return {
    left: text.slice(0, at),
    operator: operator.trim(),
    right: text.slice(at + operator.length),
  };
}

/* ------------------------------------------------------------------ validate ---------------------- */

/**
 * The JSON Schema keywords `validate` understands.
 *
 * #49 carries a `validate` node with an **inline** JSON Schema and hands it to *"a validator"* — and this
 * bundle has none. `zod` is here, but it compiles a schema *into* a validator rather than reading one out of
 * data, so it is the wrong direction; `ajv` is a devDependency of `packages/butler-ast` and is not in the
 * Worker.
 *
 * So the subset is enumerated, and **a keyword outside it is refused by name**. That is the honest shape:
 * the alternative is a validator that ignores what it does not understand, which is a `validate` node that
 * passes everything and reads as though it checked something. This repository's rule about a claim nothing
 * enforces, applied to a node whose entire purpose is enforcement.
 *
 * `pattern` and `format` are the two conspicuous absences and both are deliberate. A regular expression
 * compiled from stored data is a denial of service with an author's name on it (`body-render-bounds.md`
 * measured a 34,952 ms request in the render path, past the limit, killed) — and a Butler's AST is exactly
 * stored data. `$ref`, `allOf`, `anyOf`, `oneOf` and `not` are absent because each needs a resolution or
 * combination rule, and inventing five of them for a node nothing yet publishes would be building a
 * validator rather than using one.
 */
export const VALIDATE_KEYWORDS = [
  "type", "enum", "const", "required", "properties", "additionalProperties",
  "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
  // Carried through untouched: they describe rather than constrain, so ignoring them refuses nothing.
  "title", "description", "$schema", "default", "examples",
] as const;

const DESCRIPTIVE = new Set(["title", "description", "$schema", "default", "examples"]);

const TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
};

/**
 * Checks `value` against an inline schema. Returns the reasons it failed, empty when it passed.
 *
 * A **schema** this validator cannot honour throws instead, because that is a different kind of wrong: a
 * value failing validation is the node doing its job, and a schema using `pattern` is a program this engine
 * cannot execute. Conflating the two would let an unhonourable schema read as a value that passed.
 */
export function validateAgainst(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  node?: string,
  at = "value",
): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!(VALIDATE_KEYWORDS as readonly string[]).includes(keyword)) {
      throw new ButlerFault("E_BUTLER_SCHEMA_KEYWORD_UNSUPPORTED", {
        what: `the schema at ${at} uses ${JSON.stringify(keyword)}, which this engine does not implement`,
        why: "a validator that ignored a keyword it did not understand would be a validate node that passes "
          + "everything while reading as though it checked something. pattern and format are refused on "
          + "purpose: a regular expression compiled from a stored AST is a denial of service",
        fix: `use one of: ${VALIDATE_KEYWORDS.filter((word) => !DESCRIPTIVE.has(word)).join(", ")}`,
      }, node);
    }
  }

  const problems: string[] = [];
  const declared = schema.type;
  if (typeof declared === "string") {
    const check = TYPES[declared];
    if (check === undefined) {
      throw new ButlerFault("E_BUTLER_SCHEMA_TYPE_UNKNOWN", {
        what: `the schema at ${at} declares type ${JSON.stringify(declared)}`,
        why: "JSON Schema's type keyword names one of seven types, and a name outside them constrains nothing",
        fix: `use one of: ${Object.keys(TYPES).join(", ")}`,
      }, node);
    }
    if (!check(value)) {
      problems.push(`${at} is ${describe(value)}, and the schema requires ${declared}`);
      // Every keyword below reads the value as the declared type, so a type mismatch stops here rather
      // than producing a second complaint about a length that was never meaningful.
      return problems;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${at} is ${JSON.stringify(value)}, and the schema permits only `
      + schema.enum.map((option) => JSON.stringify(option)).join(", "));
  }
  if (Object.hasOwn(schema, "const") && schema.const !== value) {
    problems.push(`${at} is ${JSON.stringify(value)}, and the schema requires ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      problems.push(`${at} is ${value.length} characters, and the schema requires at least ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      problems.push(`${at} is ${value.length} characters, and the schema permits at most ${schema.maxLength}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push(`${at} is ${value}, and the schema requires at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push(`${at} is ${value}, and the schema permits at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${at} has ${value.length} items, and the schema requires at least ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      problems.push(`${at} has ${value.length} items, and the schema permits at most ${schema.maxItems}`);
    }
    if (schema.items !== undefined && typeof schema.items === "object" && schema.items !== null) {
      value.forEach((item, index) => {
        problems.push(...validateAgainst(
          item, schema.items as Record<string, unknown>, node, `${at}[${index}]`,
        ));
      });
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof required === "string" && !Object.hasOwn(record, required)) {
        problems.push(`${at} has no ${JSON.stringify(required)}, and the schema requires it`);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(record, key)) {
        problems.push(...validateAgainst(record[key], sub, node, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(record).filter((key) => !Object.hasOwn(properties, key));
      if (extra.length > 0) {
        problems.push(`${at} has ${extra.map((key) => JSON.stringify(key)).join(", ")}, `
          + "and the schema permits no other properties");
      }
    }
  }

  return problems;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
