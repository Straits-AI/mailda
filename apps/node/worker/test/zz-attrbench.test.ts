import { describe, it } from "vitest";
import { sanitizeHtml } from "../src/render/body";

const N = [400, 2000, 5000, 10000, 20000, 50000, 120000];

describe("attr quadratic claim", () => {
  for (const n of N) {
    it(`n=${n}`, async () => {
      const attrs = Array.from({ length: n }, (_, i) => `d${i}=v`).join(" ");
      const input = `<div ${attrs}>t</div>`;
      const bytes = new TextEncoder().encode(input).length;
      const t0 = Date.now();
      let out = "", err = "";
      try {
        out = (await sanitizeHtml(input)).html;
      } catch (e) {
        err = String((e as Error).message);
      }
      const dt = Date.now() - t0;
      console.log(`RESULT n=${n} bytes=${bytes} ms=${dt} outlen=${out.length} out=${JSON.stringify(out.slice(0,80))} err=${err}`);
    }, 600000);
  }
});
