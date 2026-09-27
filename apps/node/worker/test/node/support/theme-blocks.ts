/**
 * Reading a stylesheet's structure, for the tests that hold what the served CSS says.
 *
 * Both readers parse braces rather than match phrases (AGENTS.md §2c, rung 3): a rule reworded, split across
 * lines or mentioned in a comment cannot be mistaken for the thing a test is looking for, and a block that is
 * missing cannot pass as an empty one.
 */

/** The bodies of the three theme blocks `src/theme.ts` writes, each without its braces. */
export interface ThemeBlocks {
  /** `:root { … }`, the unqualified root, which is what makes Dark the default. */
  readonly dark: string;
  /** `:root[data-theme="light"] { … }`. */
  readonly light: string;
  /** `:root[data-theme="system"] { … }`, inside the one `@media (prefers-color-scheme: light)`. */
  readonly system: string;
  /** The index just past the media block's closing brace: where whatever follows the blocks begins. */
  readonly end: number;
}

const DARK = ":root {";
const LIGHT = ':root[data-theme="light"] {';
const SYSTEM = ':root[data-theme="system"] {';
const MEDIA = "@media (prefers-color-scheme: light) {";

/** Every index at which `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** The index of the brace that closes the one opened at `open`, counted, so nested blocks are skipped. */
function closing(css: string, open: number, what: string): number {
  let depth = 0;
  for (let at = open; at < css.length; at += 1) {
    if (css[at] === "{") depth += 1;
    else if (css[at] === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  throw new Error(`the ${what} block is never closed`);
}

/** The one occurrence of a header, or a throw naming the block when there are none or several. */
function only(css: string, header: string, what: string): number {
  const found = occurrences(css, header);
  if (found.length === 0) throw new Error(`no ${what} block: expected one headed ${header}`);
  if (found.length > 1) throw new Error(`the ${what} block appears ${found.length} times: expected one headed ${header}`);
  return found[0]!;
}

/**
 * Locates the three theme blocks and returns their bodies, or throws naming the block that is missing,
 * duplicated or out of order.
 *
 * `dark` is the block that opens the string; `light` the one block headed `:root[data-theme="light"] {`, after
 * it; `system` the one block headed `:root[data-theme="system"] {`, which must sit inside the one
 * `@media (prefers-color-scheme: light) {`, after `light`. The order is part of the contract rather than a
 * habit: Light and System win on specificity, not order, but a sheet whose blocks moved is a sheet somebody
 * rewrote by hand, and the tests that read it should hear about it.
 */
export function themeBlocks(css: string): ThemeBlocks {
  // `mutants` reports the strict comparisons below (and the two loop bounds in this file) surviving a change
  // to <= or >=. They are equivalent mutants, not gaps: each compares the index of a header's first
  // character with the index of a closing brace, which can never be equal, and a loop bound one past the end
  // reads an undefined character that matches nothing. `contrast.test.ts` refuses a sheet for each guard.
  if (!css.startsWith(DARK)) throw new Error(`no dark block: the sheet must open with ${DARK}`);
  only(css, DARK, "dark");
  const darkEnd = closing(css, DARK.length - 1, "dark");

  const light = only(css, LIGHT, "light");
  if (light < darkEnd) throw new Error("the light block is inside or before the dark block");
  const lightOpen = light + LIGHT.length - 1;
  const lightEnd = closing(css, lightOpen, "light");

  const media = only(css, MEDIA, "prefers-color-scheme: light");
  if (media < lightEnd) throw new Error("the system block's media query comes before the light block ends");
  const mediaEnd = closing(css, media + MEDIA.length - 1, "prefers-color-scheme: light");
  const system = only(css, SYSTEM, "system");
  if (system < media || system > mediaEnd) {
    throw new Error("the system block is not inside @media (prefers-color-scheme: light)");
  }
  const systemOpen = system + SYSTEM.length - 1;
  const systemEnd = closing(css, systemOpen, "system");

  return {
    dark: css.slice(DARK.length, darkEnd),
    light: css.slice(lightOpen + 1, lightEnd),
    system: css.slice(systemOpen + 1, systemEnd),
    end: mediaEnd + 1,
  };
}

/** One style rule: its selector list, split and trimmed, and its declarations in order. */
export interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyArray<{ readonly property: string; readonly value: string }>;
}

/**
 * Every style rule in a stylesheet, including those inside `@media`, in source order.
 *
 * Comments are removed first, so a rule quoted in prose is not a rule. `@font-face` and `@keyframes` are
 * skipped: neither holds a selector a page can match. Declarations hold no braces in this sheet, so a block's
 * end is its first closing brace at the same depth.
 */
export function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const walk = (from: number, to: number): void => {
    let at = from;
    while (at < to) {
      const open = text.indexOf("{", at);
      if (open === -1 || open >= to) return;
      const prelude = text.slice(at, open).trim();
      const end = closing(text, open, prelude);
      if (prelude.startsWith("@media") || prelude.startsWith("@supports")) {
        walk(open + 1, end);
      } else if (!prelude.startsWith("@")) {
        rules.push({
          selectors: prelude.split(",").map((one) => one.trim()),
          declarations: text.slice(open + 1, end).split(";").flatMap((one) => {
            const colon = one.indexOf(":");
            if (colon === -1) return [];
            return [{ property: one.slice(0, colon).trim(), value: one.slice(colon + 1).trim() }];
          }),
        });
      }
      at = end + 1;
    }
  };
  walk(0, text.length);
  return rules;
}
