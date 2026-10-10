# @mailda/sdk

A typed client for a [Mailda](https://mailda.site) Node: the mail system that runs in your own Cloudflare account.
Every method is generated from the Node's route contract (`@mailda/contract`), and every response is validated
against it, so a field you read is a field the Node returned.

```sh
npm install @mailda/sdk
```

```ts
import { createClient, MaildaError } from "@mailda/sdk";

const mailda = createClient({
  origin: "https://mail.example.com",
  // An agent token, minted on the Node's Agents screen under a named person. It can never do more than they can.
  headers: { authorization: `Bearer ${process.env.MAILDA_TOKEN}` },
});

const page = await mailda.getMessages({ q: "invoice" });
for (const message of page.messages) console.log(message.subject);

try {
  await mailda.getButlers();
} catch (error) {
  // A refusal carries a stable code, and a message saying what happened, why, and what would change it.
  if (error instanceof MaildaError) console.error(error.code, error.message);
}
```

The method names are the same in the SDK, the Node's MCP server (`POST /mcp`), the Agent Skill and the CLI
(`mailda api <method>`). What an agent token reaches is the ceiling pinned when it was minted; sealing a send,
approving, publishing a Butler and anything else that needs a person are not available to a machine at all.

Responses are validated by default. `validate: false` is for one case: a client talking to a newer Node that has
added fields, during a rolling upgrade.

Runs on Node 22 or later, or any runtime with `fetch`. Apache-2.0. Source:
[github.com/Straits-AI/mailda](https://github.com/Straits-AI/mailda/tree/main/packages/sdk).
