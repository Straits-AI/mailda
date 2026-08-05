/**
 * Errors that are the caller's to fix, and that carry their own HTTP status.
 *
 * The first version of this classified errors with a lookup table in `index.ts` mapping `E_` codes to
 * statuses. That is the **correspondence problem ADR 35 rejected** for the effect key: two places that
 * must agree, edited separately, where forgetting the second one silently downgrades a caller error
 * into an opaque HTTP 500. A new validation error should be classified by *being declared*, not by
 * someone remembering to touch a second file.
 *
 * So the status travels with the throw. `index.ts` asks `instanceof` and reads it.
 *
 * The message keeps AGENTS.md's four-part shape — what, why, and the fix — because these are the
 * errors a person actually sees, and a refusal without a remedy is a dead end.
 */
export class CallerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    detail: { what: string; why: string; fix: string },
  ) {
    super(`${code}  ${detail.what}\n  why      ${detail.why}\n  fix      ${detail.fix}`);
    this.name = code;
  }
}

/** 422: the value was understood and refused. */
export function unprocessable(code: string, detail: { what: string; why: string; fix: string }): CallerError {
  return new CallerError(code, 422, detail);
}

/** 404: the thing named does not exist, or does not exist *for this caller* — §5C keeps those alike. */
export function notFound(code: string, detail: { what: string; why: string; fix: string }): CallerError {
  return new CallerError(code, 404, detail);
}

/** 409: the request is well-formed but the state does not permit it. */
export function conflict(code: string, detail: { what: string; why: string; fix: string }): CallerError {
  return new CallerError(code, 409, detail);
}
