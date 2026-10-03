/**
 * The landing page's words, one table per locale: the Node's rule (docs/i18n.md, ADR 46) applied to the site.
 * English is the source; zh-Hans uses the glossary's words (`apps/node/worker/src/i18n/glossary.ts`) and the
 * register in docs/i18n.md: 你, full-width punctuation, one space between Han and Latin. Identifiers are not words
 * and are not here: check ids, file names, paths, the install command and `mailda doctor` stay in
 * `apps/site/src/components/Landing.astro`.
 *
 * An identifier inside a sentence is written in backticks and drawn as <code> (where the component draws a value
 * through `words()`), so a Chinese sentence never shows one bare (docs/i18n.md, Register).
 *
 * `null` means the locale draws no such element: English has no secondary mark in the lockup and no heading
 * over the README's rows, which are already in its own language. zh-Hans has both.
 */
const en = {
  "page.title": "Mailda, in your Cloudflare account",
  "page.description": "Open-source, customer-owned mail operations: shared inboxes, a queue, policies, Butlers and a governance ledger, deployed into your own Cloudflare account. No Mailda service to depend on.",
  "page.ogTitle": "Mailda",
  "page.ogDescription": "Shared inboxes that know who replied. Runs entirely in your own Cloudflare account.",
  "brand": "Mailda",
  "brand.secondary": null,
  "nav.label": "Site",
  "nav.docs": "Docs",
  "nav.receipts": "Receipts",
  "switch.label": "Language",
  "hero.title": "Shared inboxes that know who replied.",
  "lede.before": "Mailda turns an email address into governed work. Who is answering, whether anybody has, what a rule held back and why. It runs in ",
  "lede.strong": "your own Cloudflare account",
  "lede.after": ", so you own the domain, the messages, the keys and the bill. There is no Mailda service to depend on, no licence server, no telemetry. Disconnect us and nothing stops working.",
  "owner.label": "For the owner",
  "owner.before": "Workers Paid is the one thing it needs: ",
  "owner.strong": "$5 a month",
  "owner.after": ", 3,000 emails included, then $0.35 per thousand. A twenty-person team sending ten thousand a month pays about $7.45. Inbound mail is unlimited. Not for newsletters; not for Outlook. Open source, Apache-2.0.",
  "action.install": "Install it",
  "action.ai": "Put it in your AI",
  "report.verdict": "functional alpha",
  "report.about": "what is built, what is thin, and the page that holds each claim to account",
  "ok.install": "One command into your own Cloudflare account: it signs you in, deploys, claims the Node in the same terminal, and with that one sign-in sets up receiving, sending and delivery outcomes, so the Node receives when it ends. No dashboard, no API token, no OAuth client. Drilled on a clean account; a second Node in the same account is a name, and updating is one command too.",
  "ok.receiving": "Shared inboxes with a queue: claim, hand over, close, a first-response clock per mailbox. Threads, labels, read state, archive and trash (restorable), search over subjects, senders and bodies.",
  "ok.mail_security": "The receiving server's SPF/DKIM/DMARC verdict on every message; attachments judged by name and magic bytes; links judged against what they say and your own domains; quarantine and suppression, both per mailbox. No model.",
  "ok.sending": "Every send is sealed to a manifest first, then held for fifteen seconds, then dispatched. Policies, approvals with two people, domain pauses, rate breakers, a suppression list the provider's own bounces build.",
  "ok.butlers": "Programs that act on mail: deterministic, refused at publication if they cannot afford to run, paused if they loop, released by a person before anything leaves. The llm.* node types are declared and refused.",
  "ok.your_ai": "A contract-generated SDK, an agent Skill and an MCP server, every one derived from the same route registry. Agents hold a pinned ceiling of capabilities and an org.admin can never be minted.",
  "ok.governance": "An audit trail nothing trims, matters, legal holds two people lift, supervised reads that leave a record, e-discovery exports approved before they run.",
  "ok.custody": "Evidence sealed under keys only your Node holds, escrowed to ten recovery codes; a backup you can verify offline; a restore drilled three times, once through to receiving mail.",
  "gaps.heading": null,
  "receipts.says": "Every limit, cost and timing in the product has a receipt saying how it was measured and when it goes stale. The build refuses a constant without one.",
  "foot.before": "The warn rows are the README's own words. A vendor's page would leave them off.",
  "foot.link": "Read the whole status",
  "foot.after": " before you rely on any of this.",
  "install.title": "One command, one afternoon",
  "install.copyLabel": "Copy the install command",
  "install.copy": "copy",
  "install.copied": "copied",
  "install.selectIt": "select it",
  "install.about": "It signs you in to Cloudflare, deploys into your account, claims the Node in the same terminal, asks which domain it should receive at, and with that same sign-in enables routing, onboards sending and subscribes delivery outcomes, reading each back and refusing if a record is not there. The Node receives when the command ends. No dashboard, no API token, no OAuth client. Open the Node: until it has an address and mail routed to it, it shows the next step and the command that does it, and only then the inbox. A hostname of your own is one more question, attached by the deploy. A credential of the Node's own, one API token pasted on Setup, is optional and only for changing that setup from the browser later. If you would rather arrange the account by hand, the dashboard path is written down too.",
  "install.settings": "Every setting it needs, in one page.",
  "update.before": "Later, in the same directory, ",
  "update.after": " pulls the release, backs the Node up, says what its schema will do, and redeploys through the canary. No git command is yours to type, including for a Node the deploy button made.",
  "values.label": "What the product is built to be",
  "value.intelligent": "Intelligent.",
  "value.intelligent.says": " Your app in your AI, never AI in your app.",
  "value.reliable": "Reliable.",
  "value.reliable.says": " Every assertion can fail. Every number has a receipt.",
  "value.flowing": "Flowing.",
  "value.flowing.says": " Mail arrives, gets filed, gets answered, and leaves a record.",
  "value.helpful": "Helpful.",
  "value.helpful.says": " A refusal names the problem, the reason and the remedy.",
  "footer.decisions": "how decisions get made",
  "footer.security": "security",
};

export type Words = { readonly [K in keyof typeof en]: string | null };

const zhHans: Words = {
  "page.title": "淼达，在你的 Cloudflare 账户里",
  "page.description": "开源、归客户所有的邮件运营系统：共享收件箱、队列、规则、管家和治理台账，部署在你自己的 Cloudflare 账户里。没有需要依赖的淼达服务。",
  "page.ogTitle": "淼达",
  "page.ogDescription": "知道谁回复了的共享收件箱。完全运行在你自己的 Cloudflare 账户里。",
  "brand": "淼达",
  "brand.secondary": "Mailda",
  "nav.label": "站点",
  "nav.docs": "文档",
  "nav.receipts": "测量记录",
  "switch.label": "语言",
  "hero.title": "共享收件箱，知道谁回复了。",
  "lede.before": "淼达把一个邮件地址变成有人负责、有据可查的工作：谁在回复，有没有人回复过，哪条规则扣下了什么、为什么。它运行在",
  "lede.strong": "你自己的 Cloudflare 账户",
  "lede.after": "里，域名、邮件、密钥和账单都归你。没有需要依赖的淼达服务，没有许可证服务器，没有遥测。与我们断开，一切照常运行。",
  "owner.label": "写给所有者",
  "owner.before": "它只需要 Workers Paid 套餐：",
  "owner.strong": "每月 5 美元",
  "owner.after": "，含 3,000 封邮件，超出后每千封 0.35 美元。一个二十人的团队每月发一万封，约付 7.45 美元。收信不限量。不适合群发通讯，也不面向 Outlook。开源，Apache-2.0 许可。",
  "action.install": "安装",
  "action.ai": "放进你的 AI",
  "report.verdict": "可运行的 alpha 版",
  "report.about": "已经建成的、仍然薄弱的，以及为每条说法负责的那一页",
  "ok.install": "一条命令装进你自己的 Cloudflare 账户：它帮你登录、部署，在同一个终端里认领节点，并用这一次登录配置好收信、发信和投递结果，命令结束时节点已在接收。不用控制台，不用 API 令牌，不用 OAuth 客户端。已在全新账户上演练；同一账户里的第二个节点只是一个名字，更新也只要一条命令。",
  "ok.receiving": "带队列的共享收件箱：认领、转交、关闭，每个邮箱一个首次回复计时。会话、标签、已读状态、归档和回收站（可恢复），可搜索主题、发件人和正文。",
  "ok.mail_security": "每封邮件都带有接收服务器的 SPF/DKIM/DMARC 判定；附件按文件名和魔数判断；链接对照其显示的文字和你自己的域名判断；隔离和抑制，都按邮箱设置。不用模型。",
  "ok.sending": "每次发送先定稿为一份清单，再暂留十五秒，然后移交给邮件服务商。规则、需两人的审批、域名暂停、速率熔断器，以及由服务商自己的退信建立的抑制列表。",
  "ok.butlers": "管家是作用于邮件的程序：确定性执行；运行预算不够的，发布时即被拒绝；出现循环就暂停；任何邮件离开之前都要由人放行。`llm.*` 步骤类型已声明，并被拒绝。",
  "ok.your_ai": "由契约生成的 SDK、Agent Skill 和 MCP 服务器，全部来自同一份路由注册表。代理持有固定的能力上限，永远无法签发 `org.admin`。",
  "ok.governance": "任何东西都不会删减的审计记录、事项、需两人才能解除的法律保全、留下记录的受监督查阅、执行前须经批准的电子取证导出。",
  "ok.custody": "证据用只有你的节点持有的密钥加密，密钥恢复副本由十个恢复码打开；备份可以离线验证；恢复已演练三次，其中一次一直走到接收邮件。",
  "gaps.heading": "以下 `warn` 行是仓库 README 自己的话，保留英文原文。",
  "receipts.says": "产品里的每个限额、成本和耗时都有一份测量记录，写明它如何测得、何时过时。缺少测量记录的常量，构建会拒绝。",
  "foot.before": "`warn` 行是 README 自己的话。厂商的页面会把它们删掉。",
  "foot.link": "先读完整的状态说明",
  "foot.after": "，再依赖这里的任何内容。",
  "install.title": "一条命令，一个下午",
  "install.copyLabel": "复制安装命令",
  "install.copy": "复制",
  "install.copied": "已复制",
  "install.selectIt": "请手动选中",
  "install.about": "它帮你登录 Cloudflare，部署到你的账户，在同一个终端里认领节点，询问应在哪个域名收信，并用同一次登录启用路由、为发信接入域名、订阅投递结果，每一项都读回核对，缺少记录就拒绝继续。命令结束时，节点已在接收。不用控制台，不用 API 令牌，不用 OAuth 客户端。打开节点：在它有了地址、邮件路由到它之前，它显示下一步和完成这一步的命令，之后才是收件箱。使用你自己的主机名只需再回答一个问题，由部署来绑定。节点自己的凭据（在配置页粘贴一个 API 令牌）是可选的，只用于以后在浏览器里修改这些配置。如果你更想手动安排账户，控制台里的做法也写下来了。",
  "install.settings": "它需要的每项设置，都在一页里。",
  "update.before": "之后，在同一个目录里运行 ",
  "update.after": "，它会拉取新版本、备份节点、说明数据库结构将有什么变化，然后经由金丝雀版本重新部署。你不需要输入任何 `git` 命令，用部署按钮创建的节点也一样。",
  "values.label": "这个产品要成为什么",
  "value.intelligent": "智能。",
  "value.intelligent.says": "让你的 AI 用上你的应用，而不是往应用里塞 AI。",
  "value.reliable": "可靠。",
  "value.reliable.says": "每条断言都能失败。每个数字都有测量记录。",
  "value.flowing": "顺畅。",
  "value.flowing.says": "邮件到达、归类、得到回复，并留下记录。",
  "value.helpful": "有用。",
  "value.helpful.says": "每次拒绝都说出问题、原因和补救办法。",
  "footer.decisions": "决策方式",
  "footer.security": "安全",
};

export type SiteLocale = "en" | "zh-Hans";
/**
 * Each landing page, by locale: its path and the language's own name for itself, the endonyms the Node's switch
 * shows (`apps/node/worker/src/i18n/locales.ts`). The docs follow the same paths through Starlight's locales
 * (`apps/site/astro.config.mjs`).
 */
export const SITE_LOCALES: ReadonlyArray<{ readonly tag: SiteLocale; readonly path: string; readonly endonym: string }> = [
  { tag: "en", path: "/", endonym: "English" },
  { tag: "zh-Hans", path: "/zh-cn/", endonym: "简体中文" },
];
export const WORDS: Readonly<Record<SiteLocale, Words>> = { en, "zh-Hans": zhHans };

// `astro build` does not type-check, so the type above alone would let a table missing a key ship with a hole in
// the page. The same rule, checked where the build runs: every table has exactly English's keys, and no value is
// empty (an element a locale does not draw is `null`, said on purpose).
for (const [locale, words] of Object.entries(WORDS)) {
  const keys = Object.keys(words);
  for (const key of Object.keys(en)) {
    if (!keys.includes(key)) throw new Error(`landing-words: ${locale} has no "${key}"`);
    if ((words as Record<string, string | null>)[key] === "") throw new Error(`landing-words: ${locale} "${key}" is empty`);
  }
  for (const key of keys) if (!(key in en)) throw new Error(`landing-words: ${locale} has "${key}", which English does not`);
}
