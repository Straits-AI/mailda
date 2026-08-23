/**
 * RFC 5322 mailbox-list splitting for the composer's "To" line.
 *
 * The naive `value.split(/[,;]+/)` this replaces broke on the most common
 * display name there is — `"Doe, Jane" <jane@example.com>` — turning one
 * valid recipient into two invalid ones, and the corruption was sealed into
 * the immutable manifest. See issue #100.
 *
 * What this handles, per the ticket:
 * - quoted display names containing separators (`"Doe, Jane" <a@b>`)
 * - escaped quotes inside quoted strings (`"Say \"hi\"" <c@z>`)
 * - parenthesized comments (`Jane Doe (Support) <a@b>`)
 * - angle-addr forms with or without a display name (`<a@b>`, `a@b`)
 * - trailing / repeated separators and whitespace, unchanged behaviour
 *
 * What it deliberately does NOT do (also per the ticket): validate whether a
 * parsed mailbox is acceptable. Parsing only — the Node owns policy.
 */

/** Depth of nested comments we will track before giving up on balance. */
const MAX_COMMENT_DEPTH = 8;

export function splitAddresses(value: string): string[] {
  const recipients: string[] = [];
  let current = "";
  /** Inside a double-quoted string; backslash escapes are honored inside it. */
  let inQuotes = false;
  let escaped = false;
  /** Parenthesized comment nesting depth (RFC 5322 §3.2.3 allows nesting). */
  let commentDepth = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed !== "") recipients.push(trimmed);
    current = "";
  };

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (escaped) {
      // Only meaningful inside quotes/comments, but preserving the pair either way
      // keeps what was typed intact for whatever validates it later.
      current += char;
      escaped = false;
      continue;
    }

    if (inQuotes) {
      if (char === "\\") {
        current += char;
        escaped = true;
      } else {
        if (char === '"') inQuotes = false;
        current += char;
      }
      continue;
    }

    if (commentDepth > 0) {
      if (char === "\\") {
        // Backslash escapes work inside comments too; keep the pair together.
        current += char;
        if (i + 1 < value.length) current += value[++i];
      } else if (char === "(") {
        if (commentDepth < MAX_COMMENT_DEPTH) commentDepth++;
        current += char;
      } else if (char === ")") {
        commentDepth--;
        current += char;
      } else if (char === "," || char === ";") {
        // A separator inside an unterminated comment is part of the comment text,
        // not an address boundary.
        current += char;
      } else {
        current += char;
      }
      continue;
    }

    switch (char) {
      case '"':
        inQuotes = true;
        current += char;
        break;
      case "(":
        commentDepth = 1;
        current += char;
        break;
      case ",":
      case ";":
        flush();
        break;
      default:
        current += char;
    }
  }
  flush();

  return recipients;
}
