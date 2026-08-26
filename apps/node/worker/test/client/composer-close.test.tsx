import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerDrafts, calls, reset } from "./session-stub.ts";

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

    await press(/^close$/);
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

    await press(/^close$/);
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

    await press(/^close$/);
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

    await press(/^close$/);
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

    await press(/^close$/);
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

    await press(/^close$/);
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

    await press(/^discard$/);
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
