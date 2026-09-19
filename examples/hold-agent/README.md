# hold-agent

A reference for "the app in your AI": an agent that runs in *your* account, scores new mail against your
own Node's past decisions, and holds what it distrusts through `POST /api/quarantine/:messageId/hold`.
A person releases, and the release is the label the next run learns from.

This is a shape, not a measurement. It has no precision or recall figure because those come from your
corpus. Run it on a mailbox you can afford to have held for an hour, read the queue screen, and decide.

## How it works

1. Mint an agent for the mailbox with the capabilities `mail.read` and `mail.hold` (`POST /api/agents`).
2. Every run reads the page since the last run, and the quarantine list.
3. Each message's subject and first 2,000 characters of body are embedded with `@cf/baai/bge-small-en-v1.5`
   through Workers AI's REST API in your account (`CF_ACCOUNT_ID`, `CF_API_TOKEN` with Workers AI Read).
4. The corpus is your own decisions: messages that were held and never released (positives) and messages
   that were released or answered (negatives). Nearest-neighbour by cosine; the score is the share of the
   five nearest that are positives.
5. Above `THRESHOLD` (default 0.8) the agent holds the message with the reason
   `nearest neighbours: 4 of 5 held` and the score.

## Run

```sh
MAILDA_URL=https://your-node MAILDA_AGENT_TOKEN=... CF_ACCOUNT_ID=... CF_API_TOKEN=... node agent.mjs
```

Nothing here is a Mailda dependency. The Node does not know this exists, which is the point.
