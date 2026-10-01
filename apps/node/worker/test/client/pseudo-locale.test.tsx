import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { install, t } from "/app/locale.js";
import type { AppRoute } from "../../src/app-routes.ts";
import { APP_ROUTES } from "../../src/app-routes.ts";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { LOCALES } from "../../src/i18n/locales.ts";
import { PREAUTH } from "../../src/i18n/preauth.ts";
import { messagePaths, servedTables } from "../../src/i18n/served.ts";
import { PSEUDO_TAG, english, notProse, pseudoTable, untranslated, type Allowance } from "./pseudo-locale.ts";
import { FIXTURES, LATIN_DATA, NODE_SAYS } from "./pseudo-node.ts";
import { answerWith, reset, type Call } from "./session-stub.ts";

type HappyDom = { happyDOM: { setViewport(size: { width: number; height: number }): void } };

/**
 * T4: every route of the interface, rendered in the pseudo-locale, shows no English of its own (ADR 46,
 * `docs/i18n.md`, the condition for taking a locale out of preview).
 *
 * The pseudo table (`pseudo-locale.ts`) accents every letter of every catalog message, so a word that came from
 * the catalog has no ASCII letter in it. The fixture Node (`pseudo-node.ts`) writes its data in Greek (names,
 * subjects, addresses), and its own sentences and wire tokens in English, as the real Node does. So an ASCII
 * letter on screen is one of three things: the Node's English inside `lang="en"` (allowed, that is `<NodeWords>`),
 * an identifier in `<code>`, `<kbd>` or `<samp>` (allowed), or a word nobody translated (the failure).
 *
 * **The pseudo table is installed in zh-Hans's slot**, with zh-Hans formatting, and the root then says `en-XA`.
 * `install()` takes only a listed locale, and the pseudo-locale is never listed. A non-source slot is also what
 * makes this a real check: `<NodeWords>` marks the Node's English only when the locale is not `en`, and an `en`
 * format locale writes `Sep` and `PM`, which are English the interface did not choose to translate but `Intl` did.
 * The cost: plurals select by zh's rules, so only each plural's `other` is shown.
 *
 * Each route is rendered in the whole shell (rail, bands, status bar, title), under the first-run gate, in
 * four Node states: populated, empty, every read failed with the Node's words, and every read failed with no
 * words (this interface's own sentence). Then, populated again, every act is refused and each button the screen
 * offers is pressed once, so the refusals, confirmations and forms that only a press reveals are read too.
 * Text the interface writes on purpose that is not words is T3's `NOT_PROSE`, read from its registry.
 *
 * **Where the gate holds a route, its two sources answer even when every other read fails.** With the doctor
 * failed the gate shows the first-run screen in place of the route, which has its own test here. With the
 * connection state (`GET /api/provider`) failed it does worse: the gate renders the shell, the shell's own read
 * of the same query refetches it on mount, the query goes back to pending with no data, the gate shows loading
 * and unmounts the shell, the read fails again, and round it goes, once a second under the app's `retry: 1`.
 * That is a defect of `Gate` (`src/client/app/screens/first-run.tsx`), not a failure state to read words in.
 */

const route = vi.hoisted(() => ({ pathname: "/" as string, outlet: null as React.ReactNode }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Shell, tabsOf } = await import("../../src/client/app/chrome.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const { DocumentTitle } = await import("../../src/client/app/title.ts");
const { Gate } = await import("../../src/client/app/screens/first-run.tsx");
const { SectionTabs } = await import("../../src/client/app/ui/section-tabs.tsx");
const { Drafts } = await import("../../src/client/app/screens/drafts.tsx");
const { Settings } = await import("../../src/client/app/screens/settings.tsx");
const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { Queue } = await import("../../src/client/app/screens/queue.tsx");
const { Agents } = await import("../../src/client/app/screens/agents.tsx");
const { Butlers } = await import("../../src/client/app/screens/butlers.tsx");
const { Approvals } = await import("../../src/client/app/screens/approvals.tsx");
const { Policies } = await import("../../src/client/app/screens/policies.tsx");
const { People } = await import("../../src/client/app/screens/people.tsx");
const { Limits } = await import("../../src/client/app/screens/limits.tsx");
const { Matters } = await import("../../src/client/app/screens/matters.tsx");
const { Audit, Doctor, Log, Outbox } = await import("../../src/client/app/screens/ledgers.tsx");
const { Setup } = await import("../../src/client/app/screens/setup.tsx");

/** `main.tsx`'s Automations: Butlers and Rules as two tabs of one row. */
const Automations = () => <SectionTabs label={t("chrome.row.automations")} tabs={tabsOf("/butlers")} />;

/**
 * Every route's screen, as `SCREENS` in `src/client/app/main.tsx` mounts it. `Record<AppRoute, …>`, so a route
 * added to `APP_ROUTES` without a line here does not compile, and this check cannot pass over it.
 */
const SCREENS: Record<AppRoute, () => React.ReactElement> = {
  "/": () => <Inbox />,
  "/queue": () => <Queue />,
  "/approvals": () => <Approvals />,
  "/rules": () => <><Automations /><Policies /></>,
  "/people": () => <People />,
  "/matters": () => <Matters />,
  "/butlers": () => <><Automations /><Butlers /></>,
  "/agents": () => <Agents />,
  "/limits": () => <Limits />,
  "/outbox": () => <Outbox />,
  "/audit": () => <Audit />,
  "/log": () => <Log />,
  "/doctor": () => <Doctor />,
  "/setup": () => <Setup />,
  "/drafts": () => <Drafts />,
  "/archive": () => <Inbox place="archive" />,
  "/trash": () => <Inbox place="trash" />,
  "/settings": () => <Settings />,
};

/* ------------------------------------------------------------------------------------------- the scan --- */

/**
 * What the React screens write on purpose that is not words: their `NOT_PROSE` entries (T3's registry, each with
 * its reason: an example domain in a placeholder, a CLI command, Cloudflare's name for a permission). And the Latin
 * data the fixtures cannot avoid (a link's scheme), with this page's own host.
 */
const ALLOWANCE: Allowance = { notWords: notProse((file) => file.startsWith("src/client/app/")), latin: [...LATIN_DATA, location.host] };

function scan(): string[] {
  const hits = untranslated(document.body, ALLOWANCE);
  if (english(document.title, ALLOWANCE)) hits.push(`<title>: ${JSON.stringify(document.title)}`);
  return hits;
}

/* ------------------------------------------------------------------------------------------- the Node --- */

type Mode = "populated" | "empty" | "first-run" | "failed" | "failed-bare" | "refused";

/** GETs the fixtures did not answer: a screen that failed for want of a fixture would pass for the wrong reason. */
const unanswered = new Set<string>();

/**
 * Whether the shell's notices band has notices. Off for the routes, because the band is the same on every route and
 * one sentence in it would fail all of them alike; its own test reads it once.
 */
let notices = false;

function node(mode: Mode, path: AppRoute) {
  // Setup is read connected, so its token-spending sections render; every other screen past the first-run gate.
  const fixtures: Record<string, unknown> = {
    ...FIXTURES(mode === "empty" || mode === "first-run" ? mode : "populated", path === "/setup"),
    ...(notices ? {} : { "GET /api/notifications": { notifications: [], truncated: false } }),
  };
  answerWith((call: Call) => {
    const url = new URL(call.path, "https://node.example");
    const asked = decodeURIComponent(url.pathname);
    if (call.method !== "GET") {
      return Response.json({ error: "E_REFUSED_FOR_TEST", message: NODE_SAYS.refused }, { status: 409 });
    }
    // The first-run gate's two sources answer even here, where the gate holds the route: with either failed it
    // shows the first-run screen (doctor) or remounts the shell on every refetch (the connection; see the header),
    // and the screen's own failures would go unread. `/setup`, `/doctor` and `/settings` pass the gate, so there
    // they fail like everything else.
    const gated = path !== "/setup" && path !== "/doctor" && path !== "/settings";
    if (gated && (asked === "/api/provider" || asked === "/api/doctor") && (mode === "failed" || mode === "failed-bare")) {
      return Response.json(fixtures[`GET ${asked}`]);
    }
    if (mode === "failed") return Response.json({ error: "E_UNAVAILABLE_FOR_TEST", message: NODE_SAYS.failed }, { status: 503 });
    if (mode === "failed-bare") return new Response("", { status: 503 });
    const fixture = fixtures[`GET ${asked}`];
    if (fixture === undefined) {
      unanswered.add(`GET ${asked}`);
      return Response.json({ error: "E_NO_FIXTURE", message: "No fixture." }, { status: 404 });
    }
    return Response.json(typeof fixture === "function" ? (fixture as (url: URL) => unknown)(url) : fixture);
  });
}

let client: QueryClient;

/** The routes with nothing to refuse: the Log only reads. Held both ways, so an act added to one is pressed. */
const NO_ACTS: ReadonlySet<AppRoute> = new Set(["/log"]);

/** How many buttons one route's refusal pass presses at most. A presentation bound on this test, not a product limit. */
const PRESSES = 150;

/**
 * Until nothing has been in flight for three turns of the event loop: a failed read re-renders its screen a turn
 * after it settles, and that render may start the next read.
 */
async function settled(): Promise<void> {
  for (let quiet = 0, turns = 0; quiet < 3; turns += 1) {
    if (turns > 200) throw new Error("the screen never settled: a read or an act is still in flight");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    quiet = client.isFetching() + client.isMutating() === 0 ? quiet + 1 : 0;
  }
}

async function mount(path: AppRoute, mode: Mode): Promise<HTMLElement> {
  reset();
  node(mode, path);
  route.pathname = path;
  route.outlet = SCREENS[path]();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <ShellProvider><DocumentTitle /><Gate><Shell /></Gate></ShellProvider>
    </QueryClientProvider>,
  );
  await settled();
  return container;
}

beforeAll(() => {
  (window as unknown as HappyDom).happyDOM.setViewport({ width: 1400, height: 900 });
  install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, pseudoTable());
  document.documentElement.lang = PSEUDO_TAG;
});
afterAll(() => {
  install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
});
beforeEach(() => {
  unanswered.clear();
  notices = false;
});

/** The Node's words on the page, inside `lang="en"`: the witness that a failure or a refusal was read and shown. */
const nodeSaid = (words: string): boolean =>
  [...document.body.querySelectorAll("[lang=en]")].some((element) => element.textContent?.includes(words) === true);

describe("the pseudo-locale is a test instrument, never shipped", () => {
  it("is not a listed locale, has no catalog, no pre-sign-in table and no served table", () => {
    expect(LOCALES.map((entry) => entry.tag)).not.toContain(PSEUDO_TAG);
    expect(Object.keys(CATALOGS)).not.toContain(PSEUDO_TAG);
    expect(Object.keys(PREAUTH)).not.toContain(PSEUDO_TAG);
    expect(Object.keys(messagePaths())).not.toContain(PSEUDO_TAG);
    expect([...servedTables().keys()].filter((path) => path.includes(PSEUDO_TAG))).toEqual([]);
  });

  it("leaves no ASCII letter in any message outside its placeholders", () => {
    const leaks = Object.entries(pseudoTable()).flatMap(([key, message]) =>
      (typeof message === "string" ? [message] : Object.values(message)).filter((text) => /[A-Za-z]/.test(text!.replace(/\{\w+\}/g, ""))).map(() => key));
    expect(leaks).toEqual([]);
  });
});

describe("every route in the pseudo-locale shows no English outside lang=en, code, kbd and samp", () => {
  for (const path of APP_ROUTES) {
    for (const mode of ["populated", "empty", "failed", "failed-bare"] as const) {
      it(`${path}, ${mode}`, async () => {
        const container = await mount(path, mode);
        expect(container.querySelector(".app-shell"), "the shell did not render, so this read nothing").not.toBeNull();
        expect(document.body.textContent, "no catalog word rendered, so the pseudo table is not what this read").toContain("⟦");
        expect([...unanswered], "a read had no fixture, so its screen failed for the wrong reason").toEqual([]);
        expect(document.body.textContent, "a screen was still reading when it was read").not.toContain(t("chrome.nothing.loading"));
        expect(scan()).toEqual([]);
      });
    }
  }

  for (const path of APP_ROUTES) {
    it(`${path}, every button pressed against a Node that refuses every act`, async () => {
      const hits = new Set<string>();
      let refusals = 0;
      const pressable = () => [...document.body.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const press = async (button: HTMLButtonElement) => {
        await act(async () => { button.click(); });
        await settled();
        if (nodeSaid(NODE_SAYS.refused)) refusals += 1;
        for (const hit of scan()) hits.add(hit);
      };
      // Each button the screen offers, on a fresh mount, so one press cannot hide the next (a filter that empties
      // the list, a popover over the rows). Then every button that press brought (a confirmation, a dialog's
      // submit, the composer's), once each, so an act two presses deep is refused and read too.
      for (let index = 0; ; index += 1) {
        cleanup();
        await mount(path, "refused");
        if (index === 0) for (const hit of scan()) hits.add(hit);
        const before = pressable();
        const first = before[index];
        if (first === undefined) break;
        await press(first);
        // By what a button says rather than which element it is: a confirmation that goes back puts a new element
        // with the old words in its place, and pressing that again would go round for ever.
        const said = (button: Element) => `${button.textContent} ${button.getAttribute("aria-label")}`;
        const done = new Set(before.map(said));
        for (let more = 0; more < PRESSES; more += 1) {
          const next = pressable().find((button) => !done.has(said(button)));
          if (next === undefined) break;
          done.add(said(next));
          await press(next);
          expect(more, "a press kept adding buttons, so some were never pressed").toBeLessThan(PRESSES - 1);
        }
      }
      expect([...unanswered], "a read had no fixture, so its screen failed for the wrong reason").toEqual([]);
      expect([...hits]).toEqual([]);
      if (NO_ACTS.has(path)) expect(refusals, `${path} has an act now; take it out of NO_ACTS`).toBe(0);
      else expect(refusals, "no press reached a refusal shown in the Node's words, so none was read").toBeGreaterThan(0);
    });
  }

  it("the shell's notices band, which is the same on every route", async () => {
    notices = true;
    const container = await mount("/queue", "populated");
    expect(container.querySelector("section.notices"), "no notice rendered, so this read nothing").not.toBeNull();
    expect(scan()).toEqual([]);
  });

  it("the first-run screen, which stands in for every gated route until mail is routed", async () => {
    const container = await mount("/", "first-run");
    expect(container.querySelector(".first-run h1"), "the gate did not hold, so this read the inbox again").not.toBeNull();
    expect([...unanswered]).toEqual([]);
    expect(scan()).toEqual([]);
  });
});
