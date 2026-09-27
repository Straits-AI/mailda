import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";
import type { ComposerContext } from "../../src/client/app/screens/composer.tsx";

/**
 * A reply claims its case again at the seal, and a case taken in the meantime stops the send (#42, R4).
 *
 * `reply()` claims before the composer opens, but the composer outlives the Inbox — it survives navigation,
 * and a reply draft can be resumed from `/drafts` days later. Between the two, the case can be released or
 * taken by a colleague answering the same person. Only a claim at the seal closes that gap, and only a mounted
 * composer can show that it happens **before** the send and that a `held` answer means no send at all.
 *
 * Also here: where focus lands when the dock opens, because a reply left unfocused hands its first typed
 * letter to the Inbox's single-key shortcuts.
 */

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { Composer } = await import("../../src/client/app/screens/composer.tsx");

const REPLY: ComposerContext = {
  mailboxId: "mbx_test", inReplyToMessageId: "msg_1", caseId: "cas_1",
  to: "alice@outside.example", subject: "Re: Invoice", body: "\n\nOn … wrote:\n> Where is it?",
};

let claimAnswer: () => Response;

beforeEach(() => {
  reset();
  claimAnswer = () => Response.json({ case: { id: "cas_1", state: "claimed" } });
  answerWith((call) => {
    if (call.path === "/api/cases/cas_1/claim") return claimAnswer();
    if (call.path === "/api/cases/cas_1/steal") return Response.json({ case: { id: "cas_1", state: "claimed" } });
    if (call.path === "/api/sends" && call.method === "POST") return Response.json({ id: "snd_1" });
    return undefined;
  });
});

function mount(context: ComposerContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(<QueryClientProvider client={client}><Composer context={context} onClose={onClose} /></QueryClientProvider>);
  return { onClose };
}

/** Presses "Seal and send" once the resume lookup has let go of it. */
async function seal() {
  const button = screen.getByRole("button", { name: "Seal and send" }) as HTMLButtonElement;
  await waitFor(() => { expect(button.disabled).toBe(false); });
  await act(async () => { button.click(); });
}

const posted = () => calls.filter((call) => call.method === "POST").map((call) => call.path);

describe("the claim at send", () => {
  it("claims the reply's case immediately before sealing", async () => {
    const { onClose } = mount(REPLY);
    await seal();
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(posted()).toEqual(["/api/cases/cas_1/claim", "/api/sends"]);
  });

  it("does not seal when a colleague holds the case, and names them with a way to take it", async () => {
    claimAnswer = () => Response.json(
      { error: "held", heldBy: "bob@example.test", heldSince: "2026-09-26T09:00:00.000Z", message: "bob@example.test is answering this since 09:00." },
      { status: 409 },
    );
    const { onClose } = mount(REPLY);
    await seal();
    const held = await screen.findByText(/bob@example\.test is answering this since 09:00\./);
    expect(held.closest("[role=alert]")).not.toBeNull();
    expect(posted(), "sealed a reply to a case somebody else holds").toEqual(["/api/cases/cas_1/claim"]);
    expect(onClose).not.toHaveBeenCalled();

    // Taking it is the audited steal, and the send follows it — never a second claim that would lose again.
    await act(async () => { screen.getByRole("button", { name: "Take it anyway" }).click(); });
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(posted()).toEqual(["/api/cases/cas_1/claim", "/api/cases/cas_1/steal", "/api/sends"]);
  });

  it("shows any other refusal of the claim in the Node's words and seals nothing", async () => {
    claimAnswer = () => Response.json({ error: "closed", message: "This case is closed. Reopen it from the queue." }, { status: 409 });
    mount(REPLY);
    await seal();
    await screen.findByText("This case is closed. Reopen it from the queue.");
    expect(posted()).toEqual(["/api/cases/cas_1/claim"]);
    expect(screen.queryByRole("button", { name: "Take it anyway" })).toBeNull();
  });

  it("claims nothing for a message that answers no case", async () => {
    const { onClose } = mount({ mailboxId: "mbx_test", to: "someone@outside.example", subject: "Hello", body: "Hi" });
    await seal();
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(posted()).toEqual(["/api/sends"]);
  });
});

describe("focus when the dock opens", () => {
  it("puts a reply's caret in its body, before the quote", async () => {
    mount(REPLY);
    const body = document.getElementById("composer-body") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(body);
    expect(body.selectionStart).toBe(0);
    expect(body.selectionEnd).toBe(0);
  });

  it("puts a new message or a forward on its first field", async () => {
    mount({ mailboxId: "mbx_test" });
    expect(document.activeElement).toBe(document.getElementById("composer-to"));
  });
});
