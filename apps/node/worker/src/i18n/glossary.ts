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
 * ## Status: every row starts proposed, and only the owner confirms one
 *
 * A row's `status` is `"proposed"` until the repository's owner confirms that word, and then it becomes
 * `{ confirmedBy, record }`, where `record` links the owner's own written confirmation and says when it was
 * made (a PR review comment, an issue comment, or a decision the owner recorded on a review page). An author,
 * human or agent, never writes a `confirmedBy` for somebody else: the only edit to a row's status is copying
 * that record in, which `CONFIRMED` below does for the owner's review of 30 September 2026 (and `ANSWERED` and
 * `ROUND_TWO` for the answers and the second round of 1 October 2026). The check cannot tell who typed the
 * field, so **the real gate is the owner's approval of the pull request that carries the edit**, and
 * `docs/i18n.md` says so.
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

/**
 * The owner's review of 30 September 2026: every row and every reviewer flag answered on the review page, one
 * recorded decision each, by the owner's account. 79 rows confirmed, three of them with the word the owner chose
 * there (butler and route.butlers 管家, route.trash 回收站). Two were held and answered the next day
 * (`OWNER_ANSWER` below): `passkey`, asked whether 密钥 or 通行密钥, and `place.delete`, whose phrase changed
 * after the owner confirmed it.
 */
const OWNER_REVIEW = {
  confirmedBy: "u_6CUB4j9n0eDCMz1ERT424A",
  record: "https://claude.ai/artifact/6aZKXUkQsES5KYLZvRzGzn, decisions recorded 30 September 2026",
} as const;
/**
 * The two rows held on 30 September, answered by the owner on 1 October 2026 in the working session ("passkey use
 * 通行密钥, move to trash ok") and recorded on the same review page: passkey stays 通行密钥, and 移到回收站 is
 * confirmed as the phrase for Move to Trash.
 */
const OWNER_ANSWER = {
  confirmedBy: "u_6CUB4j9n0eDCMz1ERT424A",
  record: "https://claude.ai/artifact/6aZKXUkQsES5KYLZvRzGzn, answered 1 October 2026 in the working session",
} as const;
const ANSWERED: ReadonlySet<string> = new Set(["passkey", "place.delete"]);
/**
 * Round two, on the same review page: the three rows layer 2a added (`send.denied`, `recall`, `vault`), each
 * confirmed by the owner's recorded decision of 1 October 2026 with the word as proposed.
 */
const OWNER_ROUND_TWO = {
  confirmedBy: "u_6CUB4j9n0eDCMz1ERT424A",
  record: "https://claude.ai/artifact/6aZKXUkQsES5KYLZvRzGzn, round two, decisions recorded 1 October 2026",
} as const;
const ROUND_TWO: ReadonlySet<string> = new Set(["send.denied", "recall", "vault"]);
/** The rows `OWNER_REVIEW` confirmed, by id. A row added later is not in it, and so starts proposed. */
export const CONFIRMED: ReadonlySet<string> = new Set([
  "brand", "node", "butler", "mailbox", "address", "case", "matter", "rules", "approval", "receipt.ingress", "escrow",
  "recovery-codes", "claim", "claim-secret", "invitation-secret", "grant", "provider", "catch-all", "sponsor", "effect",
  "graph-node", "session", "settings", "setup", "route.inbox", "route.queue", "route.drafts", "route.outbox",
  "route.archive", "route.trash", "route.people", "route.matters", "route.approvals", "route.rules", "route.butlers",
  "route.agents", "route.limits", "route.audit", "route.log", "route.doctor", "automate", "compose", "palette",
  "health.refuse", "health.degraded", "health.report", "outbound", "refusal.code", "connectivity.connected",
  "connectivity.unreachable", "connectivity.offline", "send.held", "send.awaiting", "send.cancelled", "send.withheld",
  "send.throttled", "send.refused", "send.suppressed", "send.handed_over", "send.propose", "send.outcome_unknown",
  "delivery.accepted", "delivery.bounced", "delivery.deferred", "delivery.failed", "delivery.rejected",
  "delivery.unobserved", "delivery.verified_destination", "case.held", "quarantine", "legal-hold", "policy-hold",
  "case.hand-over", "case.release", "case.mine", "revoke", "withdraw", "undo", "seal",
]);

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
  row("node", "Node", "节点", {
    sentences: ["ledgers.audit.empty", "ledgers.log.empty", "ledgers.transport.none", "ledgers.outbox.daily.throttled"],
    avoid: { "zh-Hans": ["服务器", "实例"] }, note: "one deployment in the customer's own account; 本节点 for 'this Node'" }),
  row("butler", "Butler", "管家", {
    sentences: ["api.grant.org.admin", "ledgers.outbox.gate.failed", "ledgers.outbox.release.title"],
    avoid: { "zh-Hans": ["Butler", "机器人", "智能助手"] },
    note: "the owner's word (30 Sep 2026), replacing Latin Butler, which is now avoided so one locale has one word. The CLI noun `butler` stays Latin and in mono",
  }),
  row("mailbox", "mailbox", "邮箱", { note: "a storage and access boundary; never used for an address" }),
  row("address", "address", "邮件地址", { sentences: ["reader.assign.email"], avoid: { "zh-Hans": ["邮箱"] } }),
  row("case", "case", "工单", { sentences: ["reader.assign.noCase", "reader.assign.closed"], avoid: { "zh-Hans": ["案件", "案例"] } }),
  row("matter", "Matter", "事项", {
    avoid: { "zh-Hans": ["调查", "案件"] },
    note: "a supervised read, legal hold, departure handover or regulatory request; 调查 would call a routine handover an investigation (critic H3, D9)",
  }),
  row("rules", "Rules", "规则", { avoid: { "zh-Hans": ["策略"] }, note: "the UI word for policy (D1)" }),
  row("approval", "approval", "审批", { avoid: { "zh-Hans": ["同意"] } }),
  row("receipt.ingress", "receipt", "接收记录", { avoid: { "zh-Hans": ["回执", "收据"] } }),
  row("escrow", "escrow", "密钥恢复副本", { avoid: { "zh-Hans": ["托管"] } }),
  row("recovery-codes", "recovery codes", "恢复码", { avoid: { "zh-Hans": ["备用码"] } }),
  row("passkey", "passkey", "通行密钥", {
    sentences: ["api.passkey.unsupported", "api.passkey.none"], avoid: { "zh-Hans": ["通行证"] },
    note: "not 密钥, which already names cryptographic keys here (escrow is 密钥恢复副本, and the key vault); 通行密钥 is how Apple and Google localize passkey. The owner first chose 密钥 (30 Sep 2026), was asked once, and confirmed 通行密钥 (1 Oct 2026)",
  }),
  row("claim", "claim", "认领", { sentences: ["ledgers.doctor.claimed", "ledgers.doctor.unclaimed"], avoid: { "zh-Hans": ["注册", "激活"] } }),
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
  row("route.inbox", "Inbox", "收件箱", { keys: ["route./"], sentences: ["reader.act.toInbox"] }),
  row("route.queue", "Queue", "队列", { keys: ["route./queue"] }),
  row("route.drafts", "Drafts", "草稿", { keys: ["route./drafts"] }),
  row("route.outbox", "Outbox", "发件箱", {
    keys: ["route./outbox"], sentences: ["ledgers.outbox.empty"], avoid: { "zh-Hans": ["已发送"] }, note: "ADR 39: the outbox never says sent" }),
  row("route.archive", "Archive", "归档", { keys: ["route./archive"], avoid: { "zh-Hans": ["存档", "封存"] } }),
  row("route.trash", "Trash", "回收站", {
    keys: ["route./trash"], sentences: ["inbox.moved.trash", "inbox.movedBack.trash", "inbox.search.found", "inbox.empty.trash"],
    avoid: { "zh-Hans": ["删除"] },
    // `inbox.trash.note` names Trash and is not bound: it says 不会被删除, and `avoid` has no negation escape.
    // The old word 废纸篓 is in `NEVER`, which covers it too.
    note: "the owner's word (30 Sep 2026), replacing 废纸篓. ADR 45: nothing a person places is destroyed",
  }),
  row("route.people", "People", "成员", { keys: ["route./people"] }),
  row("route.matters", "Matters", "事项", { keys: ["route./matters"], avoid: { "zh-Hans": ["调查"] } }),
  row("route.approvals", "Approvals", "审批", { keys: ["route./approvals"] }),
  row("route.rules", "Rules", "规则", { keys: ["route./rules"] }),
  row("route.butlers", "Butlers", "管家", { keys: ["route./butlers"], avoid: { "zh-Hans": ["Butler"] } }),
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
  row("send.held", "held", "暂留", { keys: ["send.state.held"], avoid: { "zh-Hans": ["待发送", "撤回"] } }),
  row("send.awaiting", "awaiting", "待放行", { keys: ["send.state.awaiting"], avoid: { "zh-Hans": ["发送中", "处理中"] } }),
  row("send.cancelled", "cancelled", "已取消", { keys: ["send.state.cancelled"], avoid: { "zh-Hans": ["已撤回"] } }),
  row("send.withheld", "withheld", "扣发", { keys: ["send.state.withheld"], avoid: { "zh-Hans": ["已取消", "失败", "拒绝"] } }),
  row("send.throttled", "throttled", "限流中", { keys: ["send.state.throttled"], avoid: { "zh-Hans": ["失败"] } }),
  row("send.refused", "refused", "服务商拒收", {
    keys: ["send.state.refused"], avoid: { "zh-Hans": ["拒收", "退信", "失败"] },
    note: "the mail service would not accept it and it never left (critic H3). A bare 拒收 reads as the recipient's server, which is `bounced`",
  }),
  row("send.suppressed", "suppressed", "已抑制", { keys: ["send.state.suppressed"], avoid: { "zh-Hans": ["已屏蔽", "黑名单"] } }),
  row("send.handed_over", "handed over", "已移交", {
    keys: ["send.state.handed_over"],
    sentences: ["ledgers.outbox.daily.unmeasured", "ledgers.outbox.daily.throttled", "policies.when.volume"],
    avoid: { en: ["accepted"], "zh-Hans": ["已发送", "发送成功", "已送达", "已投递", "已交付", "受理"] },
    note: "the transport took the bytes. D8 (fixed 1 Oct 2026): its note said 'Accepted by the mail service', a delivery word, and now says 'Taken by the mail service' (docs/i18n.md)",
  }),
  row("send.propose", "propose", "提交", {
    sentences: ["api.agent.send.propose"], avoid: { "zh-Hans": ["提议"] },
    note: "an agent drafts and submits a send intent for a person to seal; 提议 reads as suggesting an email",
  }),
  row("send.denied", "denied", "否决", {
    sentences: ["send.reason.policy_denied", "send.reason.approval_denied"], avoid: { "zh-Hans": ["拒绝"] },
    note: "a rule or an approver decided against a send (layer 2a; confirmed in round two, 1 Oct 2026). 拒绝 is the refusal family (拒收, 投递前被拒), which is somebody else's server",
  }),
  row("send.outcome_unknown", "outcome unknown", "结果未知", {
    // `never_submitted` is this state read with one more column (`describeSend`): the same label, a stronger note.
    keys: ["send.state.outcome_unknown", "send.state.never_submitted"], avoid: { "zh-Hans": ["失败", "异常"] },
  }),

  // Delivery states (per recipient, the receiving world's scale).
  row("delivery.accepted", "accepted", "已受理", { keys: ["delivery.state.accepted"], avoid: { "zh-Hans": ["已送达", "已收到", "投递成功", "已读"] } }),
  row("delivery.bounced", "bounced", "退信", { keys: ["delivery.state.bounced"], avoid: { "zh-Hans": ["拒收", "失败"] }, note: "the note must say 退信; 拒收 is on the send scale" }),
  row("delivery.deferred", "deferred", "延迟", { keys: ["delivery.state.deferred"], avoid: { "zh-Hans": ["失败", "退信"] } }),
  row("delivery.failed", "failed", "服务出错", { keys: ["delivery.state.failed"], avoid: { "zh-Hans": ["发送失败"] } }),
  row("delivery.rejected", "rejected", "投递前被拒", { keys: ["delivery.state.rejected"], avoid: { "zh-Hans": ["退信"] } }),
  row("delivery.unobserved", "unobserved", "未观测到", { keys: ["delivery.state.unobserved"], avoid: { "zh-Hans": ["待投递", "正常", "未知"] } }),
  row("delivery.verified_destination", "verified destination", "已验证的目标地址", {
    keys: ["delivery.reason.verified_destination"], avoid: { "zh-Hans": ["已确认送达"] },
  }),

  // Words one English word would merge.
  row("case.held", "Held (a colleague holds the case)", "他人处理中", { avoid: { "zh-Hans": ["暂留"] } }),
  row("quarantine", "quarantine / held back", "隔离"),
  row("legal-hold", "legal hold", "法律保全", { sentences: ["ledgers.collect.warning"], avoid: { "zh-Hans": ["保留", "冻结"] } }),
  row("policy-hold", "policy hold", "规则暂扣", { keys: ["send.reason.policy_hold"] }),
  row("case.hand-over", "Hand over (a case)", "转交", { avoid: { "zh-Hans": ["移交"] } }),
  row("case.release", "Release", "放回队列", {
    keys: ["queue.act.release"], sentences: ["inbox.released"], avoid: { "zh-Hans": ["退回", "释放"] },
    note: "giving up a claimed case. 退回 is the rejection family (退信), so a released case would read as refused",
  }),
  row("case.mine", "hold", "由你处理", {
    sentences: ["inbox.tab.mineTitle", "inbox.empty.mine", ...LOOKBACK_MINE], avoid: { "zh-Hans": ["认领"] },
    note: "Mine: a case you hold, claimed or handed to you (a hand-over sets the assignee too); 认领 would say you claimed it. Mirrors 他人处理中",
    // `chrome.rail.mailbox` says 由你处理 too (the owner's review, R1) and is not bound: its English says "mine", not
    // "hold", and its Chinese says 未认领 for the unclaimed count, which this row's avoided 认领 would catch.
  }),
  row("revoke", "revoke", "吊销", { avoid: { "zh-Hans": ["撤回"] } }),
  row("withdraw", "withdraw", "收回", { avoid: { "zh-Hans": ["撤回"] } }),
  row("undo", "undo", "撤销", { avoid: { "zh-Hans": ["撤回"] } }),
  row("seal", "seal", "定稿", {
    sentences: ["composer.seal.refused", "composer.unreachable.unsealed", "composer.file.dangerous"],
    avoid: { "zh-Hans": ["封存"] },
    // Not `composer.bodyUnavailable.unreadable`: its "sealed under a key" is encryption (加密), not this act. The
    // button's "Seal and send" (定稿并发送) is held by `composer-words.test.tsx`: a binding matches English by case.
  }),
  // Layer 2a: the composer's two words that no row had, confirmed in round two (1 Oct 2026).
  row("recall", "recall", "撤回", {
    sentences: ["composer.sendNote", "composer.how.body"], avoid: { "zh-Hans": ["召回"] },
    note: "taking a message back after it left, which no Node can do: named only to say there is none. The word revoke, withdraw, undo and held keep clear of",
  }),
  row("vault", "vault", "密钥库", {
    sentences: ["composer.bodyUnavailable.unreadable"], avoid: { "zh-Hans": ["保险库", "金库"] },
    note: "the key generations that open this Node's sealed content, restored with the recovery codes",
  }),
  row("place.delete", "Move to Trash", "移到回收站", {
    keys: ["inbox.act.trash"], avoid: { "zh-Hans": ["删除"] },
    note: "a place, not a deletion. 删除 stays honest on a real deletion (critic M4). The owner confirmed 移到废纸篓 (30 Sep 2026), renamed Trash 回收站, and confirmed 移到回收站 (1 Oct 2026)",
  }),

  // Layer 2b (1 October 2026): the words its screens needed that no row had. Proposed, for the owner's next review;
  // zh-Hans is a preview, so it may carry them meanwhile. A binding matches English by case, so a capitalised label
  // ("Lift", "Mint an agent") is held by its screen's zh test rather than bound here.
  row("team", "team", "团队", {
    sentences: ["people.teams.lede", "people.teams.new", "people.teams.none"],
    note: "a group an approval stage can require a decision from",
  }),
  row("mint", "mint", "签发", {
    sentences: ["people.invited.expired", "agents.none", "agents.mint.which.note", "agents.mint.renewal"],
    note: "issuing a credential that is shown once (an invitation secret, an agent's token); re-minting is 重新签发. `ledgers.codes.mint` (recovery codes) says 生成, for the owner to decide",
  }),
  row("capability", "capability", "能力", {
    note: "an agent's ceiling, one unit of what it may do; the ids stay Latin. Unbound: the plural's forms (capability, capabilities) defeat a binding by containment, so `people-words.test.tsx` holds `agents.review.capabilities`",
  }),
  row("approve", "Approve", "批准", {
    keys: ["approvals.approve"],
    note: "the act of deciding for, as the approval row (审批) is the request and its process. Deny is send.denied's 否决",
  }),
  row("routing-rule", "routing rule", "路由规则", {
    sentences: [
      "setup.connection.why", "setup.receiving.done.nothing", "setup.ownRules.unread", "setup.ownRules.none", "setup.ownRules.some",
      "setup.rules.none", "people.routing.rule_written", "people.removal.rule_removed",
    ],
    avoid: { "zh-Hans": ["策略"] },
    note: "Cloudflare Email Routing's rule for an address, not this Node's Rules (规则), which decide sends",
  }),
  row("pause", "pause", "暂停", {
    sentences: [
      "send.reason.domain_paused", "send.reason.domain_paused.note", "approvals.kind.domain_pause.what", "limits.pauses.lead",
      "limits.pauses.asked", "limits.pauses.act", "limits.pauses.empty", "butlers.standing.paused",
    ],
    avoid: { en: ["stop", "Stop", "restart", "Restart"], "zh-Hans": ["停止", "封禁"] },
    note: "D3: one verb for a domain or a Butler held until somebody lifts or resumes it; never stopped, never restarted",
  }),
  row("supervised-read", "supervised read", "受监督查阅", {
    sentences: ["matters.read.empty"], avoid: { "zh-Hans": ["监控", "监视"] },
    note: "a time-boxed grant to read a mailbox one holds nothing on; already the word of `chrome.notice.supervised`",
  }),
  row("export", "export", "导出", {
    sentences: [
      "api.grant.ediscovery.export", "reader.original.recorded", "reader.original.note", "ledgers.collect.warning",
      "ledgers.collect.exports", "matters.exports.lead", "matters.exports.act", "matters.exports.empty",
    ],
    avoid: { "zh-Hans": ["外发"] },
    note: "an e-discovery copy that leaves this Node's controls (外发 is the outbound row's avoided word too)",
  }),
  row("breaker", "Breaker", "熔断器", {
    keys: ["limits.col.breaker"], sentences: ["limits.breakers"], avoid: { "zh-Hans": ["断路器"] },
    note: "a rate this Node applies to itself; armed 已启用, unarmed 未启用, tripped 正在阻止发信",
  }),
  row("vouch", "vouch", "作保", {
    sentences: ["limits.suppressed.lead"], avoid: { "zh-Hans": ["担保"] },
    note: "an administrator's reasoned lift of a suppression. Not the bytes a send's evidence vouches for (`send.reason.evidence_changed.note`, 担保), nor DMARC's (`reader.auth.pass`)",
  }),
  row("lift", "lift", "解除", {
    sentences: [
      "approvals.kind.domain_pause.what", "send.reason.domain_paused.note", "matters.holds.liftWaiting", "matters.holds.liftAsked",
      "matters.holds.liftAct",
    ],
    avoid: { "zh-Hans": ["释放"] },
    note: "ending a legal hold or a domain pause; 释放 is the release family (case.release avoids it too)",
  }),
  row("administrator", "administrator", "管理员", {
    sentences: [
      "health.reduced", "composer.from.none", "composer.from.more", "queue.restricted.subject", "queue.restricted.sender",
      "queue.quarantine.dmarc.on", "queue.quarantine.attachments.on", "queue.noMailbox", "send.reason.domain_paused.note",
      "people.forbidden", "people.arrival.unread", "limits.pauses.lead", "limits.pauses.asked", "limits.suppressed.lead",
      "butlers.notAdmin", "policies.notAdmin",
    ],
    note: "whoever holds org.admin. An export's or a hold lift's approvers hold approval.decide instead, so their sentences say people (D3)",
  }),
  row("receipt.measured", "receipt", "测量记录", {
    sentences: ["limits.breakers.caption"], avoid: { "zh-Hans": ["回执", "接收记录"] },
    note: "the measurement behind a budget (AGENTS.md §2), not the Node's record of an arrival (receipt.ingress, 接收记录)",
  }),
  row("onboard", "onboard", "接入", {
    sentences: [
      "setup.sending.propose", "setup.sending.coveredBy", "setup.sending.onboarded", "setup.sending.done", "setup.sending.notDone",
      "setup.outcomes.about", "setup.outcomes.carriedBy", "onboarding.step.sending", "onboarding.step.sending.phrase",
      "onboarding.sending.none", "onboarding.sending.notOnboarded",
    ],
    note: "telling Cloudflare an account may send as a domain, Cloudflare's own English word; 为发信接入 where the English says for sending",
  }),
  row("zone", "zone", "区域", {
    sentences: [
      "setup.receiving.about", "setup.receiving.noZone", "setup.receiving.enablesZone", "setup.receiving.catchAll.none",
      "setup.rules.title", "setup.rules.about", "setup.rules.list",
    ],
    note: "a Cloudflare zone, Cloudflare's own Chinese word",
  }),
  row("apex", "apex", "根域名", {
    sentences: ["setup.receiving.enablesZone", "ui.firstRun.browser.body"], avoid: { "zh-Hans": ["顶级域名"] },
    note: "a zone's own name, above its subdomains. 顶级域名 is a top-level domain (.com), another thing",
  }),
  row("token", "token", "令牌", {
    sentences: [
      "setup.connection.forget", "setup.connection.forgetNote", "setup.connection.create", "setup.connection.permissions",
      "setup.connection.tokenPage", "setup.connection.token", "setup.verified.about", "setup.verified.failed",
      "ledgers.transport.none", "ledgers.transport.token", "onboarding.record.token", "onboarding.routed.unread",
      "onboarding.delivery.unread", "agents.mint.renewal", "ui.firstRun.terminal", "ui.firstRun.browser.link",
    ],
    note: "an API token (Cloudflare's, or an agent's bearer token). Not 密钥, which names cryptographic keys here (passkey's note), as in 凭据密钥",
  }),
  row("delivery-event", "delivery event", "投递事件", {
    sentences: ["setup.outcomes.done", "onboarding.delivery.unread", "delivery.reason.verified_destination.note"],
    note: "Cloudflare's report of what a receiving server did with a send, which this Node reads as a delivery state",
  }),
  row("subscription", "subscription", "订阅", {
    sentences: ["setup.outcomes.about", "setup.outcomes.carriedBy", "onboarding.outcomes.noSubscription", "onboarding.outcomes.off"],
    note: "Cloudflare's subscription that publishes a sending domain's delivery events into this Node's queue",
  }),
  row("consumer", "consumer", "消费者", {
    sentences: ["setup.outcomes.noConsumer", "onboarding.outcomes.noConsumer"],
    note: "the Worker a Cloudflare queue hands its messages to; Cloudflare's own Chinese word",
  }),
].map((concept) => (CONFIRMED.has(concept.id) ? { ...concept, status: OWNER_REVIEW }
  : ANSWERED.has(concept.id) ? { ...concept, status: OWNER_ANSWER }
  : ROUND_TWO.has(concept.id) ? { ...concept, status: OWNER_ROUND_TWO } : concept));

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
    {
      phrase: "送达",
      why: "ADR 39: no Node observes a message reach an inbox. Cloudflare's `delivered` event is the receiving server's acceptance, which this Node calls accepted, 已受理 (`src/outbound/events.ts`)",
    },
    { phrase: "秒达", why: "the homophone of 淼达, a delivery slogan: the brand misspelt as an overclaim" },
    { phrase: "您", why: "the register is 你 (docs/i18n.md)" },
    { phrase: "废纸篓", why: "Trash is 回收站 (the owner's review, 30 September 2026): one place, one word, in every sentence" },
  ],
};

/** Keys whose text negates a `NEVER` phrase, and so may contain it (critic M4). Reviewed by hand. */
export const NEGATES: Readonly<Partial<Record<Key, readonly string[]>>> = {};
