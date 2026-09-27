import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerMailboxes, answerWith, reset, seen } from "./session-stub.ts";

/** happy-dom's own control of the window it simulates; its default 1024px viewport is the narrow layout. */
type HappyDom = { happyDOM: { setViewport(size: { width: number; height: number }): void } };

/**
 * The sending mailbox is chosen, never inferred (#94), now that Compose lives in the sidebar.
 *
 * ## Why this renders rather than testing a function
 *
 * The defect was `from ?? rows[0]!.id` — trivial to see, and not where the property lives. What has to be
 * true is that **a person cannot start a message without having picked an address**, and that is a claim
 * about a disabled control and what a click handler is given. Extracting a three-line `chosenMailbox` would
 * test the `??` and leave the part that matters — the button — unexercised, which is how the original bug
 * survived a comment stating the opposite nine lines above it.
 *
 * The control moved from the Inbox heading to the sidebar's Compose and a chooser dialog the shell owns, and
 * the property moved with it unchanged: with more than one mailbox the choice starts empty and "Start
 * message" stays disabled until somebody makes it.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Rail, Shell } = await import("../../src/client/app/chrome.tsx");
const { ShellProvider, useCompose } = await import("../../src/client/app/shell-context.tsx");

/** What the shell's one composer was opened on: the fact a click handler was handed, read directly. */
function Composing() {
  const { composing } = useCompose();
  return <output data-testid="composing">{composing?.mailboxId ?? ""}</output>;
}

function mount(node: React.ReactElement = <Rail />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider>{node}<Composing /></ShellProvider></QueryClientProvider>);
}

const compose = () => screen.findByRole("button", { name: "Compose" });
const startButton = () => screen.getByRole("button", { name: "Start message" }) as HTMLButtonElement;
const selector = () => document.getElementById("compose-from") as HTMLSelectElement | null;

async function choose(mailboxId: string) {
  const select = selector()!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, mailboxId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  reset();
  // The wide layout, where the sidebar holds the one Compose (happy-dom's default 1024px is the narrow one).
  (window as unknown as HappyDom).happyDOM.setViewport({ width: 1440, height: 900 });
});

describe("with more than one mailbox, nothing is chosen until somebody chooses", () => {
  beforeEach(() => {
    answerMailboxes([
      { id: "mbx_support", name: "Support", addresses: "support@example.test" },
      { id: "mbx_billing", name: "Billing", addresses: "billing@example.test" },
    ]);
  });

  it("opens a chooser with no mailbox selected and the control disabled", async () => {
    /*
     * The whole of #94. The old code pre-selected `rows[0]`, so the button was live from first paint and
     * pressing it sent from whichever mailbox the query happened to return first — an order that is not
     * even stable. Sending from the wrong role address is a governance and reputational error, so the
     * absence of a choice has to be visible rather than filled in.
     */
    mount();
    const button = await compose();
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(button);

    expect(screen.getByRole("dialog", { name: "Choose a mailbox" })).toBeTruthy();
    expect(selector()!.value, "a mailbox was pre-selected").toBe("");
    expect(startButton().disabled, "Start message was live with no mailbox chosen").toBe(true);
  });

  it("offers a placeholder that is not one of the mailboxes", async () => {
    /*
     * A `<select>` whose value matches no option displays its first option regardless, so "no selection"
     * has to be a real option or the original bug returns wearing a different implementation.
     */
    mount();
    fireEvent.click(await compose());
    expect([...selector()!.options].map((option) => option.value)).toEqual(["", "mbx_support", "mbx_billing"]);
  });

  it("enables the control once a mailbox is chosen, and opens the composer on that one", async () => {
    mount();
    fireEvent.click(await compose());
    await choose("mbx_billing");

    expect(startButton().disabled).toBe(false);
    await act(async () => { startButton().click(); });

    // The composer's own region, and the mailbox it will send from — the second is the assertion that
    // matters, since the first would pass whichever mailbox had been picked.
    expect(await screen.findByRole("region", { name: "New message" })).toBeTruthy();
    expect(screen.getByTestId("composing").textContent).toBe("mbx_billing");
    expect(screen.queryByRole("dialog", { name: "Choose a mailbox" }), "the chooser outlived its choice").toBeNull();
  });

  it("goes back to nothing chosen if the placeholder is re-selected", async () => {
    mount();
    fireEvent.click(await compose());
    await choose("mbx_support");
    expect(startButton().disabled).toBe(false);

    await choose("");
    expect(startButton().disabled, "un-choosing left the control live").toBe(true);
  });

  it("gives focus back to Compose on Escape, and to Compose again when the composer it started closes", async () => {
    mount();
    const button = await compose();
    button.focus();
    fireEvent.click(button);
    fireEvent(screen.getByRole("dialog", { name: "Choose a mailbox" }), new Event("cancel"));
    // The chooser is modal until it is closed; focus returned before that is refused, as a browser refuses it.
    expect(document.activeElement, "Escape left focus on <body>").toBe(button);

    fireEvent.click(button);
    await choose("mbx_billing");
    await act(async () => { startButton().click(); });
    const dock = await screen.findByRole("region", { name: "New message" });
    await act(async () => { fireEvent.click(within(dock).getByRole("button", { name: "Close" })); });
    expect(document.activeElement, "closing the composer left focus on <body>").toBe(button);
  });

  it("closes on Escape and opens again, so the chooser and React never disagree", async () => {
    mount();
    fireEvent.click(await compose());
    // happy-dom does not turn Escape into the dialog's `cancel`; a browser does, so the test fires that.
    fireEvent(screen.getByRole("dialog", { name: "Choose a mailbox" }), new Event("cancel"));
    expect(screen.queryByRole("dialog", { name: "Choose a mailbox" })).toBeNull();
    fireEvent.click(await compose());
    expect(screen.getByRole("dialog", { name: "Choose a mailbox" })).toBeTruthy();
  });
});

describe("with exactly one mailbox there is no choice to make", () => {
  it("opens the composer on it, with no chooser", async () => {
    /*
     * Not a contradiction of the above: one option is not a decision, and asking for it would be ceremony
     * on the commonest Node there is. Where there are no alternatives there is no default.
     */
    answerMailboxes([{ id: "mbx_only", name: "Support", addresses: "support@example.test" }]);
    mount();
    const button = await compose();
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(button);

    expect(await screen.findByRole("region", { name: "New message" })).toBeTruthy();
    expect(screen.getByTestId("composing").textContent).toBe("mbx_only");
    expect(screen.queryByRole("dialog", { name: "Choose a mailbox" })).toBeNull();
  });
});

describe("with no mailbox Compose is absent, not disabled", () => {
  it("renders no button, and C says which authority sending needs", async () => {
    // A button that can only fail is worse than no button; the key that would have pressed it says why.
    answerMailboxes([]);
    // A member's answer: the setup band has nothing to say, so the shell renders without it.
    answerWith((call) => (call.path === "/api/provider"
      ? Response.json({ error: "not_found", message: "not yours" }, { status: 404 })
      : undefined));
    mount(<Shell />);
    // The positive first: the sidebar rendered its rows, so the absence below is not a screen still loading.
    await screen.findByText("Inbox");
    await waitFor(() => { expect(screen.queryByRole("button", { name: "Compose" })).toBeNull(); });

    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() => {
      expect(document.querySelector(".toast-region [role=status]")?.textContent)
        .toContain("Sending needs send.propose on a mailbox, and you hold it on none.");
    });
  });
});

describe("C while the mailbox list could not be read", () => {
  it("says the Node's words, rather than claiming this person may send from none", async () => {
    answerWith((call) => {
      if (call.path === "/api/provider") return Response.json({ error: "not_found", message: "not yours" }, { status: 404 });
      if (call.path.startsWith("/api/mailboxes")) {
        return Response.json({ error: "E_CATALOG", message: "The catalog did not answer." }, { status: 503 });
      }
      return undefined;
    });
    mount(<Shell />);
    await screen.findByText("Inbox");
    await waitFor(() => { expect(seen("/api/mailboxes").length).toBeGreaterThan(0); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() => {
      expect(document.querySelector(".toast-region [role=alert]")?.textContent).toContain("The catalog did not answer.");
    });
    expect(document.querySelector(".toast-region")?.textContent).not.toContain("you hold it on none");
  });
});
