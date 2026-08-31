import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import ts from "typescript";

import { AGENT_GRANTABLE_RELATIONS } from "@mailda/contract/relations";

/**
 * Which fixed mailbox relations a route's handler can reach, derived from the source.
 *
 * ## What this replaces, and why a hand-written map was not good enough
 *
 * `mailbox-gate-world.test.ts` scanned each handler block for a gate call and could only see **one level**:
 * a gate reached through a function `index.ts` calls was invisible. The gap was covered by
 * `GATED_INDIRECTLY`, a six-entry object mapping route to gating function, written by hand.
 *
 * That object was a second source of truth with nothing guaranteeing completeness, and it was incomplete the
 * day it was written — four families were missing (`POST /api/cases/:caseId/:action`, `POST /api/exports`,
 * `POST /api/exports/:exportId/run`, `GET /api/butler-runs/:runId/inspect`). None was a live hole, but the
 * map's correctness rested on somebody having looked, which is the thing the file exists to replace.
 *
 * ## What this answers, and what it deliberately does not
 *
 * One mechanical question: **which fixed mailbox relations can this handler reach below its first call?**
 *
 * It does not decide whether the gate is *correct*. That stays with `route-authority-parity.test.ts`, which
 * grants every neighbouring relation and asserts each is refused — the assertion that found nine holes. An
 * analyser that also judged policy would become a second authority model, and two models of one thing is the
 * defect this whole branch is about.
 *
 * ## How
 *
 * The Worker's sources are parsed with the TypeScript compiler API, so a function's boundaries come from the
 * AST rather than from brace counting. Then:
 *
 * 1. **Direct relations** — a string literal equal to a known relation, or a SQL predicate naming one
 *    (`t.relation = 'x'`, `relation IN ('x', 'y')`). The relation vocabulary is read from `access.ts`'s
 *    `GRANTABLE` table rather than listed here, for the reason the parity suite derives its own: a
 *    hand-picked set missed `ediscovery.export`, and that omission was what let a mutation swapping the two
 *    export relations survive the whole suite.
 * 2. **Call edges** — a call to a function this graph knows, resolved through relative imports.
 * 3. **Fixed point** — a function reaches every relation it names directly plus everything its callees reach.
 *
 * ## The limits, stated
 *
 * - **Relations must be literals**, in a gate argument or a SQL predicate on the `relation` column. A relation
 *   assembled at runtime is invisible. Module-level arrays are followed by name, because `mayReadMetadata`
 *   passes `RELATIONS_FOR_METADATA` rather than a literal and the first version reported it as reaching
 *   nothing.
 * - **Calls must be by name**, and must be calls: `void maySend;` is not followed, which is correct but worth
 *   knowing before reading a pass as coverage.
 * - **Three hops.** The walk stops at depth three, which is what it takes to reach `handler → domain function
 *   → gate wrapper → hasAnyRelation`. Unbounded, it flagged **98 of 104** handlers, because every route calls
 *   something in `authz-read.ts` and a transitive union then hands every route every relation. A check that
 *   demands a declaration from almost every route is a rename of "all", not a check.
 * - **Grantable relations only.** `approval.decide` and `supervised.read` gate real routes and are reported as
 *   nothing, because the point of a declaration is to enter the parity loop and that loop works by *granting*.
 *   A route gated solely on something no mint confers cannot be driven that way.
 * - **One package.** Only `apps/node/worker/src` is walked.
 *
 * ## What the bounds cost, measured
 *
 * At these settings the walk flags **20 of 104** handlers, and every one is a real relation gate. It found
 * four the hand-written map had missed — `POST /api/cases/:caseId/:action`, `POST /api/conversations/merge`,
 * `POST /api/exports`, `POST /api/exports/:exportId/run` — which is the argument for deriving rather than
 * listing. It does **not** find `POST /api/sends/:sendId/release`, whose gate is a hop further down; that
 * route is declared and driven anyway, so the miss costs coverage of a future regression rather than a
 * present one.
 *
 * These are smaller claims than "every gate". Unlike the map they replace, the inputs are derived and the
 * bounds are measured rather than assumed.
 */

const SRC = resolve(new URL("../../../src", import.meta.url).pathname);

/** Every `.ts` under the Worker's source, which is the whole graph this walks. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * The relation vocabulary, read from `access.ts`'s `GRANTABLE` keys.
 *
 * Derived rather than listed, because a hand-picked set is exactly how `ediscovery.export` came to be missing
 * from the parity suite's substitutes while a mutation swapping it for `message.export` survived.
 */
/**
 * The relations a **mint can confer**, which is the set this analyser reports on.
 *
 * The point of a `scope: "mailbox"` declaration is to put the route into `route-authority-parity.test.ts`'s
 * loop, and that loop works by *granting* relations. A route gated solely on something no mint confers —
 * `approval.decide`, `supervised.read` — cannot be driven that way, so demanding a declaration for it would
 * ask for a promise the mechanism cannot keep. At depth 3 that was five routes, including `GET /api/doctor`
 * and `POST /api/policies/:policyId/publish`, none of which is mailbox-scoped in any useful sense.
 *
 * Taken from the contract's own `AGENT_GRANTABLE_RELATIONS`, which is the set the mint offers — so this
 * cannot drift from what a credential can actually be given.
 */
export function grantableRelations(): readonly string[] {
  return AGENT_GRANTABLE_RELATIONS;
}

export function knownRelations(): string[] {
  const source = readFileSync(join(SRC, "access.ts"), "utf8");
  const table = source.slice(source.indexOf("export const GRANTABLE = {"));
  /*
   * `object: "mailbox"` only. The first version matched any object and so returned `org.admin`, whose object
   * is the organization — which would have made every `isAdmin` handler report a *mailbox* relation and
   * demanded a `scope: "mailbox"` declaration for routes that have nothing to do with one.
   */
  return [...table.matchAll(/^\s{2}"([\w.]+)":\s*\{\s*object:\s*"mailbox"/gm)].map((match) => match[1]!);
}

/**
 * Module-level arrays of relations, so a gate passing a named constant is followed.
 *
 * `mayReadMetadata` passes `RELATIONS_FOR_METADATA` rather than a literal array, and the first version of this
 * analyser reported it as reaching nothing — the "relations must be literals" limit biting a real gate rather
 * than a hypothetical one. A constant whose initialiser is an array of relation literals is still static, so
 * following it costs nothing and removes the most common way a gate hides from this reader.
 */
function relationConstants(files: readonly string[], vocabulary: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    /*
     * **Module-level only.** The first version walked every `VariableDeclaration`, so a local `const
     * relations = […]` inside one function put its whole set under a name that appears in dozens of others —
     * and any function mentioning `relations` inherited them. That single leak was most of why the walk
     * flagged 98 of 104 handlers.
     */
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        /*
         * **Array initialisers only.** `GRANTABLE` in `access.ts` is a module-level object naming every
         * relation — it is the vocabulary's *definition*, not an argument to a gate — and admitting it gave
         * all seven relations to every function that mentions it: `assertAdmin`, `grant`, `isGrantable`, and
         * so the ten handlers that call them. A gate is handed a list.
         */
        if (!ts.isArrayLiteralExpression(declaration.initializer)) continue;
        const named = [...relationsInArray(declaration.initializer.getText(source), vocabulary)];
        if (named.length > 0) found.set(declaration.name.text, named);
      }
    }
  }
  return found;
}

interface FunctionNode {
  readonly file: string;
  readonly name: string;
  readonly text: string;
}

/** Every named function in the graph, keyed `file::name`. */
function declaredFunctions(files: readonly string[]): Map<string, FunctionNode> {
  const found = new Map<string, FunctionNode>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        found.set(`${file}::${node.name.text}`, { file, name: node.name.text, text: node.getText(source) });
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        found.set(`${file}::${node.name.text}`, { file, name: node.name.text, text: node.getText(source) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** Where each imported name in a file comes from, so a call can be followed across modules. */
function importsOf(file: string): Map<string, string> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const map = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    // Relative only: a gate cannot live in a third-party package, and resolving those would need the
    // module resolver rather than a path join.
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) map.set(element.name.text, target);
  }
  return map;
}

/**
 * The relations a piece of source **gates on**, which is narrower than the relations it mentions.
 *
 * The first version matched any quoted relation anywhere in a function's text and then took the transitive
 * union over its callees. That flagged **98 of 104** handlers, including `GET /api/doctor` and
 * `POST /api/maintenance/reseal`, because somewhere down a long call chain some function mentions a relation.
 * A check that demands a declaration from almost every route is not a check; it is a rename of "all".
 *
 * So a relation counts only where it flows into a decision:
 *
 * - an argument to `hasAnyRelation`, which is what every relation gate in this tree ultimately calls;
 * - a SQL predicate on the `relation` column — `t.relation = 'x'`, `relation IN ('x', 'y')` — which is how
 *   the listing queries bound themselves.
 *
 * Mentioning a relation in a comment, an error message or a response body is not gating on it.
 */
export function relationsIn(text: string, vocabulary: readonly string[]): Set<string> {
  const found = new Set<string>();
  const quoted = (relation: string) => `["'\`]${relation.replace(/\./g, "\\.")}["'\`]`;

  /*
   * `hasAnyRelation(env, who, <relations>, …)` — the third argument, bounded so a greedy match cannot run to
   * the end of the file. Also matched bare, because `relationConstants` needs to read an array initialiser
   * that is not itself inside a call.
   */
  const gateArguments = [...text.matchAll(/hasAnyRelation\([^;]{0,400}?\)/g)].map((match) => match[0]);
  const sqlPredicates = [...text.matchAll(/relation\s*(?:=|IN)\s*(?:\([^)]{0,200}?\)|[^\s,)]{0,80})/g)]
    .map((match) => match[0]);

  for (const relation of vocabulary) {
    const pattern = new RegExp(quoted(relation));
    if ([...gateArguments, ...sqlPredicates].some((where) => pattern.test(where))) found.add(relation);
  }
  return found;
}

/** An array initialiser read on its own terms, for the relation constants a gate is handed by name. */
function relationsInArray(text: string, vocabulary: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const relation of vocabulary) {
    if (new RegExp(`["'\`]${relation.replace(/\./g, "\\.")}["'\`]`).test(text)) found.add(relation);
  }
  return found;
}

/**
 * Every route handler in `index.ts` with the fixed mailbox relations it can reach.
 *
 * The key is the block's own text; matching a block to a registered path is the caller's business, because
 * `mailbox-gate-world.test.ts` already resolves both literal and regex routes and there should not be two
 * answers to that question.
 */
export function reachableRelations(): (block: string) => Set<string> {
  /*
   * The vocabulary is every mailbox relation, so the walk *sees* a gate on `approval.decide`; the reported set
   * is narrowed to the grantable ones, so the caller only demands a declaration it can act on.
   */
  const vocabulary = knownRelations();
  const grantable = new Set(grantableRelations());
  const files = sources(SRC);
  const functions = declaredFunctions(files);
  const imports = new Map(files.map((file) => [file, importsOf(file)]));

  /** `file::name` → the relations that function reaches, computed once and memoised. */
  const reach = new Map<string, Set<string>>();

  const resolveCall = (fromFile: string, name: string): string | null => {
    const local = `${fromFile}::${name}`;
    if (functions.has(local)) return local;
    const target = imports.get(fromFile)?.get(name);
    if (target === undefined) return null;
    for (const candidate of [`${target}.ts`, join(target, "index.ts"), target]) {
      if (functions.has(`${candidate}::${name}`)) return `${candidate}::${name}`;
    }
    return null;
  };

  const calleesOf = (text: string): string[] =>
    [...text.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]!);

  const constants = relationConstants(files, vocabulary);

  /** The relations a piece of source names, directly or through a relation constant it references. */
  const named = (text: string): Set<string> => {
    const found = relationsIn(text, vocabulary);
    for (const [constant, relations] of constants) {
      if (new RegExp(`\\b${constant}\\b`).test(text)) for (const one of relations) found.add(one);
    }
    return found;
  };

  /**
   * **Depth-bounded at two, and the bound is the whole difference between a signal and a rename of "all".**
   *
   * The unbounded closure flagged 98 of 104 handlers, and restricting to gate-shaped mentions still flagged
   * nearly all of them. The reason is structural: `authz-read.ts` holds five relations across its gate
   * primitives, and every route calls *something* in that file — `principalFor`, `readableSubjects` — so a
   * transitive union hands every route every relation.
   *
   * What is actually wanted is the thing the hand-written map recorded: *this handler calls a domain function
   * which gates*. That is two hops — handler → domain function → gate primitive — and going deeper adds no
   * information about the handler while adding every relation in the graph.
   */
  const walk = (key: string, depth: number): Set<string> => {
    if (depth === 0) return new Set();
    const memoKey = `${key}@${depth}`;
    const memo = reach.get(memoKey);
    if (memo !== undefined) return memo;

    const node = functions.get(key)!;
    const found = named(node.text);
    for (const callee of calleesOf(node.text)) {
      const target = resolveCall(node.file, callee);
      if (target === null || target === key) continue;
      for (const relation of walk(target, depth - 1)) found.add(relation);
    }
    reach.set(memoKey, found);
    return found;
  };

  const index = join(SRC, "index.ts");
  return (block: string) => {
    const found = named(block);
    for (const callee of calleesOf(block)) {
      const target = resolveCall(index, callee);
      if (target === null) continue;
      for (const relation of walk(target, 3)) found.add(relation);
    }
    return new Set([...found].filter((one) => grantable.has(one)));
  };
}
