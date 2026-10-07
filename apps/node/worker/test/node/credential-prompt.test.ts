import { afterEach, describe, expect, it } from "vitest";

/**
 * Credentials typed at a prompt are tried at once, and a refusal asks again (7 October 2026). `mailda upgrade`
 * used to ask once and end the whole run on a mistyped password, at the backup step.
 */
const { afterSignIn, askAdministrator, PROMPT_ATTEMPTS } = await import("../../../../../packages/cli/src/credentials.mjs");

const ORIGIN = "https://node.example";

/** A Node that answers each sign-in from a script of statuses, and records what it was asked. */
function node(statuses: Array<number | null>, body: unknown = null) {
  const asked: Array<{ email: string; password: string }> = [];
  const fetchImpl = async (_url: string, init: { body: string }) => {
    asked.push(JSON.parse(init.body));
    const status = asked.length - 1 < statuses.length ? statuses[asked.length - 1] : 401;
    if (status === null) throw new Error("unreachable");
    return new Response(JSON.stringify(body ?? {}), { status });
  };
  return { asked, fetchImpl };
}

/** A person at the prompt: each email line and each password, in order. */
function person(emails: string[], passwords: string[]) {
  const prompts: string[] = [];
  return {
    prompts,
    ask: async (prompt: string) => { prompts.push(prompt); return emails.shift() ?? ""; },
    readSecret: async () => passwords.shift() ?? "",
  };
}

class Failed extends Error {}
const fail = (message: string): never => { throw new Failed(message); };

afterEach(() => { delete process.env.MAILDA_EMAIL; delete process.env.MAILDA_PASSWORD; });

describe("after one sign-in", () => {
  it("accepts a success, asks again on a 401 while tries remain, gives up on the last, stops on a lockout", () => {
    expect(afterSignIn(200, 1)).toBe("accept");
    expect(afterSignIn(401, 1)).toBe("retry");
    expect(afterSignIn(401, PROMPT_ATTEMPTS - 1)).toBe("retry");
    expect(afterSignIn(401, PROMPT_ATTEMPTS)).toBe("give_up");
    expect(afterSignIn(429, 1)).toBe("locked");
    // Not judged: the credentials are kept, and the step that uses them retries such failures itself.
    expect(afterSignIn(null, 1)).toBe("later");
    expect(afterSignIn(500, 1)).toBe("later");
  });

  it("stays well inside the Node's own lockout", async () => {
    const { BUDGETS } = await import("@mailda/budgets");
    expect(PROMPT_ATTEMPTS).toBeLessThan(BUDGETS["auth.max_failed_logins_per_15min"]);
  });
});

describe("asking for an administrator", () => {
  it("asks again after a wrong password, offers the email it had, and goes on with the right one", async () => {
    const nodeAnswers = node([401, 200]);
    const at = person(["admin@acme.example", ""], ["wrong", "right"]);
    const lines: string[] = [];
    const got = await askAdministrator(ORIGIN, { ...at, fail, out: (text: string) => lines.push(text), fetchImpl: nodeAnswers.fetchImpl });
    expect(got).toEqual({ email: "admin@acme.example", password: "right" });
    expect(nodeAnswers.asked).toEqual([
      { email: "admin@acme.example", password: "wrong" },
      { email: "admin@acme.example", password: "right" },
    ]);
    expect(at.prompts).toEqual(["   email: ", "   email [admin@acme.example]: "]);
    expect(lines.join("")).toContain(`refused that email and password (try 1 of ${PROMPT_ATTEMPTS})`);
    expect(process.env.MAILDA_EMAIL).toBe("admin@acme.example");
    expect(process.env.MAILDA_PASSWORD).toBe("right");
  });

  it("lets the address be corrected on a retry", async () => {
    const nodeAnswers = node([401, 200]);
    const at = person(["admin@acme.exmaple", "admin@acme.example"], ["pw", "pw"]);
    await askAdministrator(ORIGIN, { ...at, fail, out: () => {}, fetchImpl: nodeAnswers.fetchImpl });
    expect(nodeAnswers.asked.map((one) => one.email)).toEqual(["admin@acme.exmaple", "admin@acme.example"]);
  });

  it("stops after the last refusal, naming the reset, and sets nothing", async () => {
    const nodeAnswers = node([401, 401, 401, 200]);
    const at = person(["a@acme.example"], ["x", "y", "z", "never asked"]);
    await expect(askAdministrator(ORIGIN, { ...at, fail, out: () => {}, fetchImpl: nodeAnswers.fetchImpl }))
      .rejects.toThrow(new RegExp(`refused the email and password ${PROMPT_ATTEMPTS} times[\\s\\S]*mailda set-password`));
    expect(nodeAnswers.asked).toHaveLength(PROMPT_ATTEMPTS);
    expect(process.env.MAILDA_PASSWORD).toBeUndefined();
  });

  it("stops at once when the Node has locked the address, with the Node's own reason", async () => {
    const nodeAnswers = node([429], { error: "locked_out", message: "Too many failed sign-in attempts. Try again in 5 minutes." });
    const at = person(["a@acme.example"], ["x", "y"]);
    await expect(askAdministrator(ORIGIN, { ...at, fail, out: () => {}, fetchImpl: nodeAnswers.fetchImpl }))
      .rejects.toThrow(/has locked sign-in for a@acme\.example[\s\S]*Try again in 5 minutes/);
    expect(nodeAnswers.asked).toHaveLength(1);
  });

  it("keeps credentials it could not have judged, for the step that retries a Node it cannot reach", async () => {
    const nodeAnswers = node([null]);
    const at = person(["a@acme.example"], ["pw"]);
    expect(await askAdministrator(ORIGIN, { ...at, fail, out: () => {}, fetchImpl: nodeAnswers.fetchImpl }))
      .toEqual({ email: "a@acme.example", password: "pw" });
  });
});
