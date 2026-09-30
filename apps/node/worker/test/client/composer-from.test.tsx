import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerMailboxes, answerWith, reset } from "./session-stub.ts";

/**
 * The composer always says what it sends as (28 September 2026, Blueprint §4B.3: sender identity remains
 * visible). With one address it showed no From at all, so somebody who claimed the Node as `admin@` replied
 * for days as the mailbox's `hello@` without the screen ever saying so. What would render plausibly and be
 * wrong: a From line that disappears at one address, a choice made for the person at several (#94), and a
 * mailbox with no address shown as if it had one.
 */

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { Composer } = await import("../../src/client/app/screens/composer.tsx");

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Composer context={{ mailboxId: "mbx_test" }} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return screen.getByRole("region", { name: "New message" });
}

describe("the composer's From", () => {
  beforeEach(reset);

  it("shows the one address and the mailbox it belongs to, with no choice to make", async () => {
    answerMailboxes([{ id: "mbx_test", name: "Support", addresses: "support@example.test" }]);
    const dock = mount();
    const from = await within(dock).findByText("support@example.test");
    expect(from.closest(".field-row")?.textContent).toContain("From");
    expect(from.closest(".field-row")?.textContent).toContain("Support");
    expect(within(dock).queryByRole("combobox"), "one address is not a choice").toBeNull();
    expect(dock.textContent).toContain("More addresses for this mailbox are added on People");
  });

  it("offers a choice at several, starting from none chosen", async () => {
    answerMailboxes([{ id: "mbx_test", name: "Support", addresses: "support@example.test,billing@example.test" }]);
    const dock = mount();
    const select = await within(dock).findByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect([...select.options].map((one) => one.textContent)).toEqual(["Choose an address…", "support@example.test", "billing@example.test"]);
  });

  it("says the addresses could not be read, rather than showing no From while the Node sends as one", async () => {
    answerWith((call) => (call.path.startsWith("/api/mailboxes")
      ? Response.json({ error: "E_UNAVAILABLE", message: "the catalog did not answer" }, { status: 503 })
      : undefined));
    const dock = mount();
    const said = await within(dock).findByText(/could not read this mailbox's addresses/);
    expect(said.closest(".field-row")?.textContent).toContain("From");
  });

  it("says a mailbox with no address sends from nothing, rather than showing no From", async () => {
    answerMailboxes([{ id: "mbx_test", name: "Support", addresses: null }]);
    const dock = mount();
    expect(await within(dock).findByText(/no address yet/i)).toBeTruthy();
    expect(within(dock).queryByRole("combobox")).toBeNull();
  });
});
