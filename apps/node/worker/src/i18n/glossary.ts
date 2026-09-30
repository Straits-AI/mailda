import type { Key } from "./catalog.ts";
import type { Locale } from "./locales.ts";

/**
 * The glossary as data (ADR 46): one row per concept, the word each locale uses for it, the words it must not
 * use, and the catalog keys that name it. `test/node/catalog.test.ts` walks these rows and the catalogs; nothing
 * reads source text. Changing a term is one edit here, and the check then goes red on every catalog value
 * still using the old one.
 *
 * A concept is an id, not an English word (AGENTS.md §4): "held" names five concepts and each gets its own
 * row and its own Chinese word. Within a locale, code, UI and docs use the row's one word.
 *
 * ## Status: every row is proposed, and only the owner confirms one
 *
 * A row's `status` is `"proposed"` until the repository's owner confirms that word, and then it becomes
 * `{ confirmedBy, record }`, where `record` links the owner's own written confirmation (a PR review comment
 * or an issue comment). An author, human or agent, never writes a `confirmedBy` for somebody else: the only
 * edit to a row's status is copying that record in. The check cannot tell who typed the field, so **the real
 * gate is the owner's approval of the pull request that carries the edit**, and `docs/i18n.md` says so.
 *
 * What the status gates: a locale that is **not** a preview may not ship a key bound to a proposed row. A
 * preview locale may, because reviewing proposed words in place is what a preview is for, and a preview is
 * never shown to a viewer who did not ask for it (`locales.ts`).
 *
 * ## How the fields are read
 *
 * - `keys`: catalog keys whose value must **equal** the locale's term. Typed as `Key`, so a key that does not
 *   exist is a compile error. Empty for a concept whose screens are not migrated yet; the migrator binds them.
 * - `sentences`: catalog keys whose sentence names the concept, so its value must **contain** the locale's term
 *   and none of the concept's avoided words. For a concept whose English word is not `prose` (it means other
 *   things elsewhere), this is how a sentence is bound to it one key at a time.
 * - `avoid`: phrases this concept's keys must not use, and, for a `prose` concept, any key whose English names
 *   the concept. **Scoped to the concept, never the whole locale** (critic M4): 已取消 is wrong for `withheld`
 *   and right for `cancelled`. The term itself is removed before the check, so a term may contain an avoided
 *   word (服务商拒收 contains 拒收).
 * - `prose`: the English word has one meaning in this product, so any source string that names it (outside
 *   backticks) must use the term in every locale. "Mailda" is prose; "held" is not.
 */
export interface Concept {
  readonly id: string;
  readonly en: string;
  readonly "zh-Hans": string;
  readonly keys: readonly Key[];
  readonly sentences: readonly Key[];
  readonly avoid: { readonly en?: readonly string[]; readonly "zh-Hans"?: readonly string[] };
  readonly prose: boolean;
  readonly status: "proposed" | { readonly confirmedBy: string; readonly record: string };
  /** The meaning the word must keep, when the English alone does not carry it. */
  readonly note?: string;
}

const proposed = "proposed" as const;

/** The eight lookback sentences for an empty Mine, which all say "in a case you hold". */
const LOOKBACK_MINE: readonly Key[] = (["newest", "older"] as const).flatMap((when) => (["counted", "uncounted"] as const)
  .flatMap((counted) => (["any", "filtered"] as const).map((scope) => `inbox.lookback.${when}.${counted}.${scope}.mine` as const)));
const row = (
  id: string, en: string, zh: string, rest: Partial<Pick<Concept, "keys" | "sentences" | "avoid" | "prose" | "note">> = {},
): Concept => ({
  id, en, "zh-Hans": zh, keys: rest.keys ?? [], sentences: rest.sentences ?? [], avoid: rest.avoid ?? {}, prose: rest.prose ?? false,
  status: proposed, ...(rest.note === undefined ? {} : { note: rest.note }),
});

export const CONCEPTS: readonly Concept[] = [
  // Brand and product nouns.
  row("brand", "Mailda", "淼达", {
    keys: ["brand.name"], prose: true, avoid: { "zh-Hans": ["麦达", "迈达", "秒达"] },
    note: "淼达 (Miǎodá) is a homophone of 秒达, 'arrives in seconds', a delivery slogan: never write that, and never pun on 达",
  }),
  row("node", "Node", "节点", { avoid: { "zh-Hans": ["服务器", "实例"] }, note: "one deployment in the customer's own account; 本节点 for 'this Node'" }),
  row("butler", "Butler", "Butler", { avoid: { "zh-Hans": ["机器人", "智能助手"] }, note: "Latin; the first use glossed Butler（自动化流程）. 管家 is the alternative" }),
  row("mailbox", "mailbox", "邮箱", { note: "a storage and access boundary; never used for an address" }),
  row("address", "address", "邮件地址", { avoid: { "zh-Hans": ["邮箱"] } }),
  row("case", "case", "工单", { avoid: { "zh-Hans": ["案件", "案例"] } }),
  row("matter", "Matter", "事项", {
    avoid: { "zh-Hans": ["调查", "案件"] },
    note: "a supervised read, legal hold, departure handover or regulatory request; 调查 would call a routine handover an investigation (critic H3, D9)",
  }),
  row("rules", "Rules", "规则", { avoid: { "zh-Hans": ["策略"] }, note: "the UI word for policy (D1)" }),
  row("approval", "approval", "审批", { avoid: { "zh-Hans": ["同意"] } }),
  row("receipt.ingress", "receipt", "接收记录", { avoid: { "zh-Hans": ["回执", "收据"] } }),
  row("escrow", "escrow", "密钥恢复副本", { avoid: { "zh-Hans": ["托管"] } }),
  row("recovery-codes", "recovery codes", "恢复码", { avoid: { "zh-Hans": ["备用码"] } }),
  row("passkey", "passkey", "通行密钥", { avoid: { "zh-Hans": ["通行证"] } }),
  row("claim", "claim", "认领", { avoid: { "zh-Hans": ["注册", "激活"] } }),
  row("claim-secret", "claim secret", "认领码", { avoid: { "zh-Hans": ["引导密钥"] }, note: "bootstrap, install and claim secret are one concept (D4)" }),
  row("invitation-secret", "invitation secret", "邀请码", { avoid: { "zh-Hans": ["邀请密钥"] } }),
  row("grant", "grant", "授权", { avoid: { "zh-Hans": ["许可"] } }),
  row("provider", "provider", "服务商", { avoid: { "zh-Hans": ["供应商"] } }),
  row("catch-all", "catch-all", "Catch-all 地址", { avoid: { "zh-Hans": ["全部邮件", "转发"] } }),
  row("sponsor", "sponsor", "委托人", { avoid: { "zh-Hans": ["担保人"] } }),
  row("effect", "effect", "外部动作", { avoid: { "zh-Hans": ["效果", "副作用"] } }),
  row("graph-node", "node (Butler graph)", "步骤"),
  row("session", "session", "登录会话"),
  row("settings", "Settings", "设置", { keys: ["route./settings"] }),
  row("setup", "Setup", "配置", { keys: ["route./setup"], avoid: { "zh-Hans": ["设置"] } }),

  // Navigation: each route's name is its own row, bound to its `route.*` key.
  row("route.inbox", "Inbox", "收件箱", { keys: ["route./"] }),
  row("route.queue", "Queue", "队列", { keys: ["route./queue"] }),
  row("route.drafts", "Drafts", "草稿", { keys: ["route./drafts"] }),
  row("route.outbox", "Outbox", "发件箱", { keys: ["route./outbox"], avoid: { "zh-Hans": ["已发送"] }, note: "ADR 39: the outbox never says sent" }),
  row("route.archive", "Archive", "归档", { keys: ["route./archive"], avoid: { "zh-Hans": ["存档", "封存"] } }),
  row("route.trash", "Trash", "废纸篓", { keys: ["route./trash"], avoid: { "zh-Hans": ["删除"] }, note: "ADR 45: nothing a person places is destroyed. 回收站 is the alternative" }),
  row("route.people", "People", "成员", { keys: ["route./people"] }),
  row("route.matters", "Matters", "事项", { keys: ["route./matters"], avoid: { "zh-Hans": ["调查"] } }),
  row("route.approvals", "Approvals", "审批", { keys: ["route./approvals"] }),
  row("route.rules", "Rules", "规则", { keys: ["route./rules"] }),
  row("route.butlers", "Butlers", "Butler", { keys: ["route./butlers"] }),
  row("route.agents", "Agents", "代理", { keys: ["route./agents"], avoid: { "zh-Hans": ["智能体"] }, note: "machine identities; nothing proves one is an AI" }),
  row("route.limits", "Limits", "限额", { keys: ["route./limits"] }),
  row("route.audit", "Audit", "审计", { keys: ["route./audit"] }),
  row("route.log", "Log", "日志", { keys: ["route./log"] }),
  row("route.doctor", "Doctor", "诊断", { keys: ["route./doctor"], avoid: { "zh-Hans": ["医生", "体检"] } }),
  row("automate", "Automate / Automations", "自动化 / 自动化流程", { note: "D2: the group, the row and the tabs are three words in English and must not collapse to one in zh" }),
  row("compose", "Compose", "写邮件", { keys: ["chrome.compose"] }),
  row("palette", "Command palette", "命令面板", { keys: ["palette.label"] }),

  // Health: the doctor's severities. `refuse` means the deploy gate refuses; the Node is still running.
  row("health.refuse", "refuse", "未通过", { keys: ["health.status.refuse"], avoid: { "zh-Hans": ["停止服务", "拒绝服务"] }, note: "critic H3: 停止服务 asserts an outage doctor does not know about" }),
  row("health.degraded", "degraded", "降级", { keys: ["health.status.degraded"], avoid: { "zh-Hans": ["警告"] } }),
  row("health.report", "report", "提示", { keys: ["health.status.report"] }),
  row("outbound", "Outbound", "出站", { sentences: ["health.area.outbound", "health.outbound"], avoid: { "zh-Hans": ["外发"] } }),
  row("refusal.code", "refused", "refused", {
    keys: ["api.refusal.code"],
    note: "stands in the code slot of a bare refusal, under Latin labels, beside the Node's English: Latin in every locale, as the E_ code is",
  }),
  row("connectivity.connected", "Connected", "已连接", { keys: ["chrome.connection.connected"] }),
  row("connectivity.unreachable", "Unreachable", "无法连接", { keys: ["chrome.connection.unreachable"] }),
  row("connectivity.offline", "Offline", "离线", { keys: ["chrome.connection.offline"] }),

  // Submission states (`SendState`, this Node's scale). Each names who said no.
  row("send.held", "held", "暂留", { avoid: { "zh-Hans": ["待发送", "撤回"] } }),
  row("send.awaiting", "awaiting", "待放行", { avoid: { "zh-Hans": ["发送中", "处理中"] } }),
  row("send.cancelled", "cancelled", "已取消", { avoid: { "zh-Hans": ["已撤回"] } }),
  row("send.withheld", "withheld", "扣发", { avoid: { "zh-Hans": ["已取消", "失败", "拒绝"] } }),
  row("send.throttled", "throttled", "限流中", { avoid: { "zh-Hans": ["失败"] } }),
  row("send.refused", "refused", "服务商拒收", {
    avoid: { "zh-Hans": ["拒收", "退信", "失败"] },
    note: "the mail service would not accept it and it never left (critic H3). A bare 拒收 reads as the recipient's server, which is `bounced`",
  }),
  row("send.suppressed", "suppressed", "已抑制", { avoid: { "zh-Hans": ["已屏蔽", "黑名单"] } }),
  row("send.handed_over", "handed over", "已移交", {
    avoid: { en: ["accepted"], "zh-Hans": ["已发送", "发送成功", "已送达", "已投递", "已交付", "受理"] },
    note: "the transport took the bytes. D8: its English note says 'Accepted by the mail service', a delivery word; fix the English with submission vocabulary ('Taken by the mail service', docs/i18n.md D8)",
  }),
  row("send.propose", "propose", "提交", {
    sentences: ["api.agent.send.propose"], avoid: { "zh-Hans": ["提议"] },
    note: "an agent drafts and submits a send intent for a person to seal; 提议 reads as suggesting an email",
  }),
  row("send.outcome_unknown", "outcome unknown", "结果未知", { avoid: { "zh-Hans": ["失败", "异常"] } }),

  // Delivery states (per recipient, the receiving world's scale).
  row("delivery.accepted", "accepted", "已受理", { avoid: { "zh-Hans": ["已送达", "已收到", "投递成功", "已读"] } }),
  row("delivery.bounced", "bounced", "退信", { avoid: { "zh-Hans": ["拒收", "失败"] }, note: "the note must say 退信; 拒收 is on the send scale" }),
  row("delivery.deferred", "deferred", "延迟", { avoid: { "zh-Hans": ["失败", "退信"] } }),
  row("delivery.failed", "failed", "服务出错", { avoid: { "zh-Hans": ["发送失败"] } }),
  row("delivery.rejected", "rejected", "投递前被拒", { avoid: { "zh-Hans": ["退信"] } }),
  row("delivery.unobserved", "unobserved", "未观测到", { avoid: { "zh-Hans": ["待投递", "正常", "未知"] } }),
  row("delivery.verified_destination", "verified destination", "已验证的目标地址", { avoid: { "zh-Hans": ["已确认送达"] } }),

  // Words one English word would merge.
  row("case.held", "Held (a colleague holds the case)", "他人处理中", { avoid: { "zh-Hans": ["暂留"] } }),
  row("quarantine", "quarantine / held back", "隔离"),
  row("legal-hold", "legal hold", "法律保全", { avoid: { "zh-Hans": ["保留", "冻结"] } }),
  row("policy-hold", "policy hold", "规则暂扣"),
  row("case.hand-over", "Hand over (a case)", "转交", { avoid: { "zh-Hans": ["移交"] } }),
  row("case.release", "Release", "放回队列", {
    sentences: ["inbox.released"], avoid: { "zh-Hans": ["退回", "释放"] },
    note: "giving up a claimed case. 退回 is the rejection family (退信), so a released case would read as refused",
  }),
  row("case.mine", "hold", "由你处理", {
    sentences: ["inbox.tab.mineTitle", "inbox.empty.mine", ...LOOKBACK_MINE], avoid: { "zh-Hans": ["认领"] },
    note: "Mine: a case you hold, claimed or handed to you (a hand-over sets the assignee too); 认领 would say you claimed it. Mirrors 他人处理中",
  }),
  row("revoke", "revoke", "吊销", { avoid: { "zh-Hans": ["撤回"] } }),
  row("withdraw", "withdraw", "收回", { avoid: { "zh-Hans": ["撤回"] } }),
  row("undo", "undo", "撤销", { avoid: { "zh-Hans": ["撤回"] } }),
  row("seal", "seal", "定稿", { avoid: { "zh-Hans": ["封存"] } }),
  row("place.delete", "Move to Trash", "移到废纸篓", { keys: ["inbox.act.trash"], avoid: { "zh-Hans": ["删除"] }, note: "a place, not a deletion. 删除 stays honest on a real deletion (critic M4)" }),
];

/**
 * Phrases wrong in **every** position of a locale, whatever the key (critic M4). A phrase that is wrong only
 * for some concept belongs in that concept's `avoid`, not here: 删除 is the honest word for an irreversible
 * deletion and the wrong one for Trash. A key whose text honestly *negates* one of these declares it in
 * `NEGATES`, and that key is read by a person.
 */
export const NEVER: Readonly<Record<Exclude<Locale, "en">, ReadonlyArray<{ readonly phrase: string; readonly why: string }>>> = {
  "zh-Hans": [
    { phrase: "发送成功", why: "ADR 39: no Node can know delivery, and sent is not a state" },
    { phrase: "投递成功", why: "ADR 39, 40: delivery is observed per recipient, never claimed" },
    { phrase: "使命必达", why: "a pun on 达 that claims delivery" },
    { phrase: "必达", why: "a pun on 达 that claims delivery" },
    { phrase: "秒达", why: "the homophone of 淼达, a delivery slogan: the brand misspelt as an overclaim" },
    { phrase: "您", why: "the register is 你 (docs/i18n.md)" },
  ],
};

/** Keys whose text negates a `NEVER` phrase, and so may contain it (critic M4). Reviewed by hand. */
export const NEGATES: Readonly<Partial<Record<Key, readonly string[]>>> = {};
