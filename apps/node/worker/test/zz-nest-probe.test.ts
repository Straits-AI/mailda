import { describe, it, expect } from "vitest";
import { sanitizeHtml, renderBody } from "../src/render/body.ts";

function mail(html: string): Uint8Array {
  const raw = [
    "From: a@b.com",
    "To: c@d.com",
    "Subject: t",
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="utf-8"',
    "",
    html,
    "",
  ].join("\r\n");
  return new TextEncoder().encode(raw);
}

describe("nest-probe", () => {
  it("dump", async () => {
    const out: string[] = [];
    for (const depth of [1000, 5000, 10000, 20000, 40000]) {
      const html = "<div>".repeat(depth) + "x" + "</div>".repeat(depth);
      const t0 = Date.now();
      try {
        const r = await sanitizeHtml(html);
        out.push(
          `sanitizeHtml depth=${depth} bytes=${html.length} OK ms=${Date.now() - t0} outLen=${r.html.length}`,
        );
      } catch (e) {
        out.push(
          `sanitizeHtml depth=${depth} bytes=${html.length} THREW ms=${Date.now() - t0} ${(e as Error).name}: ${(e as Error).message}`,
        );
      }
    }
    // unknown-tag variant (removeAndKeepContent path)
    for (const depth of [10000, 20000]) {
      const html = "<zzz>".repeat(depth) + "x" + "</zzz>".repeat(depth);
      const t0 = Date.now();
      try {
        const r = await sanitizeHtml(html);
        out.push(`unknown depth=${depth} OK ms=${Date.now() - t0} outLen=${r.html.length}`);
      } catch (e) {
        out.push(`unknown depth=${depth} THREW ms=${Date.now() - t0} ${(e as Error).message}`);
      }
    }
    // end-to-end through renderBody
    for (const depth of [20000]) {
      const html = "<div>".repeat(depth) + "x" + "</div>".repeat(depth);
      const t0 = Date.now();
      try {
        const r = await renderBody(mail(html));
        out.push(
          `renderBody depth=${depth} OK ms=${Date.now() - t0} state=${r.state} truncated=${r.truncated} htmlLen=${r.html?.length}`,
        );
      } catch (e) {
        out.push(
          `renderBody depth=${depth} THREW ms=${Date.now() - t0} ${(e as Error).name}: ${(e as Error).message}`,
        );
      }
    }
    expect("RESULTS\n" + out.join("\n")).toBe("X");
  });
});
