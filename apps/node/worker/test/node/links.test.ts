import { describe, expect, it } from "vitest";

import { judgeLink } from "../../src/render/links.ts";

const OURS = ["acme.example", "mail.acme.co.uk"];

/** Each verdict pinned to a link that earns it, and the shapes that must stay `plain` beside them. */
describe("a link is judged against what it says and against the organization's own domains", () => {
  it.each([
    ["https://acme.example/login", "Sign in", "plain"],
    ["https://acme.example/login", "https://acme.example/login", "plain"],
    ["https://www.acme.example/x", "acme.example/x", "plain"],
    ["https://docs.vendor.test/guide", "the guide", "plain"],
    ["mailto:help@acme.example", "help@acme.example", "plain"],
    ["https://evil.test/login", "https://acme.example/login", "mismatch"],
    ["https://evil.test/login", "acme.example", "mismatch"],
    ["https://evil.test/", "www.bank.test", "mismatch"],
    ["https://acme-example.test/", "Sign in", "lookalike"],
    ["https://acme.example.evil.test/", "Sign in", "lookalike"],
    ["https://acne.example/", "Sign in", "lookalike"],
    // One edit is the net. `rn` for `m` is two, and is a link the reader judges — stated in links.ts.
    ["https://acrne.example/", "Sign in", "plain"],
    ["https://xn--acme-9ra.example/", "Sign in", "lookalike"],
    ["https://login.acme.example.co/", "Sign in", "lookalike"],
    ["https://acme.example@evil.test/", "acme.example", "userinfo"],
    ["https://203.0.113.9/pay", "Pay now", "ip_host"],
    ["https://[2001:db8::1]/pay", "Pay now", "ip_host"],
    ["not a url", "text", "plain"],
  ] as const)("%s reading %j is %s", (href, text, verdict) => {
    expect(judgeLink(href, text, OURS).verdict).toBe(verdict);
  });

  it("keeps the sender's href and the text, bounded, and never rewrites the destination", () => {
    const long = `https://vendor.test/${"a".repeat(500)}`;
    const judged = judgeLink(long, "  click \n here  ", OURS);
    expect(judged.href).toBe(long.slice(0, 200));
    expect(judged.text).toBe("click here");
  });

  it("does not call an unrelated short domain a lookalike of a short one of ours", () => {
    // Distance one on a three-letter label would flag half the internet; the label floor is four.
    expect(judgeLink("https://abd.test/", "x", ["abc.test"]).verdict).toBe("plain");
  });
});
