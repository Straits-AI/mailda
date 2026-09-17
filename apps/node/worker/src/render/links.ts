import type { LinkVerdict } from "@mailda/contract/schemas";

/**
 * What a link in a message actually points at, held against what it says (docs/mail-security.md, row 3).
 *
 * Nothing is rewritten (ADR 37): the href a reader clicks is the one the sender wrote, and the browser
 * shows it on hover. What the browser cannot do is compare. A link whose text reads `bank.example/login`
 * and whose href goes elsewhere is the oldest phishing shape there is, and a host that looks like one of
 * this organization's own domains and is not is the second oldest. Both are decided here, from the URL
 * and the text alone — no lookup, no list, no model — and said as one of five words.
 *
 * ## The own-domain comparison is approximate, and says so
 *
 * There is no public-suffix list in a Worker's stdlib, so "the registrable domain" is the last two labels,
 * or three when the second-last is two letters under a two-letter TLD (`example.co.uk`). That is wrong for
 * some suffixes and right for the ones mail arrives from.
 * ponytail: no PSL; last-two-labels heuristic. Bundle a suffix list if a customer's own domain misjudges.
 *
 * `lookalike` fires when the link's registrable domain is not one of ours but is one edit away from one,
 * or carries one of ours as a label or a prefix (`bank-example.test`, `bank.example.evil.test`), or is
 * punycode. Distance one is deliberate: `paypa1` and `paypal`, `rnicrosoft` is two and is missed, and a
 * wider net catches `mail.example` against `mai.example`. A missed lookalike is a link the reader judges;
 * a false one trains the reader to ignore the word.
 */
export interface JudgedLink {
  /** As written, bounded, so a surface can show where a link really goes. */
  href: string;
  /** The link's visible text, whitespace collapsed and bounded; empty for an image link. */
  text: string;
  verdict: LinkVerdict;
}

const MAX_SHOWN = 200;

function registrable(host: string): string {
  const labels = host.toLowerCase().split(".").filter((one) => one !== "");
  if (labels.length <= 2) return labels.join(".");
  const [tld, sld] = [labels[labels.length - 1]!, labels[labels.length - 2]!];
  const take = tld.length === 2 && sld.length <= 3 && labels.length >= 3 ? 3 : 2;
  return labels.slice(-take).join(".");
}

function editDistance(a: string, b: string): number {
  // Levenshtein over two short labels; the bound on what is compared keeps this trivial.
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * The host `text` names, if it names one: the first token that reads as a URL or a dotted hostname.
 * "Sign in" names nothing and so does a one-word label; "visit acme.example/login" names acme.example.
 */
function hostNamedBy(text: string): string | null {
  const found = /(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/i.exec(text);
  if (found === null) return null;
  const token = found[0];
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : `https://${token}`).hostname || null;
  } catch {
    return null;
  }
}

function isLookalike(host: string, ownDomains: readonly string[]): boolean {
  if (host.split(".").some((label) => label.startsWith("xn--"))) return true;
  const mine = registrable(host);
  for (const own of ownDomains) {
    const theirs = registrable(own);
    if (mine === theirs) return false;
    const ownLabel = theirs.split(".")[0] ?? "";
    // `bank-example.test`, `bank.example.evil.test`, `bankexample-login.test`: ours as a label or a prefix.
    if (host.split(/[.-]/).includes(ownLabel) && ownLabel.length >= 4) return true;
    if (host.includes(theirs) && mine !== theirs) return true;
    if (editDistance(mine.split(".")[0] ?? "", ownLabel) === 1 && ownLabel.length >= 4) return true;
  }
  return false;
}

export function judgeLink(href: string, text: string, ownDomains: readonly string[]): JudgedLink {
  const shownHref = href.trim().slice(0, MAX_SHOWN);
  const shownText = text.replace(/\s+/g, " ").trim().slice(0, MAX_SHOWN);
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return { href: shownHref, text: shownText, verdict: "plain" };
  }
  if (url.protocol === "mailto:") return { href: shownHref, text: shownText, verdict: "plain" };
  const host = url.hostname;
  let verdict: LinkVerdict = "plain";
  // Most deceptive first: `https://bank.example@evil.test` reads as ours in every client that shows it.
  if (url.username !== "" || url.password !== "") verdict = "userinfo";
  else if (isLookalike(host, ownDomains)) verdict = "lookalike";
  else {
    const named = hostNamedBy(shownText);
    if (named !== null && registrable(named) !== registrable(host)) verdict = "mismatch";
    // A bracketed IPv6 literal, or four dotted numbers.
    else if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) verdict = "ip_host";
  }
  return { href: shownHref, text: shownText, verdict };
}
