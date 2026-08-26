import { NOT_JSON, path, route, type HttpMethod } from "@mailda/contract/routes";

/**
 * What every generated method sits on: one request, one refusal shape, one place that knows the contract.
 *
 * Hand-written, and it is the **only** hand-written part of the SDK. Everything a route-specific decision
 * touches is generated; this holds what is true of all of them.
 */

export interface ClientOptions {
  /** Where the Node is. No default: a client that guessed would talk to the wrong Node in silence. */
  readonly origin: string;
  /**
   * The `fetch` to use.
   *
   * Injectable because an SDK whose only reachable Node is a real one cannot be tested against a fake one,
   * and because a caller inside a Worker has a `fetch` bound to a service binding rather than the global.
   */
  readonly fetch?: typeof globalThis.fetch;
  /** Sent on every request. Where a bearer token or a cookie goes. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Whether to parse each response with the schema the contract declares. **On by default.**
   *
   * This is the difference between an SDK and a wrapper around `fetch`. A Node that has drifted from the
   * contract is caught at the boundary, in the caller's process, with the offending field named — rather
   * than three layers later when something reads a field that is not there.
   *
   * Turning it off is for one case and it is worth naming: a client talking to a **newer** Node that has
   * added fields. Response schemas are `.strict()`, so an added field is a parse error — which is the
   * correct default for catching drift and the wrong one for surviving a rolling upgrade.
   */
  readonly validate?: boolean;
}

/**
 * A refusal this Node made, as an error.
 *
 * Carries the four parts AGENTS.md requires rather than flattening them into a message: `error` is the code
 * a caller can branch on, and the rest is what a person needs. Throwing rather than returning a union is
 * deliberate — a refusal is not an ordinary outcome of `sdk.postSends(...)`, and a caller that forgot to
 * check a discriminant would send nothing and believe it had.
 */
export class MaildaError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "MaildaError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** A response whose body did not match the contract. Distinct from a refusal: this Node is wrong, not you. */
export class ContractViolation extends Error {
  readonly route: string;
  readonly body: unknown;

  constructor(route: string, detail: string, body: unknown) {
    super(
      `${route} answered a body the contract does not describe: ${detail}. This Node and this SDK disagree `
      + "about the shape — check that both are the same version, and report it if they are.",
    );
    this.name = "ContractViolation";
    this.route = route;
    this.body = body;
  }
}

export class Transport {
  readonly #options: ClientOptions;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  async #send(
    method: HttpMethod,
    template: string,
    params: Readonly<Record<string, string>>,
    body: unknown,
    query?: Readonly<Record<string, string | undefined>>,
  ): Promise<{ response: Response; spec: ReturnType<typeof route> }> {
    const spec = route(method as never, template as never);
    const call = this.#options.fetch ?? globalThis.fetch;

    /*
     * An `undefined` value is dropped rather than sent as `?cursor=undefined` (#91).
     *
     * That distinction is the whole of what a paging parameter means: absent is *"the newest page"* and
     * present is *"resume here"*. `URLSearchParams` stringifies whatever it is given, so a caller spreading a
     * partly-filled object would have asked this Node to resume from the four letters `undef` — which
     * `GET /api/messages` refuses, correctly and confusingly.
     */
    const search = new URLSearchParams(
      Object.entries(query ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ).toString();

    const response = await call(`${this.#options.origin}${path(spec, params)}${search === "" ? "" : `?${search}`}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...this.#options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, spec };
  }

  /**
   * A JSON route.
   *
   * The refusal is read **before** the schema is applied, and the order matters: a 4xx body is a refusal
   * shape rather than the route's success shape, so validating first would report a contract violation for
   * a Node that behaved perfectly.
   */
  protected async json(
    method: HttpMethod,
    template: string,
    params: Readonly<Record<string, string>>,
    body: unknown,
    query?: Readonly<Record<string, string | undefined>>,
  ): Promise<unknown> {
    const { response, spec } = await this.#send(method, template, params, body, query);
    const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;

    if (!response.ok) {
      throw new MaildaError(
        response.status,
        String(parsed?.error ?? "unknown"),
        String(parsed?.message ?? `${method} ${template} answered ${response.status}.`),
        parsed,
      );
    }

    if (this.#options.validate === false || spec.response === undefined) return parsed;
    const checked = spec.response.safeParse(parsed);
    if (!checked.success) {
      throw new ContractViolation(`${method} ${template}`, checked.error.message, parsed);
    }
    return checked.data;
  }

  /** A route that does not answer JSON. The caller gets the `Response` — see `NOT_JSON`. */
  protected async raw(
    method: HttpMethod,
    template: string,
    params: Readonly<Record<string, string>>,
    body: unknown,
    query?: Readonly<Record<string, string | undefined>>,
  ): Promise<Response> {
    const { response } = await this.#send(method, template, params, body, query);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new MaildaError(response.status, "unknown", text || `${method} ${template} answered ${response.status}.`, text);
    }
    return response;
  }

  /** The routes that answer something other than JSON, for a caller deciding how to handle one. */
  static readonly notJson: readonly string[] = NOT_JSON;
}
