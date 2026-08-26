import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerMailboxes, answerWith, reset } from "./session-stub.ts";

/**
 * The rail's Inbox count says what it is (#91).
 *
 * ## The number was always a page size
 *
 * `messages.data.messages.length` is the length of **one page**. That was true before paging too — the
 * listing was capped at fifty from the day it shipped — so the rail has been printing a page size in the
 * position a reader reads as a total, and nothing said so. The commit that added paging renamed the inbox
 * heading to `{n} shown` for exactly this reason and left the rail as a bare figure: two numbers off one
 * query, one of them honest.
 *
 * `next_cursor` already answers whether more exists, so `+` costs nothing. A real total would need a second
 * authorization-scoped `COUNT`, and it is not worth a query to turn `50+` into `4,213`.
 *
 * ## Why the rail had no test at all before this
 *
 * Nothing rendered it. `chrome.tsx` holds the rail, the instrument bar and `Nothing`, and the client suite
 * reached only the last of those through the screens that use it. A component nobody mounts is where the
 * page-size-as-total went unnoticed, in the same way #90, #94, #100 and #101 all sat in the one layer with
 * no tests.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Rail } = await import("../../src/client/app/chrome.tsx");

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Rail /></QueryClientProvider>);
}

/** The Inbox row's figure, whatever it currently says. */
async function inboxCount(): Promise<string> {
  await screen.findByText("Inbox");
  /*
   * Scoped to the Inbox row, not to the first `.num` in the rail. `Link` is mocked to render its children
   * bare, so the label and the figure are siblings inside the `<li>` with no wrapper to hang off — and the
   * first version selected `.rail-list .num`, which picked up whichever other row happened to render a
   * figure first and read `0` off it. A selector that can match a different row is a test that can pass for
   * the wrong reason.
   */
  const row = [...document.querySelectorAll(".rail-list > li")]
    .find((item) => item.querySelector(".rail-name")?.textContent === "Inbox");
  return row?.querySelector(".num")?.textContent?.trim() ?? "";
}

function page(count: number, more: boolean) {
  answerWith((call) => {
    if (!call.path.startsWith("/api/messages")) return undefined;
    return Response.json({
      messages: Array.from({ length: count }, (_unused, n) => ({ id: `rcpt_${n}`, parse_error: null })),
      next_cursor: more ? "2026-08-20T09:00:00.000Z rcpt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ" : null,
    });
  });
}

beforeEach(() => {
  reset();
  answerMailboxes([]);
});

describe("the Inbox count does not present a page as a total", () => {
  it("marks it with + when older mail exists", async () => {
    page(50, true);
    mount();
    await waitFor(async () => { expect(await inboxCount()).toBe("50+"); });
  });

  it("prints the plain figure when nothing older is visible", async () => {
    /*
     * The other side, and it is what stops the `+` becoming decoration: when `next_cursor` is null the
     * number *is* everything this reader may see, and appending `+` would then be its own small lie.
     */
    page(3, false);
    mount();
    await waitFor(async () => { expect(await inboxCount()).toBe("3"); });
  });

  it("renders no figure at all while the answer is unknown", async () => {
    /*
     * A zero rendered during loading is a claim about an empty inbox, which is the §5C distinction between
     * "empty" and "not yet answered" — the rail already took this position and it is asserted here because
     * the `+` change edited the same expression.
     */
    answerWith((call) => (call.path.startsWith("/api/messages") ? new Promise(() => {}) : undefined));
    mount();
    await screen.findByText("Inbox");
    expect(await inboxCount()).toBe("");
  });
});
