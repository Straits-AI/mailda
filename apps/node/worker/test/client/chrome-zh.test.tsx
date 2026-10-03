import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { answer, answerWith, reset } from "./session-stub.ts";

/**
 * The chrome under zh-Hans (ADR 46), installed as `?locale=zh-Hans` or a Chinese browser installs it.
 *
 * What would render plausibly and be wrong: a palette a Chinese viewer can only search in Chinese characters,
 * because the English labels it used to match are never sent to them (critic L3); the doctor's `refuse`
 * printed as the raw token, or as 停止服务, which asserts an outage the doctor does not know about (critic H3);
 * and the Node's own English in the popover not marked as English for a screen reader (WCAG 3.1.2).
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Notices, Shell, StatusBar } = await import("../../src/client/app/chrome.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const { CommandPalette } = await import("../../src/client/app/ui/palette.tsx");

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeAll(() => {
  install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
});
afterAll(() => {
  install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
});
beforeEach(reset);

describe("the palette in Chinese", () => {
  function typed(words: string): string[] {
    render(<QueryClientProvider client={client()}><ShellProvider><CommandPalette /></ShellProvider></QueryClientProvider>);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox", { name: "前往或执行" }), { target: { value: words } });
    return screen.getAllByRole("option").map((option) => option.querySelector("span")!.textContent!);
  }

  it("finds a route by its pinyin initials", () => {
    expect(typed("sjx")).toEqual(["前往收件箱", "在邮件中搜索“sjx”"]);
  });

  it("finds a route by its English word, which the Chinese label does not contain", () => {
    expect(typed("outbox")).toEqual(["前往发件箱", "在邮件中搜索“outbox”"]);
  });

  it("finds a route by its Chinese label", () => {
    expect(typed("草稿")).toEqual(["前往草稿", "在邮件中搜索“草稿”"]);
  });
});

describe("the status bar in Chinese", () => {
  it("names the doctor's refuse as not passed, never as the raw token or an outage", async () => {
    answerWith((call) => (call.path === "/api/doctor"
      ? Response.json({ verdict: "refuse", claimed: true, at: "2026-09-26T09:00:00.000Z", findings: [] })
      : undefined));
    render(<QueryClientProvider client={client()}><StatusBar /></QueryClientProvider>);
    const chip = await screen.findByText("未通过");
    expect(chip.className).toBe("state verdict-refuse");
    expect(chip.closest("button")?.textContent).toBe("健康状况：未通过");
  });

  it("puts a failed report's message inside lang=en", async () => {
    answerWith((call) => (call.path === "/api/doctor"
      ? Response.json({ error: "E_X", message: "The doctor could not run." }, { status: 503 })
      : undefined));
    render(<QueryClientProvider client={client()}><StatusBar /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "健康状况：无法读取" }));
    const alert = screen.getByRole("dialog", { name: "健康状况" }).querySelector("[role=alert]")!;
    expect(alert.querySelector("[lang=en]")?.textContent).toBe("The doctor could not run.");
  });
});

describe("a notice in Chinese", () => {
  it("keeps the sentence whole when facts are absent, in the translation's order", async () => {
    answer("/api/notifications", () => ({
      truncated: false,
      notifications: [{
        id: "ntf_1", kind: "supervised_read", subjectId: "sgr_1", mailboxId: null, matterId: null, dueAt: null,
        deliveredAt: null, body: { readerEmail: "legal@example.test", mailboxName: "Support", acts: { queries: 2 } },
      }],
    }));
    render(<QueryClientProvider client={client()}><Notices /></QueryClientProvider>);
    const band = await screen.findByRole("region", { name: "通知" });
    expect(band.querySelector(".notice.told")?.textContent).toBe(
      "legal@example.test 获得了对 Support 的受监督查阅授权，时间为 未记录的时刻 至 未记录的时刻。 "
        + "2 次查询，列出 0 封邮件 · 打开 0 封 · 读取原始邮件 0 封 · 事项：未注明 · 授权 sgr_1",
    );
  });
});

describe("the narrow layout in Chinese", () => {
  it("titles a page no screen matches with the brand's Chinese name", () => {
    (window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } })
      .happyDOM.setViewport({ width: 390, height: 800 });
    route.pathname = "/nowhere";
    render(<QueryClientProvider client={client()}><ShellProvider><Shell /></ShellProvider></QueryClientProvider>);
    expect(document.querySelector(".mobile-title")?.textContent).toBe("淼达");
    route.pathname = "/";
  });
});

/*
 * Who wrote a failure's words decides its mark (`Said` in `api.ts`, `marked()` in `words.tsx`). The Node's English
 * goes inside lang="en"; this interface's own fallback, which is Chinese here, must not, or a screen reader reads
 * Chinese with an English voice (WCAG 3.1.2), the failure the mark exists to prevent.
 */
describe("a failure's words in Chinese, marked by who wrote them", () => {
  it("leaves the interface's own fallback unmarked when the doctor answers with no words", async () => {
    answerWith((call) => (call.path === "/api/doctor" ? Response.json({}, { status: 503 }) : undefined));
    render(<QueryClientProvider client={client()}><StatusBar /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "健康状况：无法读取" }));
    const alert = screen.getByRole("dialog", { name: "健康状况" }).querySelector("[role=alert]")!;
    expect(alert.textContent).toBe("本节点返回了 503，但没有说明原因。");
    expect(alert.querySelector("[lang=en]")).toBeNull();
  });

  it("marks the Node's words on a listing that failed, and leaves the fallback unmarked", async () => {
    const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
    const listing = (body: object) => answerWith((call) =>
      (call.path.startsWith("/api/messages") ? Response.json(body, { status: 500 }) : undefined));
    const mount = () => render(<QueryClientProvider client={client()}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);

    listing({ error: "E_X", message: "The listing could not be read." });
    const view = mount();
    expect((await screen.findByText("The listing could not be read.")).closest("[lang=en]")).not.toBeNull();
    view.unmount();

    reset();
    listing({});
    mount();
    expect((await screen.findByText("本节点返回了 500，但没有说明原因。")).closest("[lang=en]")).toBeNull();
  });

  it("leaves a refused sign-out-everywhere's fallback unmarked, and marks the Node's refusal", async () => {
    const { Settings } = await import("../../src/client/app/screens/settings.tsx");
    const refusing = (body: object) => answerWith((call) =>
      (call.path === "/api/auth/logout-everywhere" ? Response.json(body, { status: 503 }) : undefined));
    const mount = () => render(<QueryClientProvider client={client()}><ShellProvider><Settings /></ShellProvider></QueryClientProvider>);

    refusing({});
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "在所有设备上退出登录" }));
    const fallback = await screen.findByText("本节点返回了 503。");
    expect(fallback.closest("[lang=en]")).toBeNull();
    view.unmount();

    reset();
    refusing({ error: "E_X", message: "The sessions could not be revoked." });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "在所有设备上退出登录" }));
    expect((await screen.findByText("The sessions could not be revoked.")).closest("[lang=en]")).not.toBeNull();
  });
});
