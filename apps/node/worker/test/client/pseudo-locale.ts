import { CATALOGS } from "../../src/i18n/catalog.ts";
import type { Message } from "../../src/i18n/format.ts";
import { NOT_PROSE } from "../node/untranslated.registry.ts";

/**
 * `en-XA`, the pseudo-locale (T4, `docs/i18n.md`): English with every ASCII letter accented, each message wrapped
 * in ⟦ ⟧ and padded by 40%, its `{placeholders}` kept byte for byte so `parts()` still fills them. Test-only: it
 * is built here from the English catalog, never listed in `LOCALES`, never served, never bundled
 * (`pseudo-locale.test.tsx` holds all three).
 *
 * What it is for: a word on screen that came from the catalog has no ASCII letter left in it, so any ASCII word a
 * render shows came from somewhere else, a literal the migration missed or the Node's English left unmarked.
 * The padding is the length a German or a Finnish string brings; the brackets show where a message was cut.
 * `untranslated()` below is the reading, shared by the React routes (`pseudo-locale.test.tsx`) and the pages
 * before sign-in (`pseudo-preauth.test.ts`).
 */

export const PSEUDO_TAG = "en-XA";

const LOWER = "áƀçđéƒĝĥíĵķĺɱñóþǫŕšţúṽŵẋýž";
const UPPER = "ÁƁÇĐÉƑĜĤÍĴĶĹṀÑÓÞǪŔŠŢÚṼŴẊÝŽ";

function accent(text: string): string {
  return text.replace(/[A-Za-z]/g, (letter) => {
    const code = letter.charCodeAt(0);
    return code >= 97 ? [...LOWER][code - 97]! : [...UPPER][code - 65]!;
  });
}

/** One string: placeholders kept, everything between them accented, padded and bracketed. */
export function pseudoString(text: string): string {
  // A separator with no letter in it (`join.sentence`, a bullet) is structure, and stays what it is.
  if (!/[A-Za-z]/.test(text)) return text;
  const body = text.split(/(\{\w+\})/).map((piece, index) => (index % 2 === 1 ? piece : accent(piece))).join("");
  return `⟦${body}${"·".repeat(Math.ceil(text.length * 0.4))}⟧`;
}

function pseudoMessage(message: Message): Message {
  if (typeof message === "string") return pseudoString(message);
  return Object.fromEntries(Object.entries(message).map(([category, text]) => [category, pseudoString(text!)])) as Message;
}

/** Every key the English catalog has, `preauth` and `app`, in pseudo. */
export function pseudoTable(): Record<string, Message> {
  const english: Record<string, Message> = { ...CATALOGS.en.preauth, ...CATALOGS.en.app };
  return Object.fromEntries(Object.entries(english).map(([key, message]) => [key, pseudoMessage(message)]));
}

/* ------------------------------------------------------------------------------------------- the reading --- */

/** What a page may show in Latin that is not an untranslated word. */
export interface Allowance {
  /** Registered non-words, each matched as a whole text or attribute, never as part of one. */
  readonly notWords: ReadonlySet<string>;
  /** Latin data (a host, a link), removed wherever it appears before a text is read. */
  readonly latin: readonly string[];
}

/**
 * The texts `NOT_PROSE` registers for the files `owns` picks: T3's one list of literals that are not words, each
 * with its reason, so this check and that one cannot disagree about what a word is.
 * ponytail: a class name registered there ("mono") would pass as a whole visible text too; none is shown as one.
 */
export function notProse(owns: (file: string) => boolean): ReadonlySet<string> {
  return new Set(Object.entries(NOT_PROSE).filter(([file]) => owns(file)).flatMap(([, entries]) => entries.map((entry) => entry.text)));
}

/** Whether a text shows a Latin letter that is neither a registered non-word nor Latin data. */
export function english(text: string, allowance: Allowance): boolean {
  if (allowance.notWords.has(text.trim())) return false;
  return /[A-Za-z]/.test(allowance.latin.reduce((rest, data) => rest.replaceAll(data, ""), text));
}

/** Where Latin is allowed: the Node's own English (`lang="en"`), and identifiers in `<code>`, `<kbd>`, `<samp>`. */
function allowed(element: Element): boolean {
  if (element.closest("code, kbd, samp") !== null) return true;
  return element.closest("[lang]")?.getAttribute("lang") === "en";
}

const ATTRIBUTES = ["aria-label", "aria-description", "aria-valuetext", "title", "placeholder", "alt"] as const;

/** The Latin runs in a text, which is what a reader of a failure needs first. */
const runs = (text: string): string => `[${[...new Set(text.match(/[A-Za-z][A-Za-z0-9_.-]*/g))].join(" ")}]`;

/** Each visible text, or named attribute, under `root` that shows a word this interface did not take from its catalog. */
export function untranslated(root: Element, allowance: Allowance): string[] {
  const hits: string[] = [];
  const where = (element: Element) => {
    const path: string[] = [];
    for (let at: Element | null = element; at !== null && at !== root && path.length < 4; at = at.parentElement) {
      path.unshift(at.tagName.toLowerCase() + (at.className && typeof at.className === "string" ? `.${at.className.split(" ")[0]}` : ""));
    }
    return path.join(" > ");
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      // A field's own content is what somebody typed or a persisted default (G9): data, not the interface's words.
      if (parent === null || parent.closest("textarea, script, style") !== null || allowed(parent)) continue;
      if (english(node.textContent ?? "", allowance)) hits.push(`${runs(node.textContent!)} in ${where(parent)}: ${JSON.stringify(node.textContent)}`);
      continue;
    }
    const element = node as Element;
    if (allowed(element)) continue;
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && english(value, allowance)) hits.push(`${runs(value)} in ${where(element)} [${name}]: ${JSON.stringify(value)}`);
    }
  }
  return hits;
}
