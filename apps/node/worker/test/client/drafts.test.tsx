import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * `/drafts` resumes a draft in the shell's one composer, and a reply draft carries its case (R4).
 *
 * The case is the part that would be missed: a reply resumed hours later opens a composer that looks exactly
 * the same with or without it, and only the send differs. With the case, the composer claims it again before
 * sealing, so a case released or taken in the meantime stops the send and names the holder; without it, the
 * reply goes out beside somebody else's.
 */

const route = vi.hoisted(() => ({ pathname: "/drafts" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Drafts } = await import("../../src/client/app/screens/drafts.tsx");
const { ShellProvider, useCompose } = await import("../../src/client/app/shell-context.tsx");

/** The context the shell's composer was opened with, read directly. */
function Composing() {
  const { composing } = useCompose();
  return <output data-testid="composing">{composing === null ? "" : JSON.stringify(composing)}</output>;
}

const REPLY = {
  id: "drf_reply", mailboxId: "mbx_test", inReplyToMessageId: "msg_1", to: ["ana@example.test"],
  subject: "Re: Invoice INV-2041", updatedAt: "2026-09-26T09:00:00.000Z", caseId: "cas_1",
};
const NEW = {
  id: "drf_new", mailboxId: "mbx_test", inReplyToMessageId: null, to: [], subject: " ",
  updatedAt: "2026-09-26T08:00:00.000Z", caseId: null,
};

/** Opens the shell's composer as Compose or R would, with no draft id: the Node has not saved one yet. */
function Opener({ context }: { context: Record<string, string> }) {
  const compose = useCompose();
  return <button type="button" onClick={() => compose.open({ mailboxId: "mbx_test", ...context })}>Open the composer</button>;
}

function mount(
  drafts: ReadonlyArray<typeof REPLY | typeof NEW>,
  truncated = false,
  opener: Record<string, string> | null = null,
  seal?: () => Promise<Response>,
) {
  answerWith((call) => {
    if (call.path === "/api/sends" && call.method === "POST") return seal?.();
    if (call.path === "/api/drafts" && call.method === "PUT") {
      // A new message's first save: the Node gives it the id `/drafts` lists it under.
      return Response.json({ draft: { ...NEW, cc: [], bcc: [], body: (call.body as { body: string }).body } });
    }
    if (call.path === "/api/drafts") return Response.json({ drafts, truncated });
    // The composer's resume reads the draft it was opened on, by id.
    const one = drafts.find((draft) => call.path === `/api/drafts/${draft.id}`);
    if (one === undefined) return undefined;
    return Response.json({ draft: { ...one, cc: [], bcc: [], body: "", bodyUnavailable: null } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShellProvider>{opener === null ? null : <Opener context={opener} />}<Drafts /><Composing /></ShellProvider>
    </QueryClientProvider>,
  );
}

const composing = () => JSON.parse(screen.getByTestId("composing").textContent || "null") as Record<string, unknown> | null;

beforeEach(reset);

describe("resuming a draft", () => {
  it("opens a reply draft with the message it answers and its case, so the send claims it", async () => {
    mount([REPLY, NEW]);
    fireEvent.click(await screen.findByRole("button", { name: /Re: Invoice INV-2041/ }));
    expect(composing()).toEqual({ mailboxId: "mbx_test", draftId: "drf_reply", inReplyToMessageId: "msg_1", caseId: "cas_1" });
    expect(await screen.findByRole("region", { name: "Reply" })).toBeTruthy();
  });

  it("opens a new-message draft by id alone, with no case to claim", async () => {
    mount([REPLY, NEW]);
    fireEvent.click(await screen.findByRole("button", { name: /\(no subject\)/ }));
    expect(composing()).toEqual({ mailboxId: "mbx_test", draftId: "drf_new" });
  });

  it("says who a draft is to, or that it has nobody yet", async () => {
    mount([REPLY, NEW]);
    const rows = (await screen.findAllByRole("button")).map((button) => button.textContent ?? "");
    expect(rows[0]).toContain("ana@example.test");
    expect(rows[1]).toContain("no recipient yet");
  });
});

describe("the list in English", () => {
  /*
   * Byte for byte as it was before its words moved into the catalog (ADR 46). The times are the machine's zone,
   * so they are replaced by the formatter that writes each one, which `composer-words.test.tsx` holds.
   */
  it("renders the rows, the cap and the empty list as it did before", async () => {
    mount([REPLY, NEW], true);
    await screen.findByRole("list", { name: "Drafts" });
    const listed = document.body.innerHTML
      .replace(/(<time[^>]* title=")[^"]*(">)[^<]*(<\/time>)/g, "$1{dateTime}$2{mediumDateTime}$3");
    cleanup();
    mount([]);
    await screen.findByText("No drafts.");
    await expect(`${listed}\n${document.body.innerHTML}\n`).toMatchFileSnapshot("./golden/drafts.en.html");
  });
});

describe("the list's states", () => {
  it("says there are none, rather than rendering an empty list", async () => {
    mount([]);
    expect(await screen.findByText("No drafts.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Drafts" })).toBeNull();
  });

  it("says where a capped list stopped", async () => {
    mount([REPLY], true);
    expect(await screen.findByText("Showing the newest 1 drafts. Older ones exist and are not listed.")).toBeTruthy();
  });
});

describe("opening the draft that is already open keeps it", () => {
  /*
   * A remount would read the draft back before the open dock's own save landed, so the words typed in the last
   * autosave pause vanished from the screen. The reply was matched already (by the message it answers); a new
   * message has no id in its context until its first save, so it was matched by nothing and reloaded.
   */
  const body = () => document.getElementById("composer-body") as HTMLTextAreaElement;
  const reads = (id: string) => calls.filter((call) => call.path === `/api/drafts/${id}` && call.method === "GET");

  it("keeps a reply's dock and unsaved words when /drafts opens that reply", async () => {
    mount([REPLY, NEW], false, { inReplyToMessageId: "msg_1" });
    fireEvent.click(await screen.findByRole("button", { name: "Open the composer" }));
    const dock = await screen.findByRole("region", { name: "Reply" });
    fireEvent.change(body(), { target: { value: "not saved yet" } });

    fireEvent.click(await screen.findByRole("button", { name: /Re: Invoice INV-2041/ }));
    expect(screen.getByRole("region", { name: "Reply" }), "the reply's dock was remounted").toBe(dock);
    expect(body().value).toBe("not saved yet");
    expect(reads("drf_reply"), "the open reply was read back from the Node").toHaveLength(0);
  });

  it("keeps a new message's dock and unsaved words when /drafts opens the draft its first save made", async () => {
    vi.useFakeTimers();
    try {
      mount([NEW], false, {});
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      fireEvent.click(screen.getByRole("button", { name: "Open the composer" }));
      const dock = screen.getByRole("region", { name: "New message" });
      fireEvent.change(body(), { target: { value: "first words" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(calls.filter((call) => call.method === "PUT"), "no first save, so the dock has no id to match").toHaveLength(1);
      fireEvent.change(body(), { target: { value: "first words, and more" } });

      fireEvent.click(screen.getByRole("button", { name: /\(no subject\)/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(screen.getByRole("region", { name: "New message" }), "the new message's dock was remounted").toBe(dock);
      expect(body().value).toBe("first words, and more");
      expect(reads("drf_new"), "the open draft was read back from the Node").toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a seal in the air keeps its dock", () => {
  /*
   * Replaced mid-seal, the dock took the seal's answer with it: a refusal was set on a component no longer on
   * screen, so the person saw neither a sent message nor a reason, only a draft they had not asked for
   * (AGENTS.md §3, never swallow). And a seal that succeeded closed the dock that had replaced it.
   */
  it("keeps the sealing dock when /drafts opens another draft, says why, and shows the Node's refusal in it", async () => {
    let answerSeal!: (response: Response) => void;
    mount([REPLY], false, {}, () => new Promise<Response>((resolve) => { answerSeal = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: "Open the composer" }));
    const dock = await screen.findByRole("region", { name: "New message" });
    const body = document.getElementById("composer-body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "words the seal is carrying" } });
    await act(async () => { screen.getByRole("button", { name: "Seal and send" }).click(); });
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/sends"), "the seal is not in the air, so this proves nothing").toHaveLength(1);
    });

    fireEvent.click(await screen.findByRole("button", { name: /Re: Invoice INV-2041/ }));
    expect(screen.getByRole("region", { name: "New message" }), "the sealing dock was replaced").toBe(dock);
    expect(composing()).toEqual({ mailboxId: "mbx_test" });
    expect(await screen.findByText("Still sealing the open message. Open this again once the Node has answered it.")).toBeTruthy();

    await act(async () => { answerSeal(Response.json({ message: "E_RECIPIENT_REQUIRED  add a recipient" }, { status: 422 })); });
    expect(await within(dock).findByText(/E_RECIPIENT_REQUIRED/)).toBeTruthy();
    expect(body.value).toBe("words the seal is carrying");
  });
});
