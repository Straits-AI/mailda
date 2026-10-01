import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG } from "/app/config.js";
import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { answerMailboxes, answerWith, reset, type Call } from "./session-stub.ts";
import type { ComposerContext, ComposerHandle } from "../../src/client/app/screens/composer.tsx";

/**
 * The composer in English, byte for byte, as it was before its words moved into the catalog (ADR 46,
 * `docs/i18n.md`). The golden files were written from the dock as it stood before the migration, so a key whose
 * English differs by a letter, a sentence split into fragments that no longer read as one, or an element lost
 * from inside a sentence shows here as a diff. No rendered time is in them: the suite's time zone is the
 * machine's, so the one time the dock shows (the saved phase) is held against its formatter instead.
 */

const navigation = vi.hoisted(() => ({ go: (() => Promise.resolve()) as () => Promise<void> }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => navigation.go() }));

const { Composer, forwardSubject, quoteLine, replySubject } = await import("../../src/client/app/screens/composer.tsx");
const format = await import("../../src/client/app/format.ts");

const dock = () => document.querySelector("section.composer-dock")!;

function mount(context: ComposerContext, ref?: React.Ref<ComposerHandle>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Composer context={context} onClose={vi.fn()} ref={ref} /></QueryClientProvider>);
}

async function type(text: string) {
  const body = document.getElementById("composer-body") as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(body, { target: { value: text } }); });
}

async function press(name: string | RegExp) {
  await act(async () => { screen.getByRole("button", { name }).click(); });
}

async function attach(...files: File[]) {
  const input = screen.getByLabelText("Attach") as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files } }); });
}

/** A file this browser cannot read, as a revoked file handle is. */
function unreadable(name: string): File {
  const file = new File(["x"], name, { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("The file could not be read")) });
  return file;
}

/**
 * What each failure leaves on screen: the phase label and every alert, as text. The saved phase's clock is the
 * machine's zone, so it is replaced by what formats it (`format.clock`, held below).
 */
function said(): string {
  const phase = (document.querySelector(".draft-phase")?.textContent ?? "").replace(/ · \d{2}:\d{2}:\d{2}$/, " · {clock}");
  const alerts = [...document.querySelectorAll("[role=alert]")].map((one) => one.textContent ?? "");
  return [phase, ...alerts].join("\n");
}

beforeEach(() => {
  reset();
  navigation.go = () => Promise.resolve();
});

describe("the composer in English", () => {
  it("renders a new message as it did before its words moved into the catalog", async () => {
    mount({ mailboxId: "mbx_test" });
    await screen.findByText("support@example.test");
    await expect(dock().outerHTML + "\n").toMatchFileSnapshot("./golden/composer.new.en.html");
  });

  it("renders a forward with a choice of address, copies, flagged and unreadable files and a lost body", async () => {
    answerMailboxes([{ id: "mbx_test", name: "Support", addresses: "support@example.test,billing@example.test" }]);
    mount({
      mailboxId: "mbx_test", forwardOfMessageId: "msg_1", originalSubject: "Invoice INV-2041",
      to: "ana@outside.example", cc: "bob@outside.example", subject: "Fwd: Invoice INV-2041", body: "",
      bodyUnavailable: "unreadable",
    });
    await screen.findByRole("combobox");
    await attach(
      new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], "setup.exe"),
      new File(["hello"], "notes.txt", { type: "text/plain" }),
      unreadable("gone.pdf"),
    );
    await waitFor(() => { expect(document.getElementById("composer-files-limit")!.textContent).not.toContain("Checking"); });
    await expect(dock().outerHTML + "\n").toMatchFileSnapshot("./golden/composer.forward.en.html");
  });

  it("says what the From line cannot show, the lost body, the limits and the reply's head", async () => {
    const lines: string[] = [];

    answerWith((call) => (call.path.startsWith("/api/mailboxes")
      ? Response.json({ error: "E_UNAVAILABLE", message: "the catalog did not answer" }, { status: 503 })
      : undefined));
    let mounted = mount({ mailboxId: "mbx_test", inReplyToMessageId: "msg_1", originalSubject: "Invoice", bodyUnavailable: "missing" });
    await screen.findByText(/could not read this mailbox's addresses/);
    lines.push(document.querySelector(".dock-head")!.outerHTML, document.querySelector(".field-row")!.outerHTML);
    lines.push(document.querySelector(".notice.bad")!.outerHTML);
    mounted.unmount();

    reset();
    answerMailboxes([{ id: "mbx_other", name: "Sales", addresses: "sales@example.test" }]);
    mounted = mount({ mailboxId: "mbx_test" });
    await screen.findByText(/not among the ones/);
    lines.push(document.querySelector(".field-row")!.outerHTML);
    mounted.unmount();

    reset();
    answerMailboxes([{ id: "mbx_test", name: "Support", addresses: null }]);
    mounted = mount({ mailboxId: "mbx_test" });
    await screen.findByText(/No address yet/);
    lines.push(document.querySelector(".field-row")!.outerHTML);
    mounted.unmount();

    reset();
    mount({ mailboxId: "mbx_test" });
    await attach(...Array.from({ length: CONFIG.maxAttachments + 1 }, (_, index) => new File(["x"], `f${index}.txt`)));
    await waitFor(() => { expect(document.getElementById("composer-files-limit")!.textContent).not.toContain("Checking"); });
    lines.push(document.getElementById("composer-files-limit")!.outerHTML);
    await attach(new File([new Uint8Array(CONFIG.attachmentBudgetBytes)], "video.mov"));
    await waitFor(() => { expect(document.getElementById("composer-files-limit")!.textContent).toContain("Over the limit"); });
    lines.push(document.getElementById("composer-files-limit")!.outerHTML);

    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/composer.states.en.html");
  });

  it("says each failure to save, discard, claim or seal in the words it said them before", async () => {
    const lines: string[] = [];
    const run = async (name: string, context: ComposerContext, respond: (call: Call) => Promise<Response> | Response | undefined, act: () => Promise<void>) => {
      reset();
      answerWith(respond);
      const mounted = mount(context);
      await screen.findByText("support@example.test");
      await act();
      lines.push(`## ${name}`, said());
      mounted.unmount();
    };
    const put = (answer: () => Promise<Response> | Response) => (call: Call) => (call.path === "/api/drafts" && call.method === "PUT" ? answer() : undefined);
    const closeAfterTyping = async () => {
      await type("Hello");
      await press("Close");
      await waitFor(() => { expect(document.querySelector(".draft-phase")!.textContent).toMatch(/^not saved/); });
    };
    await run("save refused in the Node's words", { mailboxId: "mbx_test" },
      put(() => Response.json({ message: "E_LEGAL_HOLD  this draft is under a legal hold" }, { status: 409 })), closeAfterTyping);
    await run("save refused with no words", { mailboxId: "mbx_test" }, put(() => new Response("", { status: 503 })), closeAfterTyping);
    await run("save answered without a draft", { mailboxId: "mbx_test" }, put(() => Response.json({ draft: null })), closeAfterTyping);
    await run("save never reached the Node", { mailboxId: "mbx_test" }, put(() => Promise.reject(new Error("Failed to fetch"))), closeAfterTyping);

    const saved = (call: Call) => (call.method === "PUT"
      ? Response.json({ draft: { id: "drf_1", to: [], cc: [], bcc: [], subject: "", body: "Hello", updatedAt: "2026-09-26T09:00:00.000Z" } })
      : undefined);
    const discardAfterSaving = async () => {
      await type("Hello");
      await press("Close");
      await press("Discard");
      await screen.findByRole("alert");
    };
    await run("discard refused in the Node's words", { mailboxId: "mbx_test" },
      (call) => saved(call) ?? (call.method === "DELETE" ? Response.json({ message: "E_LEGAL_HOLD  held" }, { status: 409 }) : undefined), discardAfterSaving);
    await run("discard refused with no words", { mailboxId: "mbx_test" },
      (call) => saved(call) ?? (call.method === "DELETE" ? new Response("", { status: 409 }) : undefined), discardAfterSaving);
    await run("discard never reached the Node", { mailboxId: "mbx_test" },
      (call) => saved(call) ?? (call.method === "DELETE" ? Promise.reject(new Error("Failed to fetch")) : undefined), discardAfterSaving);

    const filled: ComposerContext = { mailboxId: "mbx_test", to: "ana@outside.example", subject: "Hi", body: "Hello" };
    const sealIt = async () => {
      await press("Seal and send");
      await screen.findByRole("alert");
    };
    const seal = (answer: () => Promise<Response> | Response) => (call: Call) => (call.path === "/api/sends" && call.method === "POST" ? answer() : undefined);
    await run("seal refused in the Node's words", filled, seal(() => Response.json({ message: "E_BUDGET_EXCEEDED  send.max_recipients=50, asked for 63" }, { status: 422 })), sealIt);
    await run("seal refused with no words", filled, seal(() => Response.json({}, { status: 422 })), sealIt);
    await run("seal never reached the Node", filled, seal(() => Promise.reject(new Error("Failed to fetch"))), sealIt);
    navigation.go = () => Promise.reject(new Error("navigation failed"));
    await run("sealed, and the refresh after it failed", filled, seal(() => Response.json({ id: "snd_1" })), sealIt);
    navigation.go = () => Promise.resolve();

    const withCase: ComposerContext = { ...filled, caseId: "cas_1" };
    await run("the case is held by a colleague", withCase, (call) => (call.path.endsWith("/claim")
      ? Response.json({ error: "held", heldBy: "bob@example.test", heldSince: "2026-09-26T09:00:00.000Z", message: "bob@example.test is answering this since 09:00." }, { status: 409 })
      : undefined), sealIt);
    await run("the claim failed", withCase, (call) => (call.path.endsWith("/claim") ? new Response("", { status: 503 }) : undefined), sealIt);

    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/composer.failures.en.txt");
  });
});

describe("the times the dock and the drafts list show", () => {
  const instants = ["2026-09-26T09:00:00.000Z", "2026-01-05T23:59:59.000Z"];

  // English formats exactly as the screens did before (the browser's default locale); the goldens leave times out.
  it("formats each as the screen did before, for an English viewer", () => {
    for (const at of instants) {
      expect(format.clock(at)).toBe(new Date(at).toLocaleTimeString(undefined, { hour12: false }));
      expect(format.dateTime(at)).toBe(new Date(at).toLocaleString());
      expect(format.mediumDateTime(at)).toBe(new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    }
  });
});

/**
 * This machine's zone as the quote line names it, `GMT+08:00`, worked out without `Intl`. At a zero offset some ICU
 * builds print a bare `GMT`, so either form is accepted there; a pattern, to be matched rather than compared.
 */
function zone(at: string): string {
  const minutes = -new Date(at).getTimezoneOffset();
  const abs = Math.abs(minutes);
  const offset = `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return minutes === 0 ? "GMT(?:\\+00:00)?" : `GMT\\${offset}`;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

describe("what a reply writes into the mail", () => {
  const at = "2026-09-26T09:00:00.000Z";

  it("keeps Re: and Fwd: in English, and does not double a Chinese client's own prefix", () => {
    expect(replySubject("Invoice")).toBe("Re: Invoice");
    expect(replySubject("RE: Invoice")).toBe("RE: Invoice");
    expect(replySubject("答复：发票")).toBe("答复：发票");
    expect(forwardSubject("FW: Invoice")).toBe("FW: Invoice");
    expect(forwardSubject("转发:报价")).toBe("转发:报价");
    expect(forwardSubject("报价")).toBe("Fwd: 报价");
  });

  it("dates the quote line with its offset, in English", () => {
    expect(quoteLine(at, "alice@outside.example")).toMatch(
      new RegExp(`^On ${escaped(format.fullTime(at))} ${zone(at)}, alice@outside\\.example wrote:$`),
    );
  });

  describe("in the author's language", () => {
    beforeAll(() => {
      install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    });
    afterAll(() => {
      install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
    });

    it("writes the quote line in Chinese, the offset after the time rather than inside it, and the prefixes in English", () => {
      expect(quoteLine(at, "alice@outside.example")).toMatch(
        new RegExp(`^\\d{4}/\\d{1,2}/\\d{1,2} \\d{2}:\\d{2}:\\d{2} ${zone(at)}，alice@outside\\.example 写道：$`),
      );
      expect(replySubject("发票")).toBe("Re: 发票");
    });
  });
});

describe("the composer in Chinese", () => {
  beforeAll(() => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
  });
  afterAll(() => {
    install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
  });

  it("seals, in the glossary's word", async () => {
    mount({ mailboxId: "mbx_test" });
    await screen.findByText("support@example.test");
    expect(screen.getByRole("region", { name: "新邮件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "定稿并发送" })).toBeTruthy();
    expect(document.getElementById("composer-files-limit")!.textContent).toMatch(/^总计最多 [\d.]+ MB，\d+ 个文件。$/);
  });

  /*
   * Who wrote a failure decides its mark: the Node's words are English and are marked so (WCAG 3.1.2); this
   * interface's own sentence is Chinese and must not be, or a screen reader reads it with an English voice. The
   * shell's `save()` hands the same `Said` on to Settings and Language, which mark it the same way.
   */
  it("marks the Node's words as English and its own fallback as not, on screen and in what save() hands on", async () => {
    const ref = { current: null as ComposerHandle | null };
    let answer = () => Response.json({ message: "E_LEGAL_HOLD  this draft is under a legal hold" }, { status: 409 });
    answerWith((call) => (call.method === "PUT" ? answer() : undefined));
    mount({ mailboxId: "mbx_test" }, ref);
    await screen.findByText("support@example.test");
    await type("你好");

    let said = await act(async () => ref.current!.save());
    expect(said).toEqual({ message: "E_LEGAL_HOLD  this draft is under a legal hold", fromNode: true });
    expect(document.querySelector(".draft-phase span[lang=en]")?.textContent).toBe("E_LEGAL_HOLD  this draft is under a legal hold");

    answer = () => new Response("", { status: 503 });
    await type("你好。");
    said = await act(async () => ref.current!.save());
    expect(said).toEqual({ message: "本节点返回了 503", fromNode: false });
    expect(document.querySelector(".draft-phase")!.textContent).toBe("未保存——本节点返回了 503");
    expect(document.querySelector(".draft-phase span[lang=en]")).toBeNull();
  });
});
