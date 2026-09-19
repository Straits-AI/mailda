// A reference hold agent. See README.md. Node 22+, no dependencies.

const NODE = process.env.MAILDA_URL;
const TOKEN = process.env.MAILDA_AGENT_TOKEN;
const CF = { account: process.env.CF_ACCOUNT_ID, token: process.env.CF_API_TOKEN };
const THRESHOLD = Number(process.env.THRESHOLD ?? "0.8");
const K = 5;

for (const [name, value] of Object.entries({ NODE, TOKEN, ...CF })) {
  if (!value) { console.error(`missing ${name}`); process.exit(2); }
}

async function node(method, path, body) {
  const response = await fetch(`${NODE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function embed(texts) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF.account}/ai/run/@cf/baai/bge-small-en-v1.5`,
    { method: "POST", headers: { authorization: `Bearer ${CF.token}` }, body: JSON.stringify({ text: texts }) },
  );
  const body = await response.json();
  if (!body.success) throw new Error(JSON.stringify(body.errors));
  return body.result.data;
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

// A page row's `id` is the receipt id (what the body route takes); `message_id` is the msg_ id the hold takes.
async function textOf(row) {
  const body = await node("GET", `/api/messages/${row.receiptId ?? row.id}/body`).catch(() => null);
  return `${row.subject ?? ""}\n${(body?.text ?? "").slice(0, 2000)}`;
}

// The corpus is the Node's own decisions. Held and still held: positive. Released: negative.
const { quarantined } = await node("GET", "/api/quarantine").catch(() => ({ quarantined: [] }));
const { messages } = await node("GET", "/api/messages?limit=200");
const positives = quarantined;
// Read by a person and left in the queue: a person looked and did not hold it.
const negatives = messages.filter((m) => m.read === 1);
if (positives.length < K) {
  console.log(`corpus too small: ${positives.length} held messages, need ${K}. Hold some by hand first.`);
  process.exit(0);
}
const corpus = [...positives.map((m) => ({ m, held: true })), ...negatives.map((m) => ({ m, held: false }))];
const corpusVectors = await embed(await Promise.all(corpus.map(({ m }) => textOf(m))));

const candidates = messages.filter((m) => m.read === 0 && m.message_id !== null);
const candidateVectors = await embed(await Promise.all(candidates.map(textOf)));

for (const [i, message] of candidates.entries()) {
  const nearest = corpus
    .map((entry, j) => ({ held: entry.held, sim: cosine(candidateVectors[i], corpusVectors[j]) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, K);
  const score = nearest.filter((n) => n.held).length / K;
  if (score < THRESHOLD) continue;
  const reason = `nearest neighbours: ${score * K} of ${K} held`;
  await node("POST", `/api/quarantine/${message.message_id}/hold`, { reason, score });
  console.log(`held ${message.message_id} (${message.subject ?? "no subject"}): ${reason}`);
}
