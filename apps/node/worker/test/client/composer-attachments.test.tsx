import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG } from "/app/config.js";
import { answerWith, calls, reset } from "./session-stub.ts";
import { zipOf } from "../support/zip.ts";
import type { ComposerContext } from "../../src/client/app/screens/composer.tsx";

/**
 * What the composer says about attachments before anybody presses send.
 *
 * Two things that used to arrive only as the seal's refusal: the size limit, which nothing on screen named, and
 * a file this Node judges dangerous, which it now sends when its author says so. The warning under the file is
 * the author being told, and only while it is on screen does the seal carry `allowDangerousAttachments`.
 */

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { Composer } = await import("../../src/client/app/screens/composer.tsx");

const NEW: ComposerContext = { mailboxId: "mbx_test", to: "alice@outside.example", subject: "The code", body: "Attached." };

beforeEach(() => {
  reset();
  answerWith((call) => (call.path === "/api/sends" && call.method === "POST" ? Response.json({ id: "snd_1" }) : undefined));
});

function mount(context: ComposerContext = NEW) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(<QueryClientProvider client={client}><Composer context={context} onClose={onClose} /></QueryClientProvider>);
  return { onClose };
}

async function attach(...files: File[]) {
  const input = screen.getByLabelText("Attach") as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files } }); });
}

const sealButton = () => screen.getByRole("button", { name: "Seal and send" }) as HTMLButtonElement;
const limitLine = () => document.getElementById("composer-files-limit")!;

/** The two figures of "X MB of Y MB used", as numbers: what is attached, and the limit. */
function figures(): [number, number] {
  const [, used, limit] = /^([\d.]+) MB of ([\d.]+) MB used/.exec(limitLine().textContent ?? "") ?? [];
  return [Number(used), Number(limit)];
}

/** A file whose read waits until the test lets it go, and says whether it has begun. */
function heldRead(name: string) {
  const file = new File(["abc"], name, { type: "text/plain" });
  const read = { started: false, release: () => {} };
  Object.defineProperty(file, "arrayBuffer", {
    value: () => {
      read.started = true;
      return new Promise<ArrayBuffer>((resolve) => { read.release = () => resolve(new TextEncoder().encode("abc").buffer); });
    },
  });
  return { file, read };
}

async function seal() {
  await waitFor(() => { expect(sealButton().disabled).toBe(false); });
  await act(async () => { sealButton().click(); });
}

const sealBody = () => calls.find((call) => call.path === "/api/sends" && call.method === "POST")?.body as
  Record<string, unknown> | undefined;

describe("the attachment limit", () => {
  it("is on screen before anything is attached, in the sizes a person has", () => {
    mount();
    const line = screen.getByText(/^Up to [\d.]+ MB in total, \d+ files\.$/).textContent ?? "";
    const [, shown, count] = /^Up to ([\d.]+) MB in total, (\d+) files\.$/.exec(line)!;
    // The figure a person reads must never promise more than the seal allows (rounding to nearest can), and
    // must not undersell it by a tenth or more either.
    const raw = Math.floor(CONFIG.attachmentBudgetBytes * 3 / 4);
    expect(Number(shown) * 1_048_576).toBeLessThanOrEqual(raw);
    expect(raw - Number(shown) * 1_048_576).toBeLessThan(104_857.6);
    expect(Number(count)).toBe(CONFIG.maxAttachments);
  });

  it("says a file is over it, and will not send, in words a screen reader hears", async () => {
    mount();
    await attach(new File([new Uint8Array(CONFIG.attachmentBudgetBytes)], "video.mov"));
    expect(await screen.findByText(/Over the limit: remove a file or send a link\./)).toBeTruthy();
    expect(sealButton().disabled).toBe(true);
    // A live region, and the reason the dead button points at, so the refusal is heard as well as seen.
    expect(limitLine().getAttribute("role")).toBe("status");
    expect(sealButton().getAttribute("aria-describedby")).toBe("composer-files-limit");
  });

  it("is exact at the budget: what fits sends, one byte more does not, and the figures agree", async () => {
    mount();
    // At most the budget once encoded: three raw bytes to every four the seal counts.
    await attach(new File([new Uint8Array(Math.floor(CONFIG.attachmentBudgetBytes / 4) * 3)], "exact.txt"));
    await waitFor(() => { expect(sealButton().disabled).toBe(false); });
    expect(limitLine().textContent).not.toContain("Over the limit");
    const [fits, limit] = figures();
    expect(fits).toBeLessThanOrEqual(limit);

    await attach(new File(["x"], "one-more.txt"));
    await waitFor(() => { expect(limitLine().textContent).toContain("Over the limit"); });
    expect(sealButton().disabled).toBe(true);
    // Rounded down both ways it read "3.3 MB of 3.3 MB used … Over the limit", an ask equal to the limit.
    const [over, same] = figures();
    expect(over).toBeGreaterThan(same);
  });

  it("reads a file's own size, as its row does, not its base64 size's", async () => {
    mount();
    // 4 MiB is 40 tenths exactly; derived from the base64 size, padding and all, it read 4.1 beside "4096 KB".
    await attach(new File([new Uint8Array(4 * 1_048_576)], "quarterly-dataset.csv"));
    expect(limitLine().textContent).toMatch(/^4\.0 MB of [\d.]+ MB used, 1 of \d+ files\. Over the limit/);
  });

  it("never reads as fitting beside Over, though padding alone put the file over a limit on a tenth", async () => {
    // A fixture budget, not any Node's: three quarters of it is 3,670,016 bytes, 3.5 MB exactly. The seal's
    // budget today sits between tenths, where this cannot show; the line must not depend on where it sits.
    const config = CONFIG as { attachmentBudgetBytes: number };
    const was = config.attachmentBudgetBytes;
    config.attachmentBudgetBytes = 4_893_355;
    try {
      mount();
      // One byte under the limit as a file, 4,893,356 once encoded: over by base64's padding alone.
      await attach(new File([new Uint8Array(3_670_015)], "padded.bin"));
      expect(limitLine().textContent).toContain("Over the limit");
      const [over, limit] = figures();
      expect(limit).toBe(3.5);
      expect(over).toBeGreaterThan(limit);
    } finally {
      config.attachmentBudgetBytes = was;
    }
  });

  it("reads a small file's share in KB, as its row does, not as nothing", async () => {
    mount();
    await attach(new File([new Uint8Array(459)], "small.txt"));
    expect(limitLine().textContent).toMatch(/^1 KB of [\d.]+ MB used, 1 of \d+ files\.$/);
  });

  it("counts files as well as bytes: one more than a send may carry will not send", async () => {
    mount();
    await attach(...Array.from({ length: CONFIG.maxAttachments + 1 }, (_, i) => new File(["x"], `f${i}.txt`)));
    // Judged, so nothing but the count is holding the send.
    await waitFor(() => { expect(screen.queryByText(/Checking…/)).toBeNull(); });
    expect(limitLine().textContent).toContain(`${CONFIG.maxAttachments + 1} of ${CONFIG.maxAttachments} files. Too many files.`);
    expect(limitLine().textContent).not.toContain("Over the limit");
    expect(sealButton().disabled).toBe(true);
  });
});

describe("a file as it is attached", () => {
  it("is listed at once and holds the send until judged, one file read at a time", async () => {
    mount();
    const first = heldRead("a.txt");
    const second = heldRead("b.txt");
    await attach(first.file, second.file);
    // On the list before either is read: a send pressed now would otherwise have left without both.
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(screen.getByText("b.txt")).toBeTruthy();
    expect(screen.getAllByText(/Checking…/)).toHaveLength(2);
    expect(sealButton().disabled).toBe(true);
    // The reason, where the dead button's description and the live region are: the rows alone are neither.
    expect(limitLine().textContent).toContain(" Checking files…");
    expect(limitLine().className).toBe("hint");
    expect([first.read.started, second.read.started]).toEqual([true, false]);

    await act(async () => { first.read.release(); });
    await waitFor(() => { expect(second.read.started).toBe(true); });
    expect(sealButton().disabled).toBe(true);
    // Uncounted, so the live line is not read again as each file is judged.
    expect(limitLine().textContent).toContain(" Checking files…");
    await act(async () => { second.read.release(); });
    await waitFor(() => { expect(sealButton().disabled).toBe(false); });
    expect(screen.queryByText(/Checking…/)).toBeNull();
    expect(limitLine().textContent).not.toContain("Checking");
  });

  it("blocks the send when this browser could not read it, and says how to recover", async () => {
    mount();
    const gone = new File(["x"], "gone.pdf");
    Object.defineProperty(gone, "arrayBuffer", { value: () => Promise.reject(new Error("The requested file could not be read")) });
    await attach(gone);
    expect(await screen.findByText(
      /could not read it \(The requested file could not be read\), so it cannot be sent: remove it and attach it again\./,
    )).toBeTruthy();
    expect(limitLine().textContent).toContain("1 file could not be read");
    expect(sealButton().disabled).toBe(true);
    await act(async () => { screen.getByRole("button", { name: "Remove" }).click(); });
    expect(sealButton().disabled).toBe(false);
  });

  it("cannot be removed or joined by another while a seal is in the air", async () => {
    let claimed = (_: Response) => {};
    answerWith((call) => {
      if (call.path === "/api/cases/cas_1/claim") return new Promise<Response>((resolve) => { claimed = resolve; });
      if (call.path === "/api/sends" && call.method === "POST") return Response.json({ id: "snd_1" });
      return undefined;
    });
    const { onClose } = mount({ ...NEW, caseId: "cas_1" });
    await attach(new File(["%PDF-1.7"], "invoice.pdf", { type: "application/pdf" }));
    await seal();
    // The seal took this list; a Remove now would change the screen and not the send.
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Attach") as HTMLInputElement).disabled).toBe(true);
    await act(async () => { claimed(Response.json({ case: { id: "cas_1", state: "claimed" } })); });
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
  });

  it("does not let Take it anyway take a colleague's case for a send the limit refuses", async () => {
    answerWith((call) => {
      if (call.path === "/api/cases/cas_1/claim") {
        return Response.json(
          { error: "held", heldBy: "bob@example.test", heldSince: "2026-09-26T09:00:00.000Z", message: "bob@example.test is answering this since 09:00." },
          { status: 409 },
        );
      }
      return undefined;
    });
    mount({ ...NEW, caseId: "cas_1" });
    await seal();
    await screen.findByText(/bob@example\.test is answering this/);
    await attach(new File([new Uint8Array(CONFIG.attachmentBudgetBytes)], "video.mov"));
    await screen.findByText(/Over the limit/);
    const takeIt = screen.getByRole("button", { name: "Take it anyway" }) as HTMLButtonElement;
    expect(takeIt.disabled).toBe(true);
    expect(takeIt.getAttribute("aria-describedby")).toBe("composer-files-limit");
  });
});

describe("a file this Node judges dangerous", () => {
  it("is named in a warning under it, and the seal says the author sends it anyway", async () => {
    const { onClose } = mount();
    const code = zipOf([["verifylab/index.js", "export {}"]]);
    await attach(new File([code], "verifylab-1.0.0.zip", { type: "application/zip" }));
    expect(await screen.findByText(/verifylab-1\.0\.0\.zip is an archive listing a program or a script\./)).toBeTruthy();
    // Announced by the live limit line, which is always there: a region mounted already full is heard unreliably.
    expect(limitLine().textContent).toContain("1 file judged dangerous: see the warning below.");
    await seal();
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(sealBody()?.allowDangerousAttachments).toBe(true);
  });

  it("is counted on the live line once every file is judged, not as each one is", async () => {
    mount();
    const later = heldRead("notes.txt");
    await attach(new File([zipOf([["verifylab/index.js", "export {}"]])], "verifylab-1.0.0.zip"), later.file);
    // Its own warning is up at once; the line, read whole on every change, waits for the rest.
    await screen.findByText(/verifylab-1\.0\.0\.zip is an archive listing a program or a script\./);
    await waitFor(() => { expect(later.read.started).toBe(true); });
    expect(limitLine().textContent).toContain(" Checking files…");
    expect(limitLine().textContent).not.toContain("judged dangerous");
    await act(async () => { later.read.release(); });
    await waitFor(() => { expect(limitLine().textContent).toContain("1 file judged dangerous: see the warning below."); });
  });

  it("is not claimed for a plain file: no warning, and no flag on the seal", async () => {
    const { onClose } = mount();
    await attach(new File(["%PDF-1.7"], "invoice.pdf", { type: "application/pdf" }));
    await screen.findByText("invoice.pdf");
    await waitFor(() => { expect(screen.queryByText(/Checking…/)).toBeNull(); });
    // The warning itself, not a verdict's words: shown for a plain file it reads "invoice.pdf is . It will be…".
    expect(screen.queryByText(/will be sent because you attached it/)).toBeNull();
    expect(limitLine().textContent).not.toContain("judged dangerous");
    await seal();
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(sealBody()).not.toHaveProperty("allowDangerousAttachments");
  });
});
