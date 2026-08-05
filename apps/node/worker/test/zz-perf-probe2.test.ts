import { describe, it } from "vitest";
import { sanitizeHtml } from "../src/render/body.ts";

const attrs = (n: number) => Array.from({ length: n }, (_, i) => "a" + i.toString(36)).join(" ");

const run = async (label: string, input: string) => {
  const t0 = Date.now();
  const { html } = await sanitizeHtml(input);
  console.log(`${label} inLen=${input.length} ms=${Date.now() - t0} out=${JSON.stringify(html.slice(0, 50))}`);
};

describe("isolate repeat", () => {
  it("same as before", async () => {
    for (const n of [8000, 16000, 20000, 24000, 28000, 32000, 40000, 50000, 65000]) {
      await run(`R n=${n}`, `<div ${attrs(n)}>t</div>`);
    }
  }, 900000);
});
