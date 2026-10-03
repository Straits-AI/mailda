---
translated_from: docs/cloudflare-settings.md
source_sha256: cdc20882b9b0442fd0b2226129e4ee9f060f0ab66b7977d6baf7ade38d6e3e88
source_commit: bb5f130
---
# 淼达需要你的 Cloudflare 账户提供什么

节点所依赖的每一项设置，集中在一处，并列出每一项的两种完成方式。

**理想的体验是：运维人员从头到尾都不必打开 Cloudflare 仪表板。** 淼达运行在客户自己的账户中（ADR 7），而对不熟悉技术的运维人员来说，仪表板是这一前提中最难的部分。所以 `mailda install` 在安装时借用 wrangler 的登录完成账户上的工作，这是运维人员已经给过的那一次同意（[`wrangler-login-reach.md`](../receipts/wrangler-login-reach.md)）；日后若要从浏览器修改，节点可以持有自己的授权（ADR 42，[`cloudflare-grant.md`](../cloudflare-grant.md)），这是可选的。**仪表板这条路径特意保留。** 想手动布置账户的人，或已经手动布置过的人，会被明确告知淼达期望什么、`doctor` 如何检查，而不是被要求相信一个按钮。

整张表遵循两条规则：

- **节点从不假定某项设置已经存在。** 每一行都写明一个 `doctor` 检查项，它从账户或证据中读取真实情况，所以无论用哪种方式完成的设置，都以同样的方式验证。
- **这里没有任何一项是淼达替你保管的机密。** 安装所用的凭据是你自己的 wrangler 登录，只随一次请求携带；可选的存储凭据是你自己创建的 API 令牌，封装保存在*你的*节点里。仪表板路径完全不涉及淼达的凭据。

| 项目 | 淼达为什么需要它 | 由淼达完成 | 在仪表板中手动完成 | `doctor` 检查项 |
|:--|:--|:--|:--|:--|
| **Workers Paid 套餐** | 免费套餐强制 24 小时的队列保留期；滞留一天的投递事件会被静默删除（ADR 25） | 无法完成。Worker 读不到自己所在账户的套餐 | Billing → Workers & Pages → Paid | `workers_paid_plan` 报告 *unverified*，并指出该去哪里查看。这是唯一一行什么都无法验证的。 |
| **Worker 及其绑定**：D1 `CATALOG`、R2 `EVIDENCE`、Durable Objects、`SENDING_EVENTS` 队列、`BUTLER_RUNS` Workflow、每分钟一次的 cron | 节点自身的存储与运行机制 | `mailda deploy`，或 Deploy 按钮。Wrangler 按 `wrangler.jsonc` 创建每个绑定，不写入任何账户专属的 id（ADR 24） | 不推荐。名称由 Worker 的名称派生，而手动创建的资源 wrangler 不会接管（[`deploy-plan`](../../packages/cli/src/deploy-plan.mjs)） | `catalog_reachable`、`evidence_bucket_reachable`、`migrations_applied`、`key_vault`、`butler_execution` |
| **已应用数据库结构** | 空的目录数据库会返回 500 | 认领时自动完成，或 `POST /api/prepare` | `wrangler d1 migrations apply CATALOG --remote` | `migrations_applied` |
| **节点自己的凭据**，可选 | 日后从浏览器修改 Cloudflare 配置：再加一个接收域名、一个发信域名、接管一条路由规则、购买域名。安装和升级都不需要它，它们只在一次请求中携带 wrangler 的登录 | `PUT /api/provider/token`（`/setup` → *把本节点连接到 Cloudflare*；`mailda provider --token`，从 stdin 读取）：一个 API 令牌，经 `GET /user/tokens/verify` 验证，绑定到它能看到的那一个账户，像发信令牌一样封装存储；`DELETE` 会删除它。权限：Account Settings Read、Zone Read、Zone Settings Edit、Email Routing Rules Edit、Queues Edit、Email Sending 权限组；Registrar Domains Read 仅在购买域名时需要；Email Routing Addresses Read 仅在读取哪些收件人是已验证的目标地址时需要 | My Profile → API Tokens → Create Token → Custom，选上述权限，限定到本账户；粘贴一次即可。2026 年 9 月 26 日起取代了 OAuth 客户端（ADR 42） | `provider_token` 报告 `no_token`、`token_held` 或 `token_refused` |
| **区域上的 Email Routing**、MX 与 SPF 记录，以及一条把你的邮件地址路由到这个 Worker 的规则 | 入站邮件只能通过一条指向节点 `email` 处理程序的路由规则到达节点 | 安装时借用 wrangler 的登录（`mailda install`；从未配置过接收的节点用 `mailda upgrade`）：同一条路径，请求上携带运维人员的凭据。之后通过授权调用 `POST /api/provider/receiving`（`/setup` → *接收*；`mailda provider --onboard-receiving`）。它提出所需的记录和规则，凭摘要确认，区域未开启路由时会开启路由（#209、#210）。这些记录是 Email Routing 自己的：子域名记录端点会指出缺少什么，开启后列出已有的记录，而根域名的记录随区域开启路由一并生成；接收这一侧不读写原始 DNS（2026 年 9 月 25 日和 26 日测量，[`wrangler-login-reach.md`](../receipts/wrangler-login-reach.md)）。已经把该邮件地址路由到别处的规则会被列出，并可在同一页面接管，附带恢复原样（#258，`GET /api/provider/routing-rules`）。在区域自己的名称上，提议改为提供 **Catch-all 地址**（2026 年 9 月 25 日）：一条规则，所有没有自己规则的邮件地址都在“成员”中管理，提议还会列出保留了自己规则的邮件地址以及每个去往何处（2026 年 9 月 28 日）；在子域名上 Cloudflare 只允许字面规则，在“成员”中添加邮件地址会在同一操作中写入它的规则 | Email → Email Routing → 启用；DNS → 添加它显示的 MX 与 SPF 记录；Routing rules → *Send to a Worker* → 本节点的 Worker，或在根域名上设置 catch-all → *Send to a Worker*。把子域名**移出**路由只能在仪表板中完成，除非存在带 `dns.write` 的授权：wrangler 的登录可以创建这些记录，但不能删除（已测量） | `inbound_routing`，依据证据：已经收到过邮件的邮件地址，以及此后的静默 |
| **一个发信域名**，已为 Email Sending 接入，带 DKIM、SPF 和 DMARC 记录 | 要发给任意收件人，需要一个经过验证的发信域名；只为 Workers 付费是不够的 | 安装时借用 wrangler 的登录（`mailda install`；`mailda upgrade`）。之后通过授权调用 `POST /api/provider/sending`（`/setup` → *发信*；`mailda provider --onboard-sending`）。先提出记录，凭摘要确认，再读回验证 | Email → Email Sending → add domain；DNS → 添加它显示的记录 | `transport_adapters`（哪个发信通道能承载邮件），以及发信阶梯本身：`handed_over` → `accepted` / `bounced` |
| **`send_email` 绑定**，或 REST 凭据 | 发信通道 | 绑定随 `wrangler.jsonc` 提供；REST 凭据是无法重新部署的节点的后备：`PUT /api/transport` | Workers → Settings → Bindings，或把一个 Email Sending API 令牌粘贴进 `PUT /api/transport` | `transport_adapters` |
| **投递结果**：发布到 `SENDING_EVENTS` 的 `email.sending` 事件订阅，以及该队列上的一个消费者 | 两者缺一，每次发信都会永远停在*未观测到*，而且看上去没有任何异常 | 安装时借用 wrangler 的登录（`mailda install`；`mailda upgrade`）。之后的订阅：通过授权调用 `POST /api/provider/subscription`（`/setup` → *投递结果*；`mailda provider --subscribe <domain>`），先提出、再凭摘要确认，适用于已经为发信接入的域名（[测量记录](../receipts/email-sending-events.md)）。`GET /api/provider/delivery-events` 会指出三者中缺了哪一个。同一次确认会在队列没有消费者时把这个 Worker 挂为它的消费者（2026 年 9 月 16 日测量：`POST /accounts/{id}/queues/{id}/consumers`）；没有授权的节点仍可用 `queue:attach-consumer`。有一种情况任何订阅都解决不了：在测量过的那一个案例中，发往本账户已验证目标地址的邮件根本没有产生投递事件（[测量记录](../receipts/email-sending-events.md)，2026 年 9 月 28 日）。`POST /api/provider/verified-destinations` 会读出节点的收件人中哪些是这种地址并记录下来（`mailda setup` 和 `mailda upgrade` 借用 wrangler 的登录；或 `/setup` → *投递结果*，使用带有可选权限 Email Routing Addresses Read 的令牌），于是发件箱把它们标为 `verified destination`（已验证的目标地址），`delivery_visibility` 也不会把那种静默算作看不见 | Queues → `SENDING_EVENTS` 队列 → Settings → consumer：这个 Worker。订阅：Email → Email Sending → 该域名 → events → 这个队列 | `sending_events_consumer`、`delivery_visibility`、`delivery_attribution`、`delivery_explanation_void` |
| **一个域名**，如果你还没有 | 可选 | `GET /api/provider/domains` 查询价格，`POST /api/provider/domains/purchase` 凭摘要确认（`mailda provider --buy`） | Domain Registration | 无 |
| **节点的主机名** | 节点默认在 `<worker>.<account>.workers.dev` 上响应；用你自己的名称，节点发出的每个链接都更好读 | 安装和升级都会询问主机名（先从列表中选一个区域，再填标签），并写入节点的派生配置；首次部署时挂上它，金丝雀路径保留它，新增主机名的升级会运行 `wrangler triggers deploy`（[测量记录](../receipts/worker-custom-domain.md)）。记录在 `.mailda/nodes.json` 中 | Workers → Settings → Domains & Routes | 无：访问节点所用的主机名就是响应的那一个；节点中没有任何东西依赖于是哪一个 |

## 如何阅读这张表

- **由淼达完成**是指节点通过自己的授权去做，先展示它将要做什么，并且只在收到与这份提议的摘要绑定的确认后才行动（`cloudflare-grant.md`，*Onboarding a domain for sending* 一节）。它绝不按过时的计划行事。
- **手动完成**得到的是同样的最终状态。节点不知道、也不在乎是哪条路径造成的；无论哪种，`doctor` 都读取账户或证据。
- **有一行需要有人在服务商那边操作**，即可选的令牌，而且只在日后要从浏览器修改 Cloudflare 配置时才需要：API 令牌在仪表板中创建，一张表单，限定到本账户。常规路径完全不需要仪表板里的任何一行（`docs/receipts/wrangler-login-reach.md`）。`email.sending` 订阅原本也在这份清单上，直到 2026 年 9 月 16 日发现 API 能够创建它；现在由节点创建（#222）。
- **有一行根本无法验证**：套餐。`doctor` 会如实说明，而不是报告 `ok`。

## 尚未完成的部分

- 通过节点的*令牌*挂接消费者，尚未测量。API 可以挂接（用运维人员的令牌测量过），线上节点的消费者在部署时已经挂好，也没有一个缺少消费者的节点可以拿来尝试。候选权限是 `Queues: Edit`。
- 缺少某项权限的令牌照样会被接受。`GET /user/tokens/verify` 只报告状态和到期时间，不报告权限，所以缺少 `Email Routing Rules: Edit` 的令牌会在写第一条规则时被 Cloudflare 拒绝，用的是 Cloudflare 的原话；`/setup` 和 `mailda provider` 会事先说明这一点，而不是去检查。2026 年 9 月 16 日用它所取代的 OAuth 授权测量过：路由规则需要单独的写权限；一个写入了 MX 记录却被拒绝写规则的凭据，正是接收提议学会接着完成自己做了一半的工作、而不是拒绝的原因。原始 DNS 权限根本不需要：接收通过 Email Routing 自己的端点读写它自己的记录。
- 由淼达设置自定义主机名，这样最后一行只能在仪表板中完成的事项也能去掉。
