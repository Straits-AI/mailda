import { beforeAll, describe, expect, it, vi } from "vitest";

import { CATALOGS } from "../../src/i18n/catalog.ts";
import {
  CLAIM_REFUSALS, JOIN_REFUSALS, LOGIN_REFUSALS, PASSKEY_REFUSALS, UNKNOWN, answer, app, boot, claimScreen, joinScreen,
  passkey, refused, route, session, signInScreen, strip, until, withPasskeys,
} from "./preauth-driver.ts";

/**
 * The pages before sign-in under Simplified Chinese (ADR 46, layer 3), reached as a reviewer reaches them: the
 * address asks for it (`?locale=zh-Hans`, the review flag) before the script boots, which reaches it whatever the
 * browser asks for. A Chinese browser reaching it without asking is `locale-boot.test.tsx`. The words are the catalog's;
 * what is held here is how they reach the page: the lockup, the switch, and a refusal's headline beside the Node's
 * English, marked.
 */

vi.mock("./session-stub.ts", async (original) => (await import("./preauth-driver.ts")).controlled(await original()));

const zh = CATALOGS["zh-Hans"].preauth;
let unreachable = "";

beforeAll(async () => {
  history.replaceState(null, "", "/?locale=zh-Hans");
  unreachable = await boot();
});

/** The texts of a notice's parts: the headline (a text node), and each element as `<lang>text`. */
function said(notice: Element): string[] {
  return [...notice.childNodes].flatMap((node) => node instanceof Element
    ? node.tagName === "BR" ? [] : [`<${node.getAttribute("lang") ?? ""}>${node.textContent}`]
    : [node.textContent ?? ""]);
}

/** Every refusal a form can show, by name, each as `said()` reads it. */
async function refusals(table: Record<string, [number, object]>, path: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [name, [status, body]] of Object.entries(table)) {
    await refused(path, () => Response.json(body, { status }));
    out[name] = said(app().querySelector(".errors .notice")!);
  }
  return out;
}

describe("the pages before sign-in, in Simplified Chinese", () => {
  it("names the page in it, and shows the lockup: 淼达, then Mailda marked as English", () => {
    expect(document.documentElement.lang).toBe("zh-Hans");
    expect(document.title).toBe("淼达");
    const marks = [...document.querySelectorAll(".rack .wordmark span")].map((span) => [span.getAttribute("lang"), span.textContent]);
    expect(marks).toEqual([[null, "淼达"], ["en", "Mailda"]]);
  });

  it("says a Node that does not answer in Chinese, the browser's reason marked as English", () => {
    expect(unreachable).toContain("无法连接本节点：");
    expect(unreachable).toContain('<span lang="en">Failed to fetch</span>');
  });

  it("offers a switch back to English, each language in its own name, that reloads with the address's flag", async () => {
    await claimScreen();
    const select = strip().querySelector("select")!;
    expect(select.getAttribute("aria-label")).toBe("语言");
    expect([...select.options].map((option) => [option.value, option.lang, option.textContent])).toEqual([
      ["en", "en", "English"], ["zh-Hans", "zh-Hans", "简体中文"],
    ]);
    expect(select.value).toBe("zh-Hans");

    const assign = vi.spyOn(location, "assign").mockImplementation(() => undefined);
    select.value = "en";
    select.dispatchEvent(new Event("change"));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(new URL(String(assign.mock.calls[0]![0])).searchParams.get("locale")).toBe("en");
    assign.mockRestore();
    select.value = "zh-Hans";
  });

  it("keeps the switch it drew when the strip is redrawn, so a redraw never takes it from under somebody", async () => {
    const before = strip().querySelector("select");
    await signInScreen();
    expect(strip().querySelector("select")).toBe(before);
  });

  it("words the strip in Chinese", async () => {
    await claimScreen();
    expect(strip().textContent).toContain(zh["preauth.status.unclaimed"]);
    session.signedIn = true;
    session.expiresAt = Date.now() + 125_500;
    session.listener!({ type: "refreshed" });
    expect(strip().textContent).toContain("登录会话 · 已续期");
    answer("/health", () => Response.json({ claimed: false, outboxPending: 0 }));
    await route();
    expect(strip().textContent).toContain("登录会话 · 正在续期");
    session.signedIn = false;
  });

  it("words the claim in Chinese", async () => {
    await claimScreen();
    expect(app().querySelector("h1")?.textContent).toBe("本节点等待你认领。");
    expect(app().querySelector("label[for=secret] span")?.textContent).toBe("认领码");
    expect(app().querySelector("button[type=submit]")?.textContent).toBe("认领本节点");
  });

  it("puts each claim refusal's headline before the Node's English, marked; an unlisted code is the Node's alone", async () => {
    await claimScreen();
    const got = await refusals(CLAIM_REFUSALS, "/api/claim");
    expect(got["already_claimed"]).toEqual([zh["preauth.refusal.already_claimed"], `<en>${(CLAIM_REFUSALS["already_claimed"]![1] as { message: string }).message}`]);
    expect(got["weak_password"]?.[0]).toBe("密码太短。");
    expect(got["weak_password"]?.[1]).toMatch(/^<en>E_PASSWORD_TOO_SHORT/);
    expect(got["cross_site"]?.[0]).toBe(zh["preauth.refusal.E_CROSS_SITE_REQUEST"]);
    expect(got["unknown"]).toEqual([`<en>${UNKNOWN.message}`]);
    expect(got["silent"]).toEqual(["认领失败。"]);
  });

  it("does the same for sign-in, the passkey and the invitation", async () => {
    await signInScreen();
    const login = await refusals(LOGIN_REFUSALS, "/api/auth/login");
    expect(login["invalid_credentials"]).toEqual(["邮件地址和密码不匹配。", "<en>That email and password do not match."]);
    expect(login["locked_out"]).toEqual(["登录失败次数过多。", "<en>Too many failed sign-in attempts. Try again in 5 minute(s)."]);
    expect(login["silent"]).toEqual(["登录失败。"]);

    await joinScreen();
    const join = await refusals(JOIN_REFUSALS, "/api/invitations/redeem");
    expect(join["E_INVITATION_UNUSABLE"]?.[0]).toBe("该邀请无法使用。");
    expect(join["E_INVITATION_UNUSABLE"]?.[1]).toMatch(/^<en>E_INVITATION_UNUSABLE/);

    await signInScreen();
    withPasskeys();
    answer("/api/auth/passkeys/challenge", () => Response.json({ publicKey: { challenge: "AQID", rpId: "localhost" } }));
    const [status, body] = PASSKEY_REFUSALS["E_PASSKEY_REJECTED"]!;
    answer("/api/auth/passkeys/verify", () => Response.json(body, { status }));
    await passkey();
    const notice = said(app().querySelector(".errors .notice")!);
    expect(notice[0]).toBe("该通行密钥未被接受。");
    expect(notice[1]).toMatch(/^<en>E_PASSKEY_REJECTED/);
  });

  it("says why the last session ended in Chinese", async () => {
    session.listener!({ type: "signed-out", reason: "reuse_detected", message: "This session was signed out because its token was used twice. Sign in again." });
    expect(said(app().querySelector(".errors .notice")!)).toEqual([
      zh["preauth.refusal.reuse_detected"], "<en>This session was signed out because its token was used twice. Sign in again.",
    ]);
    session.listener!({ type: "signed-out", reason: "refresh_did_not_help" });
    expect(said(app().querySelector(".errors .notice")!)).toEqual(["你的登录会话无法续期。请重新登录。"]);
    await until(() => app().querySelector("h1")?.textContent === "知道是谁回复的共享收件箱。", "sign-in was not in Chinese");
  });
});
