import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { answerWith, reset } from "./session-stub.ts";

/**
 * Settings and `api.ts` in English, byte for byte, as they were before their words moved into the catalog
 * (ADR 46, `docs/i18n.md`). The golden files were written from the screen as it stood before the migration,
 * so a key whose English differs by a letter, a sentence split into fragments that no longer read as one, or
 * an element lost from inside a sentence, shows here as a diff of the served HTML.
 *
 * The api half holds `api.ts`'s own sentences, the ones it says when the Node did not: a failure with no
 * body, a refusal sent as bare `{ error, what, why, fix }`, a browser with no passkeys, a held case with no
 * message, and the descriptions the People, Agents and Matters screens read from its lists.
 */

const clock = vi.hoisted(() => ({ expiresAt: null as number | null }));
vi.mock("/app/session.js", async (original) => ({
  ...(await original<typeof import("./session-stub.ts")>()),
  isSignedIn: () => clock.expiresAt !== null,
  accessExpiresAt: () => clock.expiresAt,
}));
const route = vi.hoisted(() => ({ pathname: "/settings" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Settings } = await import("../../src/client/app/screens/settings.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const api = await import("../../src/client/app/api.ts");

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ShellProvider><Settings /></ShellProvider></QueryClientProvider>);
}

/** The blocks this screen owns: the heading, Account, Session, Appearance and Keyboard (Passkeys and Language are other files'). */
function owned(container: HTMLElement): string {
  const blocks = ["h1", "#settings-account", "#settings-session", "#settings-appearance", "#settings-keyboard"]
    .map((selector) => container.querySelector(selector));
  expect(blocks.every((one) => one !== null), "a block is missing, so this compares less than it says").toBe(true);
  return blocks.map((one) => (one!.tagName === "H1" ? one!.outerHTML : one!.closest("section")!.outerHTML)).join("\n") + "\n";
}

beforeEach(() => {
  reset();
  localStorage.clear();
  clock.expiresAt = null;
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("Settings in English", () => {
  it("renders a person's page as it did before its words moved into the catalog", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    clock.expiresAt = Date.now() + 125_000;
    const { container } = mount();
    await screen.findByText("ana@example.test");
    await expect(owned(container)).toMatchFileSnapshot("./golden/settings.person.en.html");
  });

  it("renders an agent's account line, the unsaved notices and the unreadable notices", async () => {
    answerWith((call) => (call.path === "/api/me"
      ? Response.json({
        signedIn: true, principalId: "agt_test", principalKind: "agent", userId: null, delegatorUserId: "usr_test",
        organizationId: "org_test", email: null,
      })
      : undefined));
    const real = window.localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new DOMException("refused", "SecurityError"); },
      setItem: () => { throw new DOMException("refused", "SecurityError"); },
      removeItem: (key: string) => real.removeItem(key),
      clear: () => real.clear(),
    });
    try {
      const { container } = mount();
      await screen.findByText("agt_test");
      fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Single-key shortcuts" }));
      await expect(owned(container)).toMatchFileSnapshot("./golden/settings.agent-unsaved.en.html");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("api.ts's own sentences in English", () => {
  it("says the status when the Node gave no reason, for a read and for an act", async () => {
    answerWith(() => new Response("", { status: 502 }));
    await expect(api.readExportManifest("exp_1")).rejects.toThrow(/^This Node answered 502 and gave no reason\.$/);
    await expect(api.readExportManifest("exp_1")).rejects.toMatchObject({ fromNode: false });
    expect(await api.liftSuppression("a@b.test", "why")).toEqual({ ok: false, message: "This Node answered 502.", fromNode: false });
    expect(await api.revokeAgent("agt_1")).toEqual({ ok: false, message: "Answered 502.", fromNode: false });
    expect(await api.claimCase("cas_1")).toMatchObject({ kind: "failed", message: "This Node answered 502.", fromNode: false });
  });

  it("lays a bare refusal out in the four-part shape, and names a missing code and holder", async () => {
    answerWith((call) => (call.path.startsWith("/api/suppressions")
      ? Response.json({ error: "unprocessable", what: "the address is not suppressed", why: "nothing to lift", fix: "check the address" }, { status: 422 })
      : Response.json({ heldSince: "2026-09-30T00:00:00.000Z", error: "held" }, { status: 409 })));
    expect(await api.liftSuppression("a@b.test", "why")).toEqual({
      ok: false, message: "unprocessable  the address is not suppressed\n  why      nothing to lift\n  fix      check the address", fromNode: true,
    });
    expect(await api.claimCase("cas_1")).toEqual({
      ok: false, kind: "held", heldBy: "somebody", heldSince: "2026-09-30T00:00:00.000Z", message: "Somebody else is holding this.", fromNode: false,
    });
    answerWith(() => Response.json({ what: "only what" }, { status: 422 }));
    expect(await api.liftSuppression("a@b.test", "why")).toEqual({ ok: false, message: "refused  only what\n  why      \n  fix      ", fromNode: true });
  });

  it("says who wrote a refusal's words: the Node when its body carried them, this interface otherwise", async () => {
    answerWith(() => Response.json({ error: "E_X", message: "The Node said no." }, { status: 409 }));
    expect(await api.liftSuppression("a@b.test", "why")).toEqual({ ok: false, message: "The Node said no.", fromNode: true });
    await expect(api.readExportManifest("exp_1")).rejects.toMatchObject({ message: "The Node said no.", fromNode: true });
    expect(await api.claimCase("cas_1")).toMatchObject({ kind: "failed", message: "The Node said no.", fromNode: true });
  });

  it("says a revocation with no body was revoked", async () => {
    answerWith(() => new Response("", { status: 200 }));
    expect(await api.revokeAgent("agt_1")).toEqual({ ok: true, message: "Revoked.", fromNode: false });
  });

  it("says a browser without passkeys has none, before asking the Node anything", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    try {
      expect(await api.registerPasskey("laptop")).toEqual({ ok: false, message: "This browser has no passkey support.", fromNode: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says no passkey was created when the prompt is cancelled or comes back empty", async () => {
    answerWith(() => Response.json({ publicKey: { challenge: "AAAA", user: { id: "usr_test", name: "a", displayName: "a" } } }));
    vi.stubGlobal("PublicKeyCredential", class {});
    const create = vi.fn<() => Promise<Credential | null>>().mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"))
      .mockResolvedValueOnce(null);
    vi.stubGlobal("navigator", { ...navigator, credentials: { create } });
    try {
      expect(await api.registerPasskey("laptop")).toEqual({ ok: false, message: "No passkey was created.", fromNode: false });
      expect(await api.registerPasskey("laptop")).toEqual({ ok: false, message: "No passkey was created.", fromNode: false });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails a withdrawal read on an entry that names no person, in words", async () => {
    answerWith((call) => (call.path.startsWith("/api/audit")
      ? Response.json({ entries: [{ id: "aud_1", subject: null, detail: "{}" }], truncated: false })
      : undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe() {
      const read = api.useWithdrawals(true);
      return <p>{read.isError ? read.error.message : "pending"}</p>;
    }
    render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    await waitFor(() => { expect(screen.getByText(/^The access\.revoked entry/).textContent).toBe("The access.revoked entry aud_1 names no person or no object: {}"); });
  });

  it("describes every grantable relation, agent relation and matter type as before", () => {
    expect(api.GRANTABLE_RELATIONS.map((entry) => [entry.relation, entry.object, entry.what])).toEqual([
      ["mailbox.metadata.read", "mailbox", "See that mail exists — senders, subjects, when. Not the message itself."],
      ["mailbox.content.read", "mailbox", "Read the messages."],
      ["send.propose", "mailbox", "Write and send from this mailbox, and claim its cases."],
      ["approval.decide", "mailbox", "Decide approvals for its mail. Never their own."],
      ["message.export", "mailbox", "Take a copy of a message out of the Node."],
      ["ediscovery.export", "mailbox", "Run a bulk export against a matter."],
      ["org.admin", "organization", "Administer the organization: rules, Butlers, access, holds."],
    ]);
    expect(api.AGENT_RELATIONS.map((entry) => [entry.relation, entry.says, entry.reachesContent])).toEqual([
      ["mailbox.metadata.read", "See that mail exists — senders, subjects, when. Not the message itself.", false],
      ["mailbox.content.read", "Read the messages themselves, including the original bytes.", true],
      ["send.propose", "Draft and propose mail from this mailbox. Sealing a send is withheld from every machine.", false],
      ["message.export", "Take copies of individual messages out of this mailbox.", true],
    ]);
    expect(api.MATTER_TYPES.map((entry) => [entry.type, entry.what])).toEqual([
      ["legal_hold", "Preserving mail for a legal obligation."],
      ["security_incident", "Investigating a compromise or a misuse of an account."],
      ["departure_handover", "Passing on the work of somebody who has left."],
      ["regulatory_request", "Answering a regulator."],
    ]);
  });

  it("reads those descriptions when they are shown, so they follow the installed table rather than the one at import", () => {
    const zh = { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app };
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, zh);
    try {
      expect(api.GRANTABLE_RELATIONS[0].what).toBe(zh["api.grant.mailbox.metadata.read"]);
      expect(api.AGENT_RELATIONS[1].says).toBe(zh["api.agent.mailbox.content.read"]);
      expect(api.MATTER_TYPES[0].what).toBe(zh["api.matter.legal_hold"]);
    } finally {
      install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
    }
  });
});
