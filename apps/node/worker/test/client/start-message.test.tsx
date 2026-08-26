import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerMailboxes, reset } from "./session-stub.ts";

/**
 * The sending mailbox is chosen, never inferred (#94).
 *
 * ## Why this renders rather than testing a function
 *
 * The defect was `from ?? rows[0]!.id` — trivial to see, and not where the property lives. What has to be
 * true is that **a person cannot start a message without having picked an address**, and that is a claim
 * about a disabled control and what a click handler is given. Extracting a three-line `chosenMailbox` would
 * test the `??` and leave the part that matters — the button — unexercised, which is how the original bug
 * survived a comment stating the opposite nine lines above it.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
}

/**
 * Waits for the mailbox query to land.
 *
 * `waitFor` rather than a couple of microtask ticks: React Query resolves the fetch, sets state and
 * re-renders across several turns, and a fixed number of ticks is a race that passes on a fast machine and
 * fails on a loaded one. The first version of this file hand-rolled two `Promise.resolve()`s and found
 * `StartMessage` rendering `null`, because at that point the component genuinely had no mailboxes yet.
 */
async function settle() {
  await waitFor(() => { expect(screen.getByRole("heading", { level: 1 })).toBeTruthy(); });
  await act(async () => { await Promise.resolve(); });
}

/**
 * Waits until the *messages* query has resolved and the empty state is on screen.
 *
 * Deliberately not `settle()`. The heading renders in **every** branch of `Inbox`, including
 * `messages.isPending`, so waiting for the `h1` proves only that React mounted — the first version of the
 * two tests below did exactly that and asserted against a screen still reading "Reading…". One of them
 * failed honestly; the other was a `queryByText(...).toBeNull()` and passed **vacuously**, because the text
 * it was looking for cannot be present on a loading screen either. Waiting for the notice itself is what
 * makes both of them about the empty state.
 */
async function untilEmpty() {
  return await screen.findByText(/No messages are visible to you yet/);
}

/** Waits until the mailbox-dependent control exists, for the tests that need one. */
async function untilStartable() {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /new message/i })).toBeTruthy();
  });
}

const startButton = () => screen.getByRole("button", { name: /new message/i }) as HTMLButtonElement;
const selector = () => document.getElementById("new-message-from") as HTMLSelectElement | null;

async function choose(mailboxId: string) {
  const select = selector()!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, "value",
    )!.set!;
    setter.call(select, mailboxId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => { reset(); });

describe("with more than one mailbox, nothing is chosen until somebody chooses", () => {
  beforeEach(() => {
    answerMailboxes([
      { id: "mbx_support", name: "Support", addresses: "support@example.test" },
      { id: "mbx_billing", name: "Billing", addresses: "billing@example.test" },
    ]);
  });

  it("starts with no mailbox selected and the control disabled", async () => {
    /*
     * The whole of #94. The old code pre-selected `rows[0]`, so this button was live from first paint and
     * pressing it sent from whichever mailbox the query happened to return first — an order that is not
     * even stable. Sending from the wrong role address is a governance and reputational error, so the
     * absence of a choice has to be visible rather than filled in.
     */
    mount();
    await untilStartable();

    expect(selector()!.value, "a mailbox was pre-selected").toBe("");
    expect(startButton().disabled, "new message was live with no mailbox chosen").toBe(true);
  });

  it("offers a placeholder that is not one of the mailboxes", async () => {
    /*
     * A `<select>` whose value matches no option displays its first option regardless, so "no selection"
     * has to be a real option or the original bug returns wearing a different implementation — the screen
     * showing Support while the state says nothing is chosen.
     */
    mount();
    await untilStartable();

    const options = [...selector()!.options].map((option) => option.value);
    expect(options[0]).toBe("");
    expect(options).toEqual(["", "mbx_support", "mbx_billing"]);
  });

  it("enables the control once a mailbox is chosen, and opens the composer on that one", async () => {
    mount();
    await untilStartable();
    await choose("mbx_billing");

    expect(startButton().disabled).toBe(false);
    await act(async () => { startButton().click(); });
    await settle();

    // The composer's own heading, and the address it will send as — the second is the assertion that
    // matters, since the first would pass whichever mailbox had been picked.
    expect(screen.getByRole("region", { name: /new message/i })).toBeTruthy();
    expect(screen.getByText(/billing@example\.test/)).toBeTruthy();
  });

  it("goes back to nothing chosen if the placeholder is re-selected", async () => {
    mount();
    await untilStartable();
    await choose("mbx_support");
    expect(startButton().disabled).toBe(false);

    await choose("");
    expect(startButton().disabled, "un-choosing left the control live").toBe(true);
  });
});

describe("with exactly one mailbox there is no choice to make", () => {
  it("uses it, and renders no selector", async () => {
    /*
     * Not a contradiction of the above: one option is not a decision, and asking for it would be ceremony
     * on the commonest Node there is. The rule is that a *default among alternatives* is never invisible —
     * where there are no alternatives there is no default.
     */
    answerMailboxes([{ id: "mbx_only", name: "Support", addresses: "support@example.test" }]);
    mount();
    await untilStartable();

    expect(selector(), "a selector was rendered for a single mailbox").toBeNull();
    expect(startButton().disabled).toBe(false);
  });
});

describe("with no mailbox the control is absent, not disabled", () => {
  it("renders nothing at all", async () => {
    // A button that can only fail is worse than no button, and this screen already took that position.
    answerMailboxes([]);
    mount();
    await settle();

    expect(screen.queryByRole("button", { name: /new message/i })).toBeNull();
  });
});

describe("the empty inbox does not claim routing is live (#101)", () => {
  it("says what an empty list means, and points at what can answer the rest", async () => {
    /*
     * The old copy read "This Node is claimed and routing is live", concluded from an empty result set.
     * Routing never enabled, MX pointing elsewhere, a catch-all aimed at another Worker and no address at
     * all all produce this same screen — so the sentence told a reader with broken routing that it worked.
     */
    answerMailboxes([{ id: "mbx_only", name: "Support", addresses: "support@example.test" }]);
    mount();
    await untilEmpty();

    expect(screen.queryByText(/routing is live/i), "the unverified claim is still here").toBeNull();
    expect(screen.getByText(/inbound routing/i)).toBeTruthy();
  });

  it("does not tell the reader nothing has been hidden from them", async () => {
    /*
     * The shared `Nothing` component appended that to every empty state. Authorization here happens inside
     * the SQL (ADR 11, §5), so an empty inbox routinely means "nothing you may see" — and this is the one
     * screen where that reassurance is most likely to be read and most certainly false.
     */
    answerMailboxes([{ id: "mbx_only", name: "Support", addresses: "support@example.test" }]);
    mount();
    // The empty state must actually be on screen, or this assertion is true of a loading spinner too.
    await untilEmpty();

    expect(screen.queryByText(/nothing has been hidden from you/i)).toBeNull();
  });
});
