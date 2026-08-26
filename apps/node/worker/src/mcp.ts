import * as z from "zod";

import { ROUTES, agentCapabilities, methodNameFor, path, route, type RouteSpec } from "@mailda/contract";

/**
 * The MCP server (#89, ADR 12).
 *
 * ## Where it lives, which was the decision rather than the build
 *
 * An MCP server is a thing an agent connects to, and every obvious way of providing one collided with
 * something already decided. The ticket named three and the ADRs settle it:
 *
 * | shape | what it costs |
 * |:--|:--|
 * | a second Worker | contradicts ADR 18's one-Worker rule, and gives ADR 24 a second artifact to keep byte-identical |
 * | **routes on this Worker** | **the Node grows a protocol surface somebody else specified** |
 * | a separately-run server | the first component in this product holding credentials for a Node it is not part of |
 *
 * The third is the one to reject hardest. ADR 7's whole premise is custody — your account, your data, your
 * keys — and a locally-run bridge holding a session token for a Node it is not part of is the shape that
 * premise exists to rule out, whatever its convenience.
 *
 * So: **two routes on this Worker**, over MCP's Streamable HTTP transport. One Worker, no new account
 * resource, no customer-specific configuration, and the mail never leaves the Node that holds it. The cost
 * is real and is the middle row: the shape of these two routes is set by a specification this project does
 * not control, and `route-registry.test.ts` now describes routes that are not Mailda's own design. That is
 * a smaller price than either alternative and it is paid openly.
 *
 * ## It exposes the curated list, not the API
 *
 * `packages/contract/src/agent.ts` decides what a machine may be offered — 53 of 94 routes — and this reads
 * it rather than deciding again. The Agent Skill (#88) reads the same list. Two surfaces answering the same
 * question twice is how they come to disagree about which acts are safe, which is the worst thing they
 * could disagree about.
 *
 * **Nothing needing two people is a tool here.** §18 counts distinct people, and an agent inside somebody's
 * session is that person — so the Node already refuses. What this withholds is the *offer*, because a tool
 * a caller can never complete teaches it to keep trying.
 *
 * ## Authentication is the session, and there is no third credential
 *
 * The request carries the caller's cookies like any other. That is deliberate: an MCP-specific token would
 * be a third credential kind for this Node to hold, after passwords and passkeys (#84), and every act would
 * land in the audit trail under a machine rather than under the person who set it going. Acting as the
 * person is what makes the trail honest — and what makes the `governed` tier's reasoning true rather than
 * aspirational.
 */

/** MCP's JSON-RPC 2.0 envelope. Only the members this server reads. */
const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

const PROTOCOL_VERSION = "2025-06-18";

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly spec: RouteSpec;
}

/**
 * The curated routes, as MCP tools.
 *
 * The input schema is built rather than hand-written: path parameters become required strings, and a route
 * with a request schema contributes it as `body` via `z.toJSONSchema`. MCP wants JSON Schema and Zod emits
 * draft 2020-12, which is what MCP uses — so there is no lossy conversion, the same reason `send-mail.ts`
 * gave for choosing that target in #3.
 */
/**
 * Zod metadata this Node keeps for itself, removed on the way out.
 *
 * `.meta({ refusal: "E_…" })` in `packages/contract/src/schemas.ts` tells `request-shape.ts` which code to
 * refuse a closed set with (#93). It lives on the schema deliberately — a side table keyed by route would be
 * the correspondence problem `errors.ts` already rejected — and `z.toJSONSchema` faithfully copies it into
 * the published tool schema, where an agent found `"refusal":"E_POLICY_FIELD_UNKNOWN"` sitting in what is
 * supposed to be a description of the *input*.
 *
 * It is not a secret; every code here is in a public repository and the Skill quotes several. It is simply
 * **not the caller's**, and a wire format that carries a server's internal wiring is one that callers start
 * depending on. Stripped at the single point where an internal shape becomes a published one, rather than by
 * withholding the metadata from the schema that needs it.
 */
const INTERNAL_KEYS = new Set(["refusal"]);

function published(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(published);
  if (typeof node !== "object" || node === null) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !INTERNAL_KEYS.has(key))
      .map(([key, value]) => [key, published(value)]),
  );
}

export function tools(): Tool[] {
  const all: readonly RouteSpec[] = ROUTES;
  const byName = new Map(all.map((spec) => [`${spec.method} ${spec.path}`, spec]));

  return agentCapabilities(methodNameFor).map((capability) => {
    const spec = byName.get(`${capability.method} ${capability.path}`)!;
    const parameters = [...spec.path.matchAll(/:(\w+)/g)].map((match) => match[1]!);

    const properties: Record<string, unknown> = {};
    for (const parameter of parameters) {
      properties[parameter] = { type: "string", description: `The ${parameter} this acts on.` };
    }
    if (spec.request !== undefined) {
      properties["body"] = published(
        z.toJSONSchema(spec.request, { target: "draft-2020-12", io: "input" }),
      );
    }

    return {
      /*
       * The SDK's derived name, with `/` and `:` gone. One vocabulary across the SDK, the Skill and here —
       * an agent that read `postButlers` in the Skill and found `mailda_create_butler` here would have to
       * be told they were the same thing, which is a second mapping to keep in step.
       */
      name: capability.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
      description: `${capability.summary} (${capability.method} ${capability.path})`,
      inputSchema: {
        type: "object",
        properties,
        required: [...parameters, ...(spec.request === undefined ? [] : ["body"])],
      },
      spec,
    };
  });
}

/** A JSON-RPC result. `id` echoes the request's, which is how a client matches them. */
function result(id: unknown, value: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result: value });
}

/**
 * A JSON-RPC error.
 *
 * `-32602` for a bad request and `-32601` for an unknown method, per the specification. A **refusal from
 * this Node is not one of these**: it comes back as a tool result with `isError`, because the tool ran and
 * the answer was no — which is information the agent should reason about rather than a protocol fault.
 */
function failure(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/**
 * Dispatches one request back into this Worker's own router.
 *
 * Passed in rather than imported, because `index.ts` imports this module and the reverse would be a cycle.
 */
export type Dispatch = (request: Request) => Promise<Response>;

/**
 * Handles one MCP request by re-entering this Worker's own router.
 *
 * **The re-entry is the line worth defending.** A tool call goes through `principalFor`, the authorization
 * the route performs, the audit entry it writes and the refusal it returns — every one of them, unchanged.
 * An MCP layer that reached past those into the functions beneath would be a second way into this Node's
 * data with its own idea of who may do what, which is exactly the thing this product does not have and must
 * not grow.
 *
 * **In-process rather than `fetch` against its own origin**, which is what the first version did and what
 * the tests refused. A Worker fetching its own hostname goes back out through the edge: it spends a
 * subrequest from a budget this Node counts, and in workerd it fails outright. Re-entering the router keeps
 * every property the round trip was for — same handler, same guards, same refusals — and costs nothing.
 */
export async function handleMcp(request: Request, dispatch: Dispatch): Promise<Response> {
  const parsed = rpcRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failure(null, -32600, "not a JSON-RPC 2.0 request");
  const { id, method, params } = parsed.data;

  if (method === "initialize") {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "mailda", version: "0.0.0" },
      /*
       * Said in the handshake as well as in the Skill, because an agent that only ever speaks MCP never
       * reads the Skill. An absence it has not been warned about is one it will probe.
       */
      instructions:
        "This Node's mail belongs to the customer whose Cloudflare account it runs in. Tools here read and "
        + "draft; they do not send. Sealing a send, approving one, publishing a Butler, lifting a hold and "
        + "granting access are deliberately absent — each needs a person, and several need two distinct "
        + "people, which you cannot be while acting in one person's session. Refusals carry what happened, "
        + "why, and what would change it: read the fix before retrying, because most are not transient.",
    });
  }

  if (method === "notifications/initialized") return new Response(null, { status: 202 });

  if (method === "tools/list") {
    return result(id, {
      tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const tool = tools().find((one) => one.name === name);
    /*
     * An unknown tool is a protocol error rather than a tool result: the caller asked for something that is
     * not on the list it was given, which is a mistake about *this server* rather than an answer from it.
     */
    if (tool === undefined) return failure(id, -32602, `no tool named ${name}`);

    const parameters = [...tool.spec.path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
    const filled: Record<string, string> = {};
    for (const parameter of parameters) {
      const value = args[parameter];
      if (typeof value !== "string" || value === "") {
        return failure(id, -32602, `${name} needs ${parameter}`);
      }
      filled[parameter] = value;
    }

    const url = new URL(request.url);
    const target = `${url.origin}${path(route(tool.spec.method as never, tool.spec.path as never), filled)}`;
    const body = args["body"];

    const answer = await dispatch(new Request(target, {
      method: tool.spec.method,
      headers: {
        // The caller's own credentials. An MCP-specific identity would put every act in the trail under a
        // machine rather than the person who set it going.
        ...(request.headers.get("cookie") === null ? {} : { cookie: request.headers.get("cookie")! }),
        ...(request.headers.get("authorization") === null
          ? {}
          : { authorization: request.headers.get("authorization")! }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

    const text = await answer.text();
    /*
     * A refusal comes back as a **tool result** with `isError`, not a JSON-RPC error. The tool ran and the
     * answer was no, and this Node's refusals are written to be acted on — four parts, naming what would
     * change. Flattening one into a protocol fault would throw away the only part an agent can use.
     */
    return result(id, {
      content: [{ type: "text", text }],
      isError: !answer.ok,
    });
  }

  return failure(id, -32601, `this server does not implement ${method}`);
}
