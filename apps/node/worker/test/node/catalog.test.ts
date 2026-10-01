import { describe, expect, it } from "vitest";

import { AREAS } from "../../src/i18n/areas.ts";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import * as en from "../../src/i18n/en/index.ts";
import { CONCEPTS, CONFIRMED, NEGATES, NEVER, type Concept } from "../../src/i18n/glossary.ts";
import { LOCALES } from "../../src/i18n/locales.ts";
import * as zhHans from "../../src/i18n/zh-Hans/index.ts";
import {
  chinesePunctuation, confirmedBeforeShipping, glossaryTerms, governed, neverPhrases, placeholderParity, pluralShape,
  type Table, type World,
} from "./support/catalog-checks.ts";

/**
 * The catalogs and the glossary, read as data (ADR 46, AGENTS.md §2c rung 2). The types already refuse a
 * missing or extra key and a wrong parameter (`test/client/catalog-types.test.ts`); these hold what a type
 * cannot see inside a string: placeholders, plural categories, Chinese punctuation, the glossary's words and
 * the phrases no locale may use.
 *
 * Every check runs twice: on the shipped catalogs, where it must find nothing, and on a planted copy, where it
 * must find the one planted defect (AGENTS.md §2b).
 */

/** Layer 2b's rows (1 October 2026), confirmed in the owner's round three (`docs/i18n.md`). */
const ROUND_THREE = [
  "team", "mint", "capability", "approve", "routing-rule", "pause", "supervised-read", "export", "breaker", "vouch", "lift",
  "administrator", "receipt.measured", "onboard", "zone", "apex", "token", "delivery-event", "subscription", "consumer",
];

/**
 * Layer 3's rows (2 October 2026), and H7's `butler-run.stopped`, accepted as proposed in round four: the owner said so
 * in the working session, without a review page (`docs/i18n.md`).
 */
const ROUND_FOUR = [
  "node.listening", "organization", "owner", "operator", "renew", "passkey-sign-in", "doctor.check", "credential-key", "signing-key",
  "key-generation", "evidence", "evidence-bucket", "catalog-db", "migration", "backlog", "stranded", "orphaned", "supervision-notice",
  "transport", "reduced-report", "sanitise", "classifier", "triage", "audit.refused", "workers-paid", "butler-run.stopped",
];

const whole = (locale: keyof typeof CATALOGS): Table => ({ ...CATALOGS[locale].preauth, ...CATALOGS[locale].app });

const WORLD: World = {
  source: whole("en"),
  locales: LOCALES.filter(({ tag }) => tag !== "en").map(({ tag, preview }) => ({ tag, preview, table: whole(tag) })),
  concepts: CONCEPTS,
  never: NEVER,
  negates: NEGATES,
};

/** The world with one locale's table changed, or its preview flag. */
function planted(changes: Table, options: { preview?: boolean; source?: Table } = {}): World {
  return {
    ...WORLD,
    source: { ...WORLD.source, ...options.source },
    locales: WORLD.locales.map((one) => ({
      ...one, preview: options.preview ?? one.preview, table: { ...one.table, ...changes },
    })),
  };
}

describe("the catalog's areas", () => {
  it("give every key prefix to one area only, so two areas cannot define the same key", () => {
    const prefixes = Object.values(AREAS).flat();
    expect(prefixes.length).toBeGreaterThan(5);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("join into the app table without one area shadowing another, in every locale", () => {
    for (const catalog of [en, zhHans]) {
      const sizes = Object.values(catalog.APP_AREAS).map((area) => Object.keys(area).length);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(Object.keys(catalog.app).length);
    }
    // The control: two areas sharing a key make the joined table smaller than the parts.
    const shadowed = { ...{ "route./": "a" }, ...{ "route./": "b" } };
    expect(Object.keys(shadowed).length).toBeLessThan(2);
  });

  it("keep each area's keys under its own prefixes, the pre-sign-in area included", () => {
    const under = (area: keyof typeof AREAS, table: object) =>
      Object.keys(table).filter((key) => !(AREAS[area] as readonly string[]).includes(key.split(".")[0]!));
    expect(under("preauth", en.preauth)).toEqual([]);
    for (const [area, table] of Object.entries(en.APP_AREAS)) expect(under(area as keyof typeof AREAS, table)).toEqual([]);
  });
});

describe("every locale against the source", () => {
  it("has the source's placeholders, and a one-string plural still says {n}", () => {
    expect(placeholderParity(WORLD)).toEqual([]);
    const key = "title.route";
    expect(placeholderParity(planted({ [key]: "{screen} · 淼达" }))).toEqual([`zh-Hans ${key}: placeholders ["screen"], the source has ["brand","screen"]`]);
    const plural = { "route./": { one: "{n} message", other: "{n} messages" } };
    expect(placeholderParity(planted({ "route./": "几封邮件" }, { source: plural })))
      .toEqual(["zh-Hans route./: a plural written as one string must say {n}"]);
  });

  it("uses exactly its locale's plural categories", () => {
    for (const { tag, table } of [{ tag: "en", table: WORLD.source }, ...WORLD.locales]) expect(pluralShape(tag, table)).toEqual([]);
    expect(pluralShape("en", { a: { other: "{n} messages" } })).toEqual(["en a: en needs one"]);
    expect(pluralShape("zh-Hans", { a: { one: "1 封", other: "{n} 封邮件" } })).toEqual(["zh-Hans a: one is not a zh-Hans category"]);
  });

  it("sets Chinese with full-width punctuation and a space between Han and Latin", () => {
    for (const { tag, table } of WORLD.locales) if (tag.startsWith("zh")) expect(chinesePunctuation(tag, table)).toEqual([]);
    expect(chinesePunctuation("zh-Hans", { a: "本节点,等待你认领。" })).toEqual(["zh-Hans a: ASCII punctuation beside Han"]);
    expect(chinesePunctuation("zh-Hans", { a: "认领Node" })).toEqual(["zh-Hans a: Han touching Latin or a digit without a space"]);
    // Placeholders and identifiers are exempt: `{n} 封` and 运行 `mailda setup` are right.
    expect(chinesePunctuation("zh-Hans", { a: "{n} 封邮件", b: "运行 `mailda setup`。" })).toEqual([]);
  });
});

describe("the glossary", () => {
  it("binds rows to keys that exist, so the checks below read something", () => {
    const bound = CONCEPTS.filter((concept) => governed(concept, WORLD.source).length > 0);
    // 19 when the scan landed: the brand, and a row per route name. It only grows as screens are migrated.
    expect(bound.length).toBeGreaterThanOrEqual(19);
    expect(new Set(CONCEPTS.map((concept) => concept.id)).size).toBe(CONCEPTS.length);
  });

  it("is used: every governed key says its concept's word in every locale, and avoids what the concept avoids", () => {
    expect(glossaryTerms(WORLD)).toEqual([]);
  });

  it("goes red on a wrong term, an avoided word, and a prose concept left out", () => {
    expect(glossaryTerms(planted({ "route./outbox": "已发送" }))).toEqual([
      'zh-Hans route./outbox: is "已发送", route.outbox says "发件箱"',
      "zh-Hans route./outbox: uses 已发送, which route.outbox avoids",
    ]);
    // "Mailda" is prose: the English names the brand, so the Chinese must say 淼达.
    expect(glossaryTerms(planted({ "language.unreadable": "此浏览器不允许读取已保存的语言。" })))
      .toEqual(["zh-Hans language.unreadable: names Mailda in English and not 淼达"]);
    // A sentence bound to a concept one key at a time must carry the term and none of its avoided words.
    expect(glossaryTerms(planted({ "inbox.released": "已退回队列。" }))).toEqual([
      "zh-Hans inbox.released: names Release in English and not 放回队列",
      "zh-Hans inbox.released: uses 退回, which case.release avoids",
    ]);
    // A backticked `mailda` is an identifier, not the brand.
    const identifier = planted({ "language.only": "运行 `mailda setup`。" }, { source: { "language.only": "Run `mailda setup`." } });
    expect(glossaryTerms(identifier)).toEqual([]);
  });

  it("scopes an avoided word to its concept: a term may contain one, and another concept may use it", () => {
    const refused: Concept = CONCEPTS.find((concept) => concept.id === "send.refused")!;
    const bound = { ...refused, keys: ["route./log"] } as unknown as Concept;
    const world = (text: string): World => ({ ...planted({ "route./log": text }, { source: { "route./log": "refused" } }), concepts: [bound] });
    expect(glossaryTerms(world("服务商拒收"))).toEqual([]);
    expect(glossaryTerms(world("拒收"))).toContain("zh-Hans route./log: uses 拒收, which send.refused avoids");
    // The same bare word on a key no refused-row governs is nobody's business here.
    expect(glossaryTerms({ ...world("服务商拒收"), locales: world("服务商拒收").locales.map((one) => ({ ...one, table: { ...one.table, "route./queue": "拒收" } })) })).toEqual([]);
  });

  it("holds the phrases no locale may use, except where a key says it negates one", () => {
    expect(neverPhrases(WORLD)).toEqual([]);
    expect(neverPhrases(planted({ "language.only": "发送成功。" }))).toEqual(["zh-Hans language.only: contains 发送成功"]);
    expect(neverPhrases(planted({ "language.only": "请联系秒达。" }))).toEqual(["zh-Hans language.only: contains 秒达"]);
    expect(neverPhrases({ ...planted({ "language.only": "这不代表发送成功。" }), negates: { "language.only": ["发送成功"] } })).toEqual([]);
  });

  it("lets only a preview ship a proposed word; a released locale needs the owner's confirmation", () => {
    expect(confirmedBeforeShipping(WORLD)).toEqual([]);
    const released = (concepts: readonly Concept[]): World => ({ ...planted({}, { preview: false }), concepts });
    // Rounds one to four confirmed every row there is, so released today zh-Hans would ship no proposed word: the
    // glossary no longer holds the preview on.
    expect(confirmedBeforeShipping(released(CONCEPTS))).toEqual([]);
    // Put back to proposed, a row is reported on every key it governs, so the empty list above is the check finding
    // nothing, not a check that cannot find anything.
    const back = (id: string) => CONCEPTS.map((concept) => (concept.id === id ? { ...concept, status: "proposed" as const } : concept));
    // Round four's rows govern keys too: `evidence` its six sentences, `claim-secret` the claim's field since H1.
    expect(confirmedBeforeShipping(released(back("evidence")))).toEqual([
      "doctor.check.evidence_bucket_reachable", "doctor.check.evidence_orphans", "doctor.check.evidence_present",
      "doctor.check.evidence_key_generation", "doctor.check.send_evidence_changed", "send.reason.evidence_changed",
    ].map((key) => `zh-Hans ${key}: evidence is proposed, not confirmed`));
    expect(confirmedBeforeShipping(released(back("claim-secret")))).toEqual(["zh-Hans preauth.claim.secret: claim-secret is proposed, not confirmed"]);
    expect(confirmedBeforeShipping(released(back("butler-run.stopped")))).toEqual(["zh-Hans butlers.run.stopped: butler-run.stopped is proposed, not confirmed"]);
    expect(confirmedBeforeShipping(released(back("breaker")))).toEqual([
      "zh-Hans limits.col.breaker: breaker is proposed, not confirmed",
      "zh-Hans limits.breakers: breaker is proposed, not confirmed",
    ]);
    expect(confirmedBeforeShipping(released(back("recall")))).toEqual([
      "zh-Hans composer.sendNote: recall is proposed, not confirmed",
      "zh-Hans composer.how.body: recall is proposed, not confirmed",
    ]);
    expect(confirmedBeforeShipping(released(back("passkey")))).toEqual([
      "api.passkey.unsupported", "api.passkey.none", "preauth.signin.passkey", "preauth.passkey.waiting", "preauth.passkey.unsupported",
      "preauth.passkey.failed", "preauth.refusal.E_PASSKEY_REJECTED",
    ].map((key) => `zh-Hans ${key}: passkey is proposed, not confirmed`));
    // A row put back to proposed is reported on every key it governs, its own and a prose concept's alike.
    const unconfirmed = back("brand");
    expect(confirmedBeforeShipping(released(unconfirmed))).toContain("zh-Hans brand.name: brand is proposed, not confirmed");
    expect(confirmedBeforeShipping(released(unconfirmed))).toContain("zh-Hans language.unreadable: brand is proposed, not confirmed");
    // Confirmed rows ship.
    const confirmed = CONCEPTS.map((concept) => ({ ...concept, status: { confirmedBy: "owner", record: "a PR review" } }));
    expect(confirmedBeforeShipping(released(confirmed))).toEqual([]);
  });

  it("records the owner's review against rows that exist, and leaves no row proposed", () => {
    const ids = new Set(CONCEPTS.map((concept) => concept.id));
    expect([...CONFIRMED].filter((id) => !ids.has(id))).toEqual([]);
    // Every row is confirmed. A confirmed row put back to proposed, or a new row added, is an edit here.
    expect(CONCEPTS.filter((concept) => concept.status === "proposed").map((concept) => concept.id)).toEqual([]);
    // Each round's rows carry that round's record, not another's.
    const recorded = (round: string) => CONCEPTS
      .filter((concept) => typeof concept.status === "object" && concept.status.record.includes(round)).map((concept) => concept.id);
    expect(recorded("round two")).toEqual(["send.denied", "recall", "vault"]);
    expect(recorded("round three")).toEqual(ROUND_THREE);
    // Round four had no review page, and its record says so rather than linking one.
    expect(recorded("round four")).toEqual(ROUND_FOUR);
    const fourth = CONCEPTS.find((concept) => concept.id === "evidence")!.status;
    expect(typeof fourth === "object" ? fourth.record : fourth).toContain("in the working session on 2 October 2026, without a review page");
  });
});

/**
 * F5 (the owner's review of 1 October 2026): a measure word belongs to its noun (份草稿, 条通知, 封…来信), so
 * `chrome.truncated` carries none and every noun passed to it brings its own. The list is the callers of
 * `Truncated` today, `limits.tsx`'s noun among them since layer 2b. The template is a plural on the count shown.
 */
describe("the truncation notice in zh-Hans", () => {
  const zh = whole("zh-Hans");
  const NOUNS = ["chrome.notices.noun", "drafts.noun", "ledgers.noun.entries", "ledgers.outbox.noun", "queue.held.noun", "limits.suppressed.noun"] as const;

  it("leaves the measure word to the noun", () => {
    expect(zh["chrome.truncated"]).toEqual({ other: expect.stringMatching(/\{n\} \{noun\}/) });
    for (const key of NOUNS) expect(String(zh[key]), key).toMatch(/^[份条封个项]/u);
    expect(NOUNS.map((key) => String(zh[key])[0])).toEqual(["条", "份", "条", "条", "封", "个"]);
  });
});
