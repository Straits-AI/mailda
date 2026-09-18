import { describe, expect, it } from "vitest";

import { authenticationOf } from "../../src/authentication-results.ts";
import { headerFields } from "../../src/mime.ts";

/** Cloudflare's own header on a real message from Gmail, 3 August 2026, unfolded. */
const GMAIL =
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20251104 header.b=LZOq2czn; "
  + "dmarc=pass header.from=gmail.com policy.dmarc=none; "
  + "spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-ed1-x535.google.com) "
  + "smtp.helo=mail-ed1-x535.google.com; "
  + "spf=pass (mx.cloudflare.net: domain of sender@alpha.example designates 2a00:1450:4864:20::535 as permitted "
  + "sender) smtp.mailfrom=sender@alpha.example; arc=pass smtp.remote-ip=\"2a00:1450:4864:20::535\"";

function fieldsOf(...headers: string[]): Map<string, string[]> {
  return headerFields(`${headers.join("\r\n")}\r\nFrom: a@b.test\r\n`);
}

describe("reading the receiving server's Authentication-Results", () => {
  it("takes the envelope sender's SPF, not the HELO's, and keeps every other result as written", () => {
    const verdict = authenticationOf(fieldsOf(GMAIL));
    expect(verdict).toEqual({
      authserv: "mx.cloudflare.net",
      spf: "pass", dkim: "pass", dkimDomain: "gmail.com",
      dmarc: "pass", fromDomain: "gmail.com", dmarcPolicy: "none", arc: "pass",
    });
  });

  it("is absent on every method when no header from the receiving server exists", () => {
    // Not `none`: `none` is a verdict ("this domain publishes nothing"); `absent` is "nobody looked here".
    const verdict = authenticationOf(fieldsOf("From: a@b.test"));
    expect(verdict.spf).toBe("absent");
    expect(verdict.dmarc).toBe("absent");
  });

  it("ignores an Authentication-Results header another server wrote, or a sender forged", () => {
    /*
     * RFC 8601 §7.1. A message can carry any number of these from earlier hops, and a sender can write one
     * claiming `dmarc=pass`. Only the header bearing this Node's own MX is the verdict; the forged one below
     * would read as a pass if the first header were taken.
     */
    const forged = "Authentication-Results: mx.cloudflare.net.evil.test; dmarc=pass header.from=bank.test";
    const upstream = "Authentication-Results: mx.google.com; dkim=fail header.d=bank.test";
    const own = "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=bank.test policy.dmarc=reject; "
      + "spf=fail smtp.mailfrom=x@bank.test";
    const verdict = authenticationOf(fieldsOf(forged, upstream, own));
    expect(verdict.dmarc).toBe("fail");
    expect(verdict.dmarcPolicy).toBe("reject");
    expect(verdict.spf).toBe("fail");
    expect(verdict.dkim).toBe("absent");
  });

  it("does not let a comment's punctuation split a clause", () => {
    const tricky = "Authentication-Results: mx.cloudflare.net; spf=pass (reason: designates 1.2.3.4; as=permitted) "
      + "smtp.mailfrom=a@b.test; dkim=none (no signatures; none at all)";
    const verdict = authenticationOf(fieldsOf(tricky));
    expect(verdict.spf).toBe("pass");
    expect(verdict.dkim).toBe("none");
  });

  it("keeps a passing DKIM signature over a failing one beside it, which is a re-signing hop", () => {
    const two = "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=list.test; dkim=pass header.d=sender.test";
    const verdict = authenticationOf(fieldsOf(two));
    expect(verdict.dkim).toBe("pass");
    expect(verdict.dkimDomain).toBe("sender.test");
  });

  it("reads a result token it does not recognise as absent rather than inventing one", () => {
    const odd = "Authentication-Results: mx.cloudflare.net; dmarc=bestpass header.from=x.test";
    expect(authenticationOf(fieldsOf(odd)).dmarc).toBe("absent");
  });
});
