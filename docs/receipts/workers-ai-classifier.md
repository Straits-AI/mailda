---
id: workers-ai-classifier
kind: measured-tripwire
measured_on: 2026-09-17
stale_when: >
  Workers AI lists a Text Classification model trained on spam, phishing or abuse rather than sentiment;
  the embedding model's latency from a Worker (not measured here — these are REST calls from a laptop)
  turns out to differ materially from the figures below; or this Node accumulates a corpus of its own
  decisions large enough to evaluate a nearest-neighbour signal on
values:
  ai.text_classification_models_for_mail: 0
  ai.embedding_dims_bge_small: 384
  ai.embedding_latency_ms_rest_warm: 220
---

# Whether a lightweight edge classifier exists to ship as a policy signal

Row 5 of `docs/mail-security.md` said: *Workers AI text classification in the customer's own account,
milliseconds a message, no data leaving, as an explicit policy signal, off by default, never authority.*
This is the measurement that row asked for before a line of policy code, and the answer is **not yet, and
not with what the platform offers today**.

**Measured** 17 September 2026 against account `1e01…` (the live Node's) over the Workers AI REST API
with the wrangler OAuth token, which carries `ai (write)`.

## The model catalogue

`GET /accounts/{id}/ai/models/search` lists **65** models across ten tasks. Filtered to *Text
Classification* it lists **two**: `@cf/huggingface/distilbert-sst-2-int8` (sentiment, SST-2) and
`@cf/baai/bge-reranker-base` (a query-document reranker). Neither is a spam, phishing or abuse
classifier. Nothing in the catalogue is.

## What the sentiment model says about scam-shaped text

| text | NEGATIVE | POSITIVE |
|:--|--:|--:|
| "URGENT verify your password now or your account is closed" | 0.991 | 0.009 |
| "Hi, attached is the invoice for August as agreed, thanks" | 0.001 | 0.999 |
| "Congratulations you have won a prize, click to claim" | 0.000 | **1.000** |

A prize scam is the most positive text of the three. Sentiment is not a threat signal, and shipping it as
one, even off by default or as a Butler fact, would be a number with a name it does not deserve.

## What would work, and what it needs

The embedding model `@cf/baai/bge-small-en-v1.5` answers in **220–660 ms over REST from a laptop** (three
calls, cold to warm: 659, 322, 221 ms), 384 dimensions. A nearest-neighbour signal, *this message is close
to ones an administrator held, and far from ones released*, is lightweight, deterministic given the
corpus, and its authority would be this Node's own decisions rather than a vendor's training set. That is
the design the quote in the README asks for.

It needs a corpus. The Node records the decisions that would label one (`message.quarantined`,
`message.released`, `message.labelled`) and has recorded them for a day. Nothing to evaluate on yet, so
nothing ships; when there are hundreds of decided messages on a real Node, re-measure precision and
recall here first.

## What is not measured

Latency from **inside a Worker** through an `ai` binding, which is the path a Node would use; a REST call
from a laptop includes the public internet twice. Cost per call under the Workers AI free allowance and
past it. Both belong to the round that has a corpus to justify them.
