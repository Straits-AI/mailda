/**
 * What the receiving mail server established about a message's sender, read from the header it wrote.
 *
 * Cloudflare's Email Routing MX authenticates every inbound message — SPF, DKIM, DMARC, ARC — and records
 * the outcome as an `Authentication-Results` header (RFC 8601) before handing the message to this Worker:
 *
 * ```text
 * Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20251104 header.b=…;
 *   dmarc=pass header.from=gmail.com policy.dmarc=none;
 *   spf=none (mx.cloudflare.net: no SPF records found …) smtp.helo=mail-ed1-x535.google.com;
 *   spf=pass (mx.cloudflare.net: domain of x@gmail.com designates … as permitted sender) smtp.mailfrom=x@gmail.com;
 *   arc=pass smtp.remote-ip="…"
 * ```
 *
 * That is the deterministic half of mail security, and it costs nothing: no model, no lookup, no request.
 * Measured on two real messages, 17 September 2026 (`email-authentication-results.md`).
 *
 * ## Only the receiving server's header is read
 *
 * RFC 8601 §7.1 is explicit: a message may arrive carrying `Authentication-Results` headers written by
 * earlier hops — or by the sender, forged — and a verifier must trust only the one bearing its own
 * `authserv-id`. So this reads the header whose authserv-id is the MX this Node receives through and
 * nothing else; a message with none is `absent`, which is not `pass` and not `fail`. ARC headers
 * (`ARC-Authentication-Results`) are a different field and are not consulted: `arc=` inside Cloudflare's
 * own header is the summary that matters.
 *
 * ## Words, not scores
 *
 * Every result is one of RFC 8601's own tokens, kept as Cloudflare wrote it. Nothing here decides what a
 * `fail` means for a mailbox; that is a policy's question, and a fact a Butler can read. A `none` for DMARC
 * means the sender's domain publishes no policy, which is most of the internet, and rendering that as a
 * warning would train people to ignore the warning that matters.
 */

export type AuthenticationResult =
  | "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | "absent";

export interface AuthenticationVerdict {
  /** The MX whose header this is. */
  authserv: string;
  /** SPF for the envelope sender (`smtp.mailfrom`), which is the one that decides; the HELO check is not it. */
  spf: AuthenticationResult;
  dkim: AuthenticationResult;
  /** The domain whose DKIM signature verified, when one did. */
  dkimDomain: string | null;
  dmarc: AuthenticationResult;
  /** The `From:` domain DMARC was evaluated for. */
  fromDomain: string | null;
  /** What that domain asked receivers to do on failure — `none`, `quarantine` or `reject` — as published. */
  dmarcPolicy: string | null;
  arc: AuthenticationResult;
}

const RESULTS: ReadonlySet<string> = new Set([
  "pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy",
]);

/** The MX this Node receives through; what every inbound message's trusted header names. */
export const RECEIVING_AUTHSERV = "mx.cloudflare.net";

function resultOf(token: string): AuthenticationResult {
  const word = token.trim().toLowerCase();
  return (RESULTS.has(word) ? word : "absent") as AuthenticationResult;
}

/** Drops RFC 5322 comments — the parenthesised explanations — which may carry semicolons and equals signs. */
function withoutComments(value: string): string {
  let depth = 0;
  let out = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

interface Clause {
  method: string;
  result: AuthenticationResult;
  props: Map<string, string>;
}

function clausesOf(header: string): { authserv: string; clauses: Clause[] } {
  const parts = withoutComments(header).split(";").map((one) => one.trim()).filter((one) => one !== "");
  // The authserv-id may carry a version: `mx.cloudflare.net 1`.
  const authserv = (parts[0] ?? "").split(/\s+/)[0] ?? "";
  const clauses: Clause[] = [];
  for (const part of parts.slice(1)) {
    const tokens = part.split(/\s+/);
    const head = tokens[0] ?? "";
    const equals = head.indexOf("=");
    if (equals < 1) continue;
    const props = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const at = token.indexOf("=");
      if (at < 1) continue;
      props.set(token.slice(0, at).toLowerCase(), token.slice(at + 1).replace(/^"|"$/g, ""));
    }
    clauses.push({ method: head.slice(0, equals).toLowerCase(), result: resultOf(head.slice(equals + 1)), props });
  }
  return { authserv, clauses };
}

/**
 * Reads the receiving server's verdict out of a message's header fields, as `headerFields` returns them.
 *
 * `authserv` names which server's header to trust. A message carrying no `Authentication-Results` from it
 * — because it arrived some other way, or predates the header — is `absent` on every method, which is the
 * honest answer and distinct from `none`.
 */
export function authenticationOf(
  fields: Map<string, string[]>, authserv: string = RECEIVING_AUTHSERV,
): AuthenticationVerdict {
  const absent: AuthenticationVerdict = {
    authserv, spf: "absent", dkim: "absent", dkimDomain: null, dmarc: "absent",
    fromDomain: null, dmarcPolicy: null, arc: "absent",
  };
  const headers = fields.get("authentication-results") ?? [];
  const own = headers.map(clausesOf).find((one) => one.authserv.toLowerCase() === authserv.toLowerCase());
  if (own === undefined) return absent;

  const verdict = { ...absent };
  for (const clause of own.clauses) {
    switch (clause.method) {
      case "spf":
        // Two SPF clauses is normal: one for HELO, one for MAIL FROM. The envelope sender is the verdict;
        // the HELO one is kept only when nothing names a mailfrom.
        if (clause.props.has("smtp.mailfrom") || verdict.spf === "absent") verdict.spf = clause.result;
        break;
      case "dkim":
        // The first passing signature wins; a failing one beside a passing one is a re-signing hop, not a
        // forgery. With none passing, the first result stands.
        if (verdict.dkim !== "pass") {
          verdict.dkim = clause.result;
          verdict.dkimDomain = clause.props.get("header.d") ?? verdict.dkimDomain;
        }
        break;
      case "dmarc":
        verdict.dmarc = clause.result;
        verdict.fromDomain = clause.props.get("header.from") ?? null;
        verdict.dmarcPolicy = clause.props.get("policy.dmarc") ?? null;
        break;
      case "arc":
        verdict.arc = clause.result;
        break;
      default:
        break;
    }
  }
  return verdict;
}
