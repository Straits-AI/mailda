import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerDrafts, answerWith, calls, reset } from "./session-stub.ts";
import type { ComposerContext } from "../../src/client/app/screens/composer.tsx";

/**
 * Closing the composer does not lose what was typed (#90).
 *
 * ## Why this test has to render
 *
 * The defect was not in any function. It was in the *arrangement*: the autosave lived inside a
 * `setTimeout` owned by an effect, the effect's cleanup cancelled that timer on unmount, and the close
 * button called `onClose` directly. Every piece was correct alone. What was wrong was that closing inside
 * the idle window unmounted the component, which cancelled the timer, which meant the write never
 * happened — and the comment beside the button said "Closing keeps the draft".
 *
 * No arrangement of pure functions expresses that. The mount *is* the subject, which is what
 * `vitest.client.config.ts` exists for.
 *
 * ## Fake timers, and the one thing they must not hide
 *
 * The idle window is 1.5s and waiting it out four times would make this suite slow enough to skip. So
 * time is advanced explicitly — which also lets a test sit at 1,499ms, the boundary where the bug lived
 * and where no real-clock test would reliably land.
 */

// `useNavigate` needs a router around it and `seal` is the only caller; nothing here seals.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { Composer } = await import("../../src/client/app/screens/composer.tsx");

/** The last moment before the debounce fires. The boundary the old code lost data at. */
const LAST_MOMENT_MS = 1_499;

function mount(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Composer context={{ mailboxId: "mbx_test" }} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

/** Types into the body, which is enough to make the draft dirty. */
async function type(text: string) {
  const body = document.getElementById("composer-body") as HTMLTextAreaElement;
  await act(async () => {
    // `input` rather than a per-character simulation: the debounce is keyed on the value changing, and
    // this suite is about what happens after typing stops rather than about typing itself.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value",
    )!.set!;
    setter.call(body, text);
    body.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(name: RegExp) {
  await act(async () => {
    screen.getByRole("button", { name }).click();
  });
}

/** Lets every pending promise settle without moving the clock. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const drafts = () => calls.filter((call) => call.path === "/api/drafts" && call.method === "PUT");

beforeEach(() => {
  reset();
  /*
   * The clock moves only when a test moves it. `shouldAdvanceTime: true` was the first version and it made
   * the 1,499 ms boundary test **flaky by construction**: with it, wall-clock time spent inside the awaits
   * also advances the fake clock, so `advanceTimersByTimeAsync(1499)` plus a few real milliseconds crosses
   * 1,500 and the debounce fires. It passed on a fast run and failed on a slower one, which is the worst
   * available outcome — the boundary this test exists to sit exactly on cannot be shared with the wall.
   */
  vi.useFakeTimers();
  answerDrafts(() => Response.json({
    draft: { id: "dft_01", to: [], subject: "", body: "", updatedAt: "2026-08-26T00:00:00.000Z" },
  }));
});

describe("closing flushes what the debounce has not written yet", () => {
  it("saves when closed immediately after typing, inside the idle window", async () => {
    /*
     * The bug, at its worst. Zero elapsed time: the debounce timer has not fired and, under the old
     * cleanup, never would. Everything typed was gone and the interface had said it was kept.
     */
    const { onClose } = mount();
    await type("the paragraph that used to vanish");
    expect(drafts()).toHaveLength(0);

    await press(/^Close$/);
    await settle();

    expect(drafts()).toHaveLength(1);
    expect((drafts()[0]!.body as { body: string }).body).toBe("the paragraph that used to vanish");
    expect(onClose).toHaveBeenCalled();
  });

  it("saves when closed at the last moment before the debounce would fire", async () => {
    const { onClose } = mount();
    await type("written at 1499");
    await act(async () => { await vi.advanceTimersByTimeAsync(LAST_MOMENT_MS); });
    expect(drafts(), "the debounce fired early").toHaveLength(0);

    await press(/^Close$/);
    await settle();

    expect(drafts()).toHaveLength(1);
    expect((drafts()[0]!.body as { body: string }).body).toBe("written at 1499");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes without a write when the Node already has the text", async () => {
    /*
     * The other direction, and it is not filler: a close that wrote unconditionally would cost an R2
     * write every time somebody opened a draft to read it and closed it again, and would move
     * `updated_at` — which `composer.tsx` already went to trouble to stop meaning "when you last looked
     * at it".
     */
    const { onClose } = mount();
    await type("saved before closing");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(drafts()).toHaveLength(1);

    await press(/^Close$/);
    await settle();

    expect(drafts(), "closing wrote a second time with nothing changed").toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a close that cannot save does not close", () => {
  it("keeps the dock open and says why when the Node refuses", async () => {
    /*
     * The property that makes this a fix rather than a narrower version of the same bug: closing anyway
     * after a failed flush would still lose the writing, just with a message on the way out. `discard`
     * already worked this way for a legal hold; `close` now does too.
     */
    const { onClose } = mount();
    answerDrafts(() => Response.json(
      { error: "E_LEGAL_HOLD", message: "A legal hold covers this mailbox." }, { status: 409 },
    ));
    await type("refused");

    await press(/^Close$/);
    await settle();

    expect(onClose, "the dock closed over a failed save").not.toHaveBeenCalled();
    // The Node's own words, verbatim, not a paraphrase — the half that says what to do about it.
    expect(screen.getByText(/A legal hold covers this mailbox\./)).toBeTruthy();
    expect(screen.getByText(/staying open/i)).toBeTruthy();
  });

  it("keeps it open when the Node cannot be reached at all", async () => {
    const { onClose } = mount();
    answerDrafts(() => { throw new Error("network down"); });
    await type("unreachable");

    await press(/^Close$/);
    await settle();

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/network down/)).toBeTruthy();
  });
});

describe("two writes never overlap", () => {
  it("waits for the save already in flight rather than starting a second", async () => {
    /*
     * Last-write-wins between two concurrent PUTs is decided by the network, so a slow first write can
     * land after a fast second and leave the Node holding the *older* text. The fix waits instead of
     * racing, and this is the assertion that it does.
     */
    const { onClose } = mount();
    let release: (() => void) | null = null;
    answerDrafts(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return Response.json({
        draft: { id: "dft_01", to: [], subject: "", body: "", updatedAt: "2026-08-26T00:00:00.000Z" },
      });
    });

    await type("first");
    // Let the debounce fire, so a write is genuinely in the air and unresolved.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(drafts()).toHaveLength(1);

    await press(/^Close$/);
    await settle();
    expect(drafts(), "close started a second write beside the one in flight").toHaveLength(1);
    expect(onClose, "close resolved before the write it was waiting for").not.toHaveBeenCalled();

    // Now let the in-flight write land. Nothing changed while it was in the air, so its result is the
    // answer and the dock closes on it without a second request.
    answerDrafts(() => Response.json({
      draft: { id: "dft_01", to: [], subject: "", body: "", updatedAt: "2026-08-26T00:00:00.000Z" },
    }));
    await act(async () => { release!(); });
    await settle();

    expect(drafts()).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("discarding removes the draft the in-flight write just created", () => {
  it("deletes by the id that write returned, not the one the closure remembers", async () => {
    /*
     * Waiting for the in-flight write is what makes `discard` correct — otherwise the PUT lands after the
     * DELETE and puts the draft back. But waiting introduces its own trap: the write being waited for may
     * be the one that *created* the draft, and `draftId` in the click handler's closure is still `null`
     * from the render that made it. Reading it there would skip the DELETE entirely and leave the draft
     * on the Node after somebody pressed discard — a quieter version of the same bug, in the button whose
     * entire job is removing things.
     *
     * Hence the id going into the ref inside `writeDraft`. This is the test that says so.
     */
    mount();
    let release: (() => void) | null = null;
    answerDrafts(async (call) => {
      if (call.method === "DELETE") return Response.json({}, { status: 204 });
      await new Promise<void>((resolve) => { release = resolve; });
      return Response.json({
        draft: { id: "dft_created", to: [], subject: "", body: "", updatedAt: "2026-08-26T00:00:00.000Z" },
      });
    });

    await type("about to be thrown away");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(drafts(), "no write in flight, so this proves nothing").toHaveLength(1);

    await press(/^Discard$/);
    await settle();
    await act(async () => { release!(); });
    await settle();

    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes, "discard skipped the DELETE, leaving the draft on the Node").toHaveLength(1);
    expect(deletes[0]!.path).toBe("/api/drafts/dft_created");
  });
});

describe("unmounting without pressing close still saves", () => {
  it("writes the draft when the dock is taken away by something else", async () => {
    /*
     * The path `close` cannot cover: a rail link, a route change, anything that unmounts the composer
     * without going through a button. The old cleanup cancelled the timer here too, so this was the same
     * data loss reached a different way — and it is why the flush lives in an unmount-only effect rather
     * than inside `close`.
     */
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <Composer context={{ mailboxId: "mbx_test" }} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await type("taken away mid-sentence");
    expect(drafts()).toHaveLength(0);

    await act(async () => { view.unmount(); });
    await settle();

    expect(drafts(), "unmount dropped the pending write").toHaveLength(1);
    expect((drafts()[0]!.body as { body: string }).body).toBe("taken away mid-sentence");
  });
});

describe("a discarded or sealed composer writes nothing after it closes", () => {
  /*
   * The Shell's arrangement, in miniature: `onClose` takes the dock away, so its unmount flush runs. With a
   * `vi.fn()` for `onClose` (as above) the dock never unmounts and the ghost this block is about cannot appear.
   */
  function Shell({ context }: { context: ComposerContext }) {
    const [open, setOpen] = useState(true);
    return open ? <Composer context={context} onClose={() => setOpen(false)} /> : null;
  }
  function mountShell(context: ComposerContext) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Shell context={context} /></QueryClientProvider>);
  }
  const gone = () => document.querySelector(".composer-dock") === null;
  const deletes = () => calls.filter((call) => call.method === "DELETE");

  it("puts no draft back after Discard on a prefilled reply that never autosaved", async () => {
    // A reply-all, prefilled, and never saved: the case where R later resumed the Cc of a discarded reply-all.
    answerDrafts(() => Response.json({ draft: null }));
    mountShell({
      mailboxId: "mbx_test", inReplyToMessageId: "msg_1", caseId: "cas_1",
      to: "a@outside.example", cc: "b@outside.example", subject: "Re: Pilot", body: "\n\nOn … wrote:\n> six seats",
    });
    await settle();
    await press(/^Discard$/);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(gone(), "Discard did not close the dock").toBe(true);
    expect(drafts(), "a discarded reply was written back as a new draft").toHaveLength(0);
  });

  it("puts no draft back after a seal made inside the idle window", async () => {
    answerWith((call) => {
      if (call.path === "/api/sends" && call.method === "POST") return Response.json({ id: "snd_1" });
      if (call.path.startsWith("/api/drafts")) return Response.json({ draft: null });
      return undefined;
    });
    mountShell({ mailboxId: "mbx_test", to: "a@outside.example", subject: "Hello" });
    await type("sent before the autosave fired");
    await act(async () => { screen.getByRole("button", { name: "Seal and send" }).click(); });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(calls.filter((call) => call.path === "/api/sends"), "the seal did not happen, so this proves nothing").toHaveLength(1);
    expect(gone()).toBe(true);
    expect(drafts(), "a sent message was written back as a draft").toHaveLength(0);
  });

  it("writes nothing while the DELETE is in the air, even when the autosave timer fires then", async () => {
    let release!: () => void;
    answerDrafts(async (call) => {
      if (call.method === "DELETE") {
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response(null, { status: 204 });
      }
      return Response.json({ draft: { id: "dft_1", to: ["a@outside.example"], cc: [], bcc: [], subject: "Saved", body: "saved", updatedAt: "2026-08-26T00:00:00.000Z" } });
    });
    mountShell({ mailboxId: "mbx_test", draftId: "dft_1" });
    await settle();
    await type("typed after the last save");
    await press(/^Discard$/);
    await settle();
    // The debounce armed by that keystroke fires while the DELETE is still unanswered.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(drafts(), "the autosave wrote the draft being deleted").toHaveLength(0);

    await act(async () => { release(); });
    await settle();
    expect(deletes().map((call) => call.path)).toEqual(["/api/drafts/dft_1"]);
    expect(gone()).toBe(true);
    expect(drafts()).toHaveLength(0);
  });

  it("goes on saving after a refused Discard, because the dock and the draft both stay", async () => {
    answerDrafts((call) => (call.method === "DELETE"
      ? Response.json({ error: "E_LEGAL_HOLD", message: "A legal hold covers this mailbox." }, { status: 409 })
      : Response.json({ draft: { id: "dft_1", to: [], cc: [], bcc: [], subject: "", body: "kept", updatedAt: "2026-08-26T00:00:00.000Z" } })));
    mountShell({ mailboxId: "mbx_test", draftId: "dft_1" });
    await settle();
    await press(/^Discard$/);
    await settle();
    expect(screen.getByText(/A legal hold covers this mailbox\./)).toBeTruthy();

    await type("still writing under the hold");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(drafts(), "a refused discard left the dock unable to save").toHaveLength(1);
  });

  it("goes on saving after a seal the Node refused, or never received", async () => {
    let sends = 0;
    answerWith((call) => {
      if (call.path === "/api/sends" && call.method === "POST") {
        sends += 1;
        if (sends === 1) return Response.json({ message: "E_RECIPIENT_REQUIRED  add a recipient" }, { status: 422 });
        throw new Error("network down");
      }
      if (call.path.startsWith("/api/drafts")) return Response.json({ draft: { id: "dft_1", to: [], cc: [], bcc: [], subject: "", body: "", updatedAt: "2026-08-26T00:00:00.000Z" } });
      return undefined;
    });
    mountShell({ mailboxId: "mbx_test" });
    for (const [attempt, words] of [[1, "after a refusal"], [2, "after a lost connection"]] as const) {
      await act(async () => { screen.getByRole("button", { name: "Seal and send" }).click(); });
      await settle();
      expect(sends).toBe(attempt);
      expect(gone()).toBe(false);
      const before = drafts().length;
      await type(words);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(drafts().length, `the dock stopped saving ${words}`).toBe(before + 1);
    }
  });

  it("says so and stays open when the DELETE never reaches the Node", async () => {
    answerDrafts((call) => {
      if (call.method === "DELETE") throw new Error("network down");
      return Response.json({ draft: { id: "dft_1", to: [], cc: [], bcc: [], subject: "", body: "kept", updatedAt: "2026-08-26T00:00:00.000Z" } });
    });
    mountShell({ mailboxId: "mbx_test", draftId: "dft_1" });
    await settle();
    await press(/^Discard$/);
    await settle();
    expect(gone()).toBe(false);
    expect(screen.getByText(/could not be reached \(network down\), so this draft may still be here/)).toBeTruthy();
  });
});

describe("a seal in the air keeps the words until the Node has answered it", () => {
  /*
   * `retired` stops writes from the moment a seal starts, so the draft cannot come back after the Node retires
   * it. What it must not do is answer "saved" for words nothing saved: a Close pressed mid-seal used to shut
   * the dock on that answer, and a seal then refused took the words with it, its refusal set on a component
   * that no longer existed.
   */
  let answerSeal!: (response: Response) => void;
  function sealAnswersLater() {
    answerWith((call) => {
      if (call.path === "/api/sends" && call.method === "POST") return new Promise<Response>((resolve) => { answerSeal = resolve; });
      if (call.path.startsWith("/api/drafts")) return Response.json({ draft: { id: "dft_1", to: [], cc: [], bcc: [], subject: "", body: "", updatedAt: "2026-08-26T00:00:00.000Z" } });
      return undefined;
    });
  }
  const REFUSED = () => Response.json({ message: "E_RECIPIENT_REQUIRED  add a recipient" }, { status: 422 });

  it("offers no Close or Discard while sealing, so a refusal finds the dock and the words still there", async () => {
    sealAnswersLater();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    render(<QueryClientProvider client={client}><Composer context={{ mailboxId: "mbx_test" }} onClose={onClose} /></QueryClientProvider>);
    await type("words the seal was carrying");
    await act(async () => { screen.getByRole("button", { name: "Seal and send" }).click(); });
    await settle();
    expect(calls.filter((call) => call.path === "/api/sends"), "the seal is not in the air, so this proves nothing").toHaveLength(1);

    expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled"), "Close can shut the dock mid-seal").toBe(true);
    expect(screen.getByRole("button", { name: "Discard" }).hasAttribute("disabled"), "Discard can run mid-seal").toBe(true);
    await press(/^Close$/);

    await act(async () => { answerSeal(REFUSED()); });
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/E_RECIPIENT_REQUIRED/)).toBeTruthy();
    expect((document.getElementById("composer-body") as HTMLTextAreaElement).value).toBe("words the seal was carrying");
  });

  it("writes the words as a draft when the dock is taken away mid-seal and the seal is then refused", async () => {
    sealAnswersLater();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><Composer context={{ mailboxId: "mbx_test" }} onClose={vi.fn()} /></QueryClientProvider>);
    await type("taken away while sealing");
    await act(async () => { screen.getByRole("button", { name: "Seal and send" }).click(); });
    await settle();
    await act(async () => { view.unmount(); });
    await settle();
    expect(drafts(), "a write started beside the seal").toHaveLength(0);

    await act(async () => { answerSeal(REFUSED()); });
    await settle();
    expect(drafts(), "the refused seal's words were lost").toHaveLength(1);
    expect((drafts()[0]!.body as { body: string }).body).toBe("taken away while sealing");
  });

  it("writes nothing when the dock is taken away mid-seal and the seal then succeeds", async () => {
    sealAnswersLater();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><Composer context={{ mailboxId: "mbx_test" }} onClose={vi.fn()} /></QueryClientProvider>);
    await type("sealed while away");
    await act(async () => { screen.getByRole("button", { name: "Seal and send" }).click(); });
    await settle();
    await act(async () => { view.unmount(); });
    await act(async () => { answerSeal(Response.json({ id: "snd_1" })); });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(drafts(), "a sent message was written back as a draft").toHaveLength(0);
  });
});
