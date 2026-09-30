import type { Concept } from "../../../src/i18n/glossary.ts";
import type { Message } from "../../../src/i18n/format.ts";

/**
 * The catalog checks as pure functions over data (AGENTS.md §2c, rung 2): each takes the tables and the
 * glossary rows and returns what is wrong, so `test/node/catalog.test.ts` runs them on the shipped catalogs
 * and on planted copies that must come back wrong.
 */

export type Table = Readonly<Record<string, Message>>;

/** One locale as the checks see it. */
export interface LocaleWords {
  readonly tag: string;
  readonly preview: boolean;
  readonly table: Table;
}

export interface World {
  /** The source locale's words, every key. */
  readonly source: Table;
  /** Every other locale. */
  readonly locales: readonly LocaleWords[];
  readonly concepts: readonly Concept[];
  readonly never: Readonly<Record<string, ReadonlyArray<{ readonly phrase: string }>>>;
  readonly negates: Readonly<Record<string, readonly string[] | undefined>>;
}

const branches = (message: Message): string[] => (typeof message === "string" ? [message] : Object.values(message) as string[]);
const placeholders = (message: Message): string[] =>
  [...new Set(branches(message).flatMap((one) => [...one.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)))].sort();
/** Backticked spans are identifiers, and placeholders are the caller's values: neither is the locale's words. */
const words = (text: string): string => text.replace(/`[^`]*`/g, "⁠").replace(/\{\w+\}/g, "⁠");

/**
 * Each locale uses exactly the source's placeholders. `n` counts as present in a plural either way, because a
 * `one` branch may spell the number; but a plural a locale writes as one string (Chinese has only `other`)
 * must say `{n}`, or the count is lost.
 */
export function placeholderParity(world: World): string[] {
  return world.locales.flatMap(({ tag, table }) => Object.keys(world.source).flatMap((key) => {
    const source = world.source[key]!;
    const target = table[key];
    // Unreachable for the shipped catalogs, whose types refuse a missing key; it names the key for a planted
    // table instead of failing on `undefined` below. `mutants` reports this guard as a survivor, by design.
    if (target === undefined) return [`${tag} ${key}: missing`];
    const plural = typeof source !== "string";
    const set = (message: Message) => JSON.stringify([...new Set(placeholders(message).concat(plural ? ["n"] : []))].sort());
    const bad: string[] = [];
    if (set(target) !== set(source)) bad.push(`${tag} ${key}: placeholders ${set(target)}, the source has ${set(source)}`);
    if (plural && typeof target === "string" && !target.includes("{n}")) bad.push(`${tag} ${key}: a plural written as one string must say {n}`);
    return bad;
  }));
}

/** A plural uses exactly the categories its locale has (`Intl.PluralRules`), no fewer and no more. */
export function pluralShape(tag: string, table: Table): string[] {
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories as string[];
  return Object.entries(table).flatMap(([key, message]) => {
    if (typeof message === "string") return [];
    const used = Object.keys(message);
    return [
      ...used.filter((one) => !categories.includes(one)).map((one) => `${tag} ${key}: ${one} is not a ${tag} category`),
      ...categories.filter((one) => !used.includes(one)).map((one) => `${tag} ${key}: ${tag} needs ${one}`),
    ];
  });
}

const HAN = String.raw`\p{Script=Han}`;
/**
 * The register rules a machine can hold for Chinese (`docs/i18n.md`): full-width punctuation beside Han, and
 * one space between Han and a Latin letter or digit.
 */
export function chinesePunctuation(tag: string, table: Table): string[] {
  const ascii = new RegExp(`${HAN}[,.:;?!()"]|[,.:;?!()"]${HAN}`, "u");
  const touching = new RegExp(`${HAN}[A-Za-z0-9]|[A-Za-z0-9]${HAN}`, "u");
  return Object.entries(table).flatMap(([key, message]) => branches(message).flatMap((one) => {
    const bare = words(one);
    return [
      ...(ascii.test(bare) ? [`${tag} ${key}: ASCII punctuation beside Han`] : []),
      ...(touching.test(bare) ? [`${tag} ${key}: Han touching Latin or a digit without a space`] : []),
    ];
  }));
}

/** Whether `source` names the concept's English word, outside backticks, as a whole word. */
function names(concept: Concept, source: Message): boolean {
  const word = new RegExp(`(?<![\\p{L}\\p{N}])${concept.en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
  return branches(source).some((one) => word.test(one.replace(/`[^`]*`/g, "")));
}

/** The keys a concept governs: its own, its bound sentences, and for a prose concept every key whose English names it. */
export function governed(concept: Concept, source: Table): string[] {
  const own = new Set<string>([...concept.keys, ...concept.sentences]);
  if (concept.prose) for (const [key, message] of Object.entries(source)) if (names(concept, message)) own.add(key);
  return [...own];
}

/**
 * The glossary, in every locale including the source:
 *
 * - a concept's own keys equal its term;
 * - a governed key does not use an avoided phrase (the term itself removed first, so a term may contain one);
 * - a prose concept's governed keys contain its term.
 */
export function glossaryTerms(world: World): string[] {
  const all = [{ tag: "en", table: world.source }, ...world.locales];
  return world.concepts.flatMap((concept) => all.flatMap(({ tag, table }) => {
    const term = (concept as unknown as Record<string, string>)[tag];
    // Reachable only when a locale is added without a glossary column, which the Concept type refuses; the
    // guard names the gap rather than comparing against `undefined`. A `mutants` survivor, by design.
    if (term === undefined) return [`${concept.id}: no ${tag} term`];
    const avoid = concept.avoid[tag as keyof Concept["avoid"]] ?? [];
    return governed(concept, world.source).flatMap((key) => {
      const message = table[key];
      // Unreachable while `keys` is typed `Key` and every locale has every key; a planted table can reach it.
      // A `mutants` survivor, by design.
      if (message === undefined) return [`${tag} ${key}: bound to ${concept.id} and absent`];
      const own = (concept.keys as readonly string[]).includes(key);
      return branches(message).flatMap((one) => {
        const bad: string[] = [];
        if (own && one !== term) bad.push(`${tag} ${key}: is ${JSON.stringify(one)}, ${concept.id} says ${JSON.stringify(term)}`);
        if (!own && !one.includes(term)) bad.push(`${tag} ${key}: names ${concept.en} in English and not ${term}`);
        const rest = one.split(term).join("⁠");
        for (const phrase of avoid) if (rest.includes(phrase)) bad.push(`${tag} ${key}: uses ${phrase}, which ${concept.id} avoids`);
        return bad;
      });
    });
  }));
}

/** No locale-wide never-phrase anywhere, except in a key that declares it negates the phrase. */
export function neverPhrases(world: World): string[] {
  return world.locales.flatMap(({ tag, table }) => (world.never[tag] ?? []).flatMap(({ phrase }) =>
    Object.entries(table).flatMap(([key, message]) => {
      if ((world.negates[key] ?? []).includes(phrase)) return [];
      return branches(message).some((one) => one.includes(phrase)) ? [`${tag} ${key}: contains ${phrase}`] : [];
    })));
}

/**
 * A locale that is not a preview ships no key governed by a proposed row: its words are the owner's
 * confirmed words, or they are not shipped. A preview may carry proposed words, which is what it is for.
 */
export function confirmedBeforeShipping(world: World): string[] {
  return world.locales.filter(({ preview }) => !preview).flatMap(({ tag }) => world.concepts
    .filter((concept) => concept.status === "proposed")
    .flatMap((concept) => governed(concept, world.source).map((key) => `${tag} ${key}: ${concept.id} is proposed, not confirmed`)));
}
