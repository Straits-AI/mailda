import { NOT_JSON, ROUTES } from "@mailda/contract/routes";
import { methodNameFor } from "@mailda/contract/naming";

/**
 * `mailda api`: every route the contract registers, by the SDK's method name (10 October 2026).
 *
 * The pure half of the verb, apart from its effect so a test can import it (AGENTS.md 2b, the seam). Nothing here
 * is written per route: the name, the verb, the path parameters and the query come from the registry, so the CLI
 * reaches exactly what the SDK and MCP do, under the same names, and a route added to the contract is a command
 * the moment it exists. The Node still decides every call: what this builds is a request, not a permission.
 */

/** Every route, by the name the SDK and MCP use for it. */
export function methods() {
  return ROUTES.map((spec) => ({ name: methodNameFor(spec), spec }));
}

const OWN_FLAGS = new Set(["url", "body", "out"]);

/**
 * The request `mailda api <name> --<param> <value> …` asks for, or `{ usage }`: a refusal before anything is sent,
 * the Blueprint's exit 2, "local usage/schema validation error". Path and query parameters are flags named as the
 * contract names them; `--body` is the JSON body, given inline, as `@file`, or as `-` for stdin, and returned
 * unread so the caller does the reading.
 */
export function requestFor(name, argv) {
  const found = methods().find((one) => one.name === name);
  if (found === undefined) {
    return usage(`no method named ${name}. \`mailda api\` lists them, with the route each one calls`);
  }
  const { spec } = found;
  const given = new Map();
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at];
    if (!flag.startsWith("--") || argv[at + 1] === undefined) {
      return usage(`expected --<parameter> <value>, got ${flag}`);
    }
    given.set(flag.slice(2), argv[at + 1]);
  }

  const pathNames = [...spec.path.matchAll(/:(\w+)/g)].map((match) => match[1]);
  const queryNames = (spec.query ?? []).map((one) => one.name);
  const accepted = [...pathNames, ...queryNames];
  const unknown = [...given.keys()].filter((key) => !OWN_FLAGS.has(key) && !accepted.includes(key));
  if (unknown.length > 0) {
    return usage(`${name} takes no --${unknown[0]}. It takes ${accepted.length === 0 ? "no parameters" : accepted.map((one) => `--${one}`).join(", ")}`
      + (spec.method === "GET" ? "" : ", and --body <json|@file|->"));
  }
  const missing = pathNames.filter((one) => !given.has(one));
  if (missing.length > 0) return usage(`${name} needs --${missing.join(", --")}`);
  if (spec.method === "GET" && given.has("body")) return usage(`${name} is a GET and takes no --body`);

  return {
    usage: null,
    method: spec.method,
    template: spec.path,
    params: Object.fromEntries(pathNames.map((one) => [one, given.get(one)])),
    query: Object.fromEntries(queryNames.filter((one) => given.has(one)).map((one) => [one, given.get(one)])),
    body: given.get("body"),
    out: given.get("out"),
    binary: NOT_JSON.includes(`${spec.method} ${spec.path}`),
  };
}

function usage(message) {
  return { usage: message };
}

/**
 * The Blueprint's stable exit categories (§19), from the Node's answer. Only the ones an HTTP status says for
 * certain: 7 (approval pending) and 10 (`outcome_unknown`) are said in the body, which is printed whole, and a
 * code guessed from a status would be a code a script trusts and should not.
 */
export function exitCodeFor(status) {
  if (status >= 200 && status < 300) return 0;
  if (status === 401) return 3;
  if (status === 403) return 4;
  if (status === 404) return 5;
  if (status === 409 || status === 412) return 6;
  if (status === 429) return 8;
  return 9;
}
