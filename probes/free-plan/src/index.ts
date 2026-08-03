/**
 * Probe for #19: is a free-plan Node a usable evaluation tier?
 *
 * Two questions:
 *   1. Does inbound Email Routing to a Worker work on the free plan?
 *   2. When sending is attempted, what exactly happens — and does the failure
 *      name the plan, or is it an opaque error? §5C forbids claiming premature
 *      success and requires honest failure states.
 */
interface Env {
  CATALOG: D1Database;
  OUTBOUND: { send(message: unknown): Promise<void> };
}

export default {
  /** Inbound: Email Routing invokes this with the real message. */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = new Response(message.raw);
    const bytes = (await raw.arrayBuffer()).byteLength;
    await env.CATALOG.prepare(
      `INSERT INTO received (id, from_addr, to_addr, subject, raw_bytes, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        message.from,
        message.to,
        message.headers.get("subject") ?? "(none)",
        bytes,
        new Date().toISOString(),
      )
      .run();
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // What arrived?
    if (url.pathname === "/received") {
      const rows = await env.CATALOG.prepare(
        "SELECT from_addr, to_addr, subject, raw_bytes, at FROM received ORDER BY at DESC LIMIT 10",
      ).all();
      return Response.json({ count: rows.results.length, messages: rows.results });
    }

    // Attempt an outbound send and report the failure verbatim.
    if (url.pathname === "/try-send") {
      const to = url.searchParams.get("to") ?? "nobody@example.com";
      try {
        const { EmailMessage } = await import("cloudflare:email");
        const msg = new EmailMessage(
          "mailda-test@straits-ai.com",
          to,
          `From: mailda-test@straits-ai.com\r\nTo: ${to}\r\nSubject: free-plan send probe\r\nMessage-ID: <${crypto.randomUUID()}@straits-ai.com>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nprobe\r\n`,
        );
        await env.OUTBOUND.send(msg);
        return Response.json({ sent: true, note: "send succeeded — free plan does NOT block sending" });
      } catch (error) {
        return Response.json({
          sent: false,
          errorName: (error as Error).name,
          errorMessage: (error as Error).message,
          // The whole point: does the message name the plan, or is it opaque?
          namesThePlan: /plan|paid|upgrade|subscription|entitle/i.test((error as Error).message),
        });
      }
    }

    return Response.json({ probe: "free-plan", endpoints: ["/received", "/try-send?to=..."] });
  },
};
