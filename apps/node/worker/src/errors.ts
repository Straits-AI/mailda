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

/**
 * 403: the request will not be carried out for **this caller**, and no state change would make it work.
 *
 * Distinct from 401, which invites a retry with credentials, and from 404, which §5C uses to keep "absent"
 * and "not yours" alike. This one says the request itself is not one this Node accepts from where it came:
 * its first use is a cross-site mutation (#96), where the caller may hold a perfectly good session and the
 * problem is the *origin*, so telling them to sign in would be advice that cannot help.
 */
export function forbidden(code: string, detail: { what: string; why: string; fix: string }): CallerError {
  return new CallerError(code, 403, detail);
}

/** 409: the request is well-formed but the state does not permit it. */
export function conflict(code: string, detail: { what: string; why: string; fix: string }): CallerError {
  return new CallerError(code, 409, detail);
}

/**
 * 503: the request was fine and **this Node** could not carry it out; the same request will work later.
 *
 * Not a 500, and the difference is the one AGENTS.md principle 3 is about. A 500 says "a bug", which sends a
 * reader to the stack trace; this says "a component the request depends on did not answer", which sends them
 * to the operational log and to `doctor`. Its first use is a supervised read refusing itself because the audit
 * append failed — the read is legitimate, the Node just cannot record it, and it must not proceed unrecorded.
 */
export function unavailable(code: string, detail: { what: string; why: string; fix: string }): CallerError {
  return new CallerError(code, 503, detail);
}
