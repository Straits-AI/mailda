import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/render/body.ts";

const cases: Record<string, string> = {
  claim_exact: "<foo><</foo>img src=https://tracker.example/split.gif>",
  claim_meta: "<p>a</p><xx><</xx>meta http-equiv=refresh content=0;url=https://tracker.example/r>",
  claim_span_control: "<p>a</p><span><</span>img src=https://tracker.example/x.gif>",
  bare_lt_text: "<p>a</p>< img src=https://tracker.example/x.gif>",
  lone_lt_only: "<foo><</foo>b>bold?",
  split_two_unknown: "<foo><</foo><bar>img src=https://tracker.example/y.gif</bar>>",
  drop_boundary: "<script>x</script>img src=https://tracker.example/z.gif>",
  amp_lt: "<foo>&lt;</foo>img src=https://tracker.example/a.gif>",
};

describe("split-probe", () => {
  it("dump", async () => {
    const lines: string[] = [];
    for (const [name, input] of Object.entries(cases)) {
      const r = await sanitizeHtml(input);
      lines.push(`### ${name}\n  IN : ${input}\n  OUT: ${r.html}\n  blocked=${r.blockedRemote}`);
    }
    expect(lines.join("\n")).toBe("FORCE_FAIL");
  });
});
