import { readFileSync, writeFileSync } from "node:fs";

import { exitCodeFor, methods, requestFor } from "../api-call.mjs";
import { api, flag, sessionCookie } from "../support.mjs";

/**
 * `mailda api [<method> …]`: the Node's whole contract from the terminal, for a person or a script.
 *
 * The operator verbs above it run the Node; this one uses it — mail, drafts, cases, Butlers, approvals — by the
 * same method names as the SDK and the MCP tools (`api-call.mjs` says why nothing here is per route). The result
 * goes to stdout and nothing else does, so it pipes into `jq`; a refusal goes to stderr whole, with its `fix`.
 *
 * Credentials from the environment, never an argument (§19, "no secret in command arguments"): `MAILDA_TOKEN`, an
 * agent token minted on `/agents`, sent as a bearer; or `MAILDA_EMAIL` and `MAILDA_PASSWORD`, a person's session.
 * With neither, the call goes unauthenticated, which some routes answer and most refuse with 401.
 */
export async function apiVerb(argv) {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--list") {
    const word = name === "--list" ? (rest[0] ?? "").toLowerCase() : "";
    const rows = methods()
      .filter(({ name: one, spec }) => `${one} ${spec.path} ${spec.summary ?? ""}`.toLowerCase().includes(word));
    for (const { name: one, spec } of rows) {
      process.stdout.write(`${one}\n    ${spec.method} ${spec.path}${spec.summary === undefined ? "" : `\n    ${spec.summary}`}\n`);
    }
    process.stdout.write(`\n${rows.length} methods. Call one: mailda api <method> --url <origin> [--<parameter> <value> …]\n`);
    return 0;
  }

  const call = requestFor(name, rest);
  if (call.usage !== null) {
    process.stderr.write(`\n${call.usage}\n\n`);
    return 2;
  }
  const origin = (flag(rest, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") {
    process.stderr.write("\npass --url https://your-node.example, or set MAILDA_URL\n\n");
    return 2;
  }
  if (call.binary && call.out === undefined && process.stdout.isTTY) {
    process.stderr.write(`\n${name} answers a file, not JSON. Pass --out <file>, or pipe it somewhere\n\n`);
    return 2;
  }

  const headers = {};
  if (process.env.MAILDA_TOKEN !== undefined) {
    headers.authorization = `Bearer ${process.env.MAILDA_TOKEN}`;
  } else if (process.env.MAILDA_EMAIL !== undefined) {
    const cookie = await sessionCookie(origin, { canaryNote: false });
    if (cookie === null) {
      process.stderr.write("\ncould not sign in with MAILDA_EMAIL and MAILDA_PASSWORD\n\n");
      return 3;
    }
    headers.cookie = cookie;
  }
  let body;
  if (call.body !== undefined) {
    const text = call.body === "-" ? readFileSync(0, "utf8")
      : call.body.startsWith("@") ? readFileSync(call.body.slice(1), "utf8") : call.body;
    try {
      body = JSON.stringify(JSON.parse(text));
    } catch {
      process.stderr.write("\n--body is not JSON\n\n");
      return 2;
    }
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${origin}${api(call.method, call.template, call.query, call.params)}`, {
    method: call.method, headers, ...(body === undefined ? {} : { body }),
  }).catch((error) => {
    process.stderr.write(`\ncould not reach ${origin}: ${error.message}\n\n`);
    return null;
  });
  if (response === null) return 9;

  if (!response.ok) {
    process.stderr.write(`${await response.text()}\n`);
    return exitCodeFor(response.status);
  }
  if (call.binary) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (call.out === undefined) process.stdout.write(bytes);
    else writeFileSync(call.out, bytes);
    return 0;
  }
  const text = await response.text();
  // Pretty for a person; still one JSON document for `jq`. A body that is not JSON is passed through as it came.
  try {
    process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  } catch {
    process.stdout.write(text);
  }
  return 0;
}
