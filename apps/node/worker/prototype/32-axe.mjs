import { readFileSync } from "node:fs";
import { chromium } from "playwright";

// The harness seed for ADR 30: axe-core per screen, AA, run against the real rendered DOM rather
// than against a claim about it. Each variant is its own screen.
const AXE = readFileSync(new URL("./node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const PAGE = "file:///Users/sohweimeng/Documents/projects/mailda/apps/node/worker/prototype/32-shell-variants.html";
const VARIANTS = ["a", "b", "c"];
const THEMES = ["dark", "light"];

const browser = await chromium.launch();
let total = 0;

for (const theme of THEMES) {
  for (const variant of VARIANTS) {
    const page = await browser.newPage({ colorScheme: theme });
    await page.goto(`${PAGE}?variant=${variant}`);
    // The prototype is body-content only, because that is what an Artifact wraps. The real shell
    // does set <html lang="en"> (src/ui.ts), so supplying it here removes a false positive rather
    // than hiding a defect.
    await page.evaluate(`document.documentElement.lang = "en";
      document.documentElement.dataset.theme = "${theme}"`);
    await page.addScriptTag({ content: AXE });
    const result = await page.evaluate(`axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }
    })`);

    const violations = result.violations;
    total += violations.length;
    const head = `${theme.padEnd(5)} variant ${variant.toUpperCase()}`;
    if (violations.length === 0) {
      console.log(`${head}  clean  (${result.passes.length} checks passed)`);
    } else {
      console.log(`${head}  ${violations.length} violation(s)`);
      for (const v of violations) {
        console.log(`    [${v.impact}] ${v.id} — ${v.help}  (${v.nodes.length} node(s))`);
        console.log(`        ${v.nodes[0].target.join(" ")}`);
      }
    }
    await page.close();
  }
}

await browser.close();
console.log(total === 0 ? "\nAA: no violations across 3 variants x 2 themes" : `\nAA: ${total} violation(s) to fix`);
process.exitCode = total === 0 ? 0 : 1;
