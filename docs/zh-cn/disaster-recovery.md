---
translated_from: docs/disaster-recovery.md
source_sha256: f7f3980d5161fdb693c7b58bc1fea4478b15bb146ab932dbc0058b394b6638bc
source_commit: bb5f130
translated_until: "## What this runbook has established, and what it has not"
---
# 灾难恢复：做备份，并恢复到另一个账户

Issue [#92](https://github.com/Straits-AI/mailda/issues/92)。这是该 issue 所要求的演练的操作手册，写于演练**之前**，以便照着执行而不是临场发挥。临场发挥正是此前三次部署演练的失败方式：每一次都把时间花在重新发现某个前提条件上。

## 它用来做什么，不用来做什么

Cloudflare 为每个账户提供三十天的 D1 Time Travel 和 Durable Object 时间点恢复。两者都只能恢复**到出故障的那个账户里**。它们回答的是 *“周二有人跑了一个错误的迁移”*。它们回答不了 *“账户没了”*、*“账户被锁了”* 或 *“要换账户了”*；而 ADR 7 的前提是账户归客户所有，所以失去账户是产品必须挺过去的情形。

所以本文讲的是运维人员手里持有的文件，以及如何证明这些文件足够。

## 每一步证明了什么

| 步骤 | 证明了 |
| --- | --- |
| `mailda backup` | 有一份备份产物，且它列出了存储桶中应有的内容 |
| `mailda verify-backup` | 这份产物就是当时做出的那一份；没有截断，没有改动 |
| 恢复到另一个账户 | 目录数据库和密钥足以在别处建起一个节点 |
| **在那里**运行 `mailda verify-evidence` | 在新账户中，邮件能解密，且哈希与记录相符 |

最后一行就是 #92 所说的 *“让其余步骤成立的那一步。没人恢复过的导出只是一个声明。”* 它之上的一切都是准备。

## 前提条件，每一条都曾让人吃过亏

**源节点必须已被认领。** 未认领的节点没有组织，因此没有用户，因此没有人持有 `org.admin`，而 `mailda backup` 和 `mailda verify-evidence` 都需要它。它们现在会指名拒绝，而不是索要根本不可能存在的凭据。认领也是设置第一个密码的时刻，所以它是运维人员的操作。

**目标账户必须已启用 R2。** 这是一个涉及计费的仪表板操作，部署无法替你完成：Worker 声明了一个 `EVIDENCE` 存储桶绑定，部署到没有 R2 的账户会直接失败。在选定账户之前检查，而不是之后：

```sh
# `success: false` with "Please enable R2 through the Cloudflare Dashboard" means this account cannot host a Node.
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/r2/buckets"
```

**如果令牌能看到不止一个账户，必须设置 `CLOUDFLARE_ACCOUNT_ID`。** `mailda preflight` 无法判断时会拒绝，并给出账户列表和 export 那一行。见 #98，那次的歧义悄无声息地跳过了防止 Workflow 被抢占的保护。

**目标账户中不能有名称冲突。** Workflow 的名称写在配置里，因为 Cloudflare 要求在绑定上提供它；而一个 Workflow 只属于一个脚本，所以在已有 `mailda-butler-runs` 的账户里部署第二个节点会把它抢走。`mailda deploy` 会因此拒绝，但事先知道代价更小。

## 做备份

```sh
export CLOUDFLARE_ACCOUNT_ID=<the source account>
export MAILDA_EMAIL=<an administrator> MAILDA_PASSWORD=<their password>

node packages/cli/src/mailda.mjs backup \
  --url https://<source-node> --out ./backup-$(date +%F) --verify
```

`--verify` 会在写入索引之前，逐个对照记录的哈希检查每个对象，并记下结果。不加它，索引里就是 `verified: null`，`verify-backup` 会把它报告为**未要求检查**，而不是干净。第一次演练时请加上它：给一个没人检查过的状态做备份，正是演练要让它不再成为常态的事。

**导出按表名逐一列出，而不是请求整个数据库**，原因是第一次真实运行时发现的一个平台限制：

```text
D1 Export error: cannot export databases with Virtual Tables (fts5)
```

这个目录数据库有两个虚拟表，即邮件和正文的搜索索引，所以整库导出什么也产不出来，`mailda backup` 从发布那天起就不可用。选择性导出是被接受的，所以该命令读取 `sqlite_master`，排除虚拟表、它们的 fts5 影子表、`_cf_KV` 和 `sqlite_*`，然后列出其余的表。这份列表是**推导出来的**，所以后续迁移新增的表会自动进入下一次备份，不需要任何人记得。

排除索引并不是权宜之计。本仓库早已规定搜索索引是可重建的派生物，而它派生自*确实*在备份中的证据。带上它等于备份一份缓存。这个限制只是把设计推向了规则早已指向的地方。

产出三个文件：

```text
catalog.sql       the D1 dump. The thing you restore, and it carries the composition manifests, the
                  audit chain and the wrapped vault escrow, because all three are rows.
inventory.jsonl   every R2 object with the hash its plaintext should have. For raw mail, drafts and
                  sends that hash is the row that references the object; for an export's staged
                  copies, which no row names, it is the hash the export stamped on each object
                  (#216). An object with neither is `unaccounted`: an orphan, and one the
                  reconciler collects.
index.json        what the other two should contain, with a SHA-256 of each.
```

**证据的字节不在备份里。** 把一整个邮箱的 R2 数据经由笔记本电脑流式传输，不是一种备份策略。清单让别人做的拷贝可以被检查。见下文的复制存储桶。

然后，在你保存的那份拷贝上，在任何地方运行：

```sh
node packages/cli/src/mailda.mjs verify-backup --in ./backup-<date>
```

它只读取这份产物，不读别的。它能发现被截断的拷贝、不完整的下载和被人改动过的目录，备份被发现无用大多是这几种情况，而这些都能在真正需要它之前发现。它**不能**证明证据可以解密，也不能证明目录数据库可以恢复；这两者都是下文恢复过程的性质，命令自己的输出也这样说明。

## 复制存储桶

这里特意不提供淼达命令。用 R2 的桶到桶任务，或配置好两个账户的 `rclone`。键名都列在 `inventory.jsonl` 里，所以拷贝完成后可以检查，而不必轻信。

**丢失自定义元数据的拷贝如今可以挽回，以前不行**（#142）。`putEvidence` 把加密对象所用的密钥记录在 R2 自定义元数据中；`wrangler r2 object get | put` 没有对应的选项，所以这样做出的拷贝每个字节都完好，但在修复之前没有办法解密。目标节点退回到第 0 代，每个对象读出来都是 `E_EVIDENCE_AUTH_FAILED`。这是在本次演练中实测的，因为恰好犯了这个错误。

现在节点能自行恢复：对象没有标签时，读取会依次尝试密钥库持有的各个密钥代，这样做是可靠的，因为 AES-GCM 带认证。错误的密钥会失败，而不会产出错误的明文。**所以复制工具不再决定邮件是否可读**，这正是灾难中要紧的性质，那时没人会恰好用了推荐的工具。

元数据仍然值得保留。没有标签的对象在被重新加密之前，每次读取都要为每个候选密钥代多做一次解密；清单中的 `keyGeneration` 就是判断方法：比较两个节点的清单，丢失的字段就是不一致的那个。这项检查本身在 #141 之前对所有对象都报告 `0`。列表从未向 R2 请求元数据，所以两边一致，而这种一致毫无意义。

数据量一大，`wrangler r2 object get` 也根本就是错误的工具：每个对象一次请求，还是从笔记本电脑上发出。

## 恢复

```sh
export CLOUDFLARE_ACCOUNT_ID=<the destination account>

# 1. Stand up the Worker. The deploy provisions D1, R2, the queue and the Workflow; ADR 24 declares no ids.
#    A first install deploys directly: there is no previous version to protect and nothing a canary could
#    roll back to.
node packages/cli/src/mailda.mjs deploy --url https://<destination-node>

# 2. Restore the catalog. There is no `wrangler d1 import`; `execute --file` is the path.
cd apps/node/worker
npx wrangler d1 execute CATALOG --remote --file=../../../backup-<date>/catalog.sql --env ""
```

**目标节点不需要认领。** 目录数据库带着组织及其用户，所以恢复后的节点一到位就已被认领，带着源节点的管理员及其密码哈希。这也是为什么恢复必须在那里任何需要 `org.admin` 的操作之前进行。

**搜索索引必须重建。** 缺的只是内容：目标节点自己的迁移会创建虚拟表，回填再从证据中重新填充它们。从迁移 0071 起，每封邮件都记录其索引行写入时的形式，而导出带着这些标记却不含索引，所以恢复后的节点会出现标记为已索引的邮件与空索引并存：回填选不出任何东西，`doctor` 会说两者都已完成。所以 `mailda backup` 在它写出的导出末尾加上 `UPDATE messages SET search_index_form = 0, body_index_form = 0`（`packages/cli/src/backup.mjs` 中的 `searchIndexReset`），恢复时无需为此单独做一步。

> **2026 年 9 月 15 日更正。** 这一段原先以 *“`d1_migrations` 会在这件事上撒谎”* 开头，描述一种隐患：恢复后的目录数据库声称搜索迁移已经运行，而它们的表并不存在，`migrations apply` 信以为真并跳过，搜索在有人第一次使用时失败。这种隐患并不存在，紧接着的下一段也已经这样说了。两段内容在同一页操作手册上相互矛盾，而这份手册是有人会在事故中阅读的。
>
> 这是凭一份产物而不是靠争论定下来的：当天对线上节点做的一份备份包含**分布在 28 张表中的 663 条 `INSERT` 语句，零条 `CREATE TABLE`，完全没有 `d1_migrations` 行。** 排除是真实的，所以没有任何东西撒谎，也没有迁移需要手动重跑。当初那条重跑迁移的指示，会让运维人员在灾难当中为一个并不存在的问题做手工活。

备份**只含数据**，并排除了 `d1_migrations`，所以这里没有任何东西与目标节点自己的迁移所创建的结构冲突。这是对一个全新的目标节点测量的，它的 53 张表已经存在，51 条迁移记录已经正确；并于 2026 年 9 月 15 日用一份真实备份再次确认。

**必须先应用目标节点的迁移**，这由同一事实推出，值得作为一个步骤写明，而不是留给读者推断：导出不含结构，所以把它导入迁移落后的数据库时，会在数据有而结构没有的第一列上失败。实测：把这份备份导入一个过时的临时数据库，返回 `table messages has no column named body_indexed_at: SQLITE_ERROR`。

```sh
npx wrangler d1 execute CATALOG --remote --env "" --file=../../../backup-<date>/catalog.sql -y
```

搜索索引的表出于同样的原因已经存在；缺的只是内容。导出的最后一条语句把每封邮件标记为尚未索引，回填从证据中重新填充两个索引（主题每分钟 500 封，正文每分钟 25 封），`doctor` 的 `search_index_backlog` 和 `body_index_backlog` 会逐渐减少，`mailda search list` 会报告它无法解析的内容。0071 之前做的备份没有这条语句，也不需要：其中的邮件不带标记，所以到达时就是从未索引过的。

**位置和行投影随目录数据库一起迁移**（ADR 45）。一个人的归档和回收站是 `message_places` 的行，发件人的显示名称和加密的预览是 `messages` 的列（0068），所以它们都随导出一起过来，不需要重新推导。用目标节点密钥库中没有的密钥加密的预览，读出来就是没有预览，和它所来自的正文一样；列表会用一行日志说明，而不是失败。如果要改为从证据重建每个投影，把这些行改回 `pending`：

```sh
npx wrangler d1 execute CATALOG --remote --env "" --command "UPDATE messages SET preview_state = 'pending', preview_attempts = 0" -y
```

预览回填就会重新推导每一个；每次定时运行发现正文和认证回填都空闲时，最多处理 `PREVIEW_BACKFILL_LIMIT`（`src/preview.ts`）个，`doctor` 会报告逐渐减少的积压。如果只有回填放弃了的那些行需要再跑一遍（运行时密钥库或存储桶无法访问），管理员调用 `POST /api/maintenance/requeue-previews` 会把组织中每一个 `failed` 行放回去，其他什么都不动；一旦 `evidence_present` 和 `key_vault` 读数正常，这就是 `doctor` 的 `preview_backlog` 所给出的补救办法。

**密钥库是需要人来操作的部分。** 内容密钥存在 Durable Object 中，而它*不在* D1 导出里。这是 ADR 28 按设计在工作，也是密钥恢复副本存在的原因。对目标节点兑换 ADR 29 的十个恢复码之一，以安装目录数据库中证据加密时所用的密钥。十个码，各只能用一次：输错的那个也就用掉了。

```sh
# Typed at a prompt, and it refuses a pipe: a code in a shell history is a code in a backup of one. So this is
# the one step in this runbook that cannot be scripted, by design, and it is worth knowing before the day.
node packages/cli/src/mailda.mjs recovery-codes redeem --url https://<destination-node>
```

`redeem` 是唯一只能在终端中使用的恢复动词。生成一张恢复码表并确认其中一个码、重新加密、回收孤立对象、应用迁移、确认密钥冲突、验证证据，这些在诊断页面上也都有，各自位于它所处理的那条发现旁边。它们都需要一位已登录的管理员，而这恰恰是兑换状态所缺少的。

它特意不需要认证，原因是：它所针对的状态是签名密钥无法解封，所以节点建立不了任何登录会话，也没有人能证明自己是管理员。要求凭据，就等于把门放在了它要打开的那把锁后面。实测：目标节点对每次登录都返回 500，而它自己的 `doctor` 显示 `signing_key: E_EVIDENCE_AUTH_FAILED`。

> **兑换一个码会安装密钥恢复副本，它现在的返回如下**（#138）：
>
> ```text
> {"restored":{"content":[1],"credential":[1]},"conflicted":{"content":[],"credential":[]},
>  "adopted":{"content":[1],"credential":[1]}}
> ```
>
> `adopted` 表示副本中的密钥占用了本节点**预留过、但从未用于加密**的一个密钥代。全新的节点在 `doctor` 第一次初始化密钥库时生成第 1 代，不加密任何东西，而密钥恢复副本里也带着第 1 代。过去保留那里的现有密钥，代价是整个组织的邮件，只为保护一个什么都没保护的密钥：兑换什么都没安装，用掉了一个码，然后返回 `200`。
>
> **已经**用于加密的密钥代仍会被拒绝，这种拒绝正是安全性所在：误对一个健康密钥库兑换的码，不得用旧的拷贝替换正在使用的密钥。如果你看到的是 `conflicted` 而不是 `adopted`，说明本节点已经用那个代号加密过，换一个码也改变不了，返回内容会用文字说明这一点。
>
> 在演练的目标节点上实测：兑换之后，登录第一次返回了 `200`。恢复后的节点认证了源节点的管理员，用的是源节点的用户 id。

## 干净地建起一个目标节点，以及拆除它

恢复必须进入一个从未被恢复过的节点。**在第一次恢复之上再恢复一次，会以 `{"D1_RESET_DO":true}` 失败**。没有表名，没有约束，没有解释，wrangler 的日志只写着 `d1 execute import polling failed`。D1 会回滚整个文件，所以什么都没损坏；但任何人第一反应都是重试，而重试不是出路。应当从头干净地开始。

顺序很重要，其中每一步都是做错之后才发现的：

```sh
export CLOUDFLARE_ACCOUNT_ID=<the account>
cd apps/node/worker

# 1. The Worker cannot be deleted while it consumes a queue (`code: 10064`).
pnpm exec wrangler queues consumer worker remove mailda-sending-events mailda
pnpm exec wrangler delete --env "" --force

# 2. Every provisioned resource, because auto-provisioning **creates or fails and never adopts**. It will
#    not reuse an existing `mailda-catalog`, and it fails *after* creating whatever came before it in the
#    list, so a leftover from one attempt breaks the next.
pnpm exec wrangler r2 object delete mailda-evidence/<key> --remote   # per key; a non-empty bucket refuses
pnpm exec wrangler r2 bucket delete mailda-evidence
pnpm exec wrangler d1 delete mailda-catalog -y
pnpm exec wrangler queues delete mailda-sending-events

# 3. The Workflow **survives the script's deletion** and keeps pointing at a script that no longer exists.
#    It is also the one name that collides between Nodes (#99), so leaving it behind leaves the name taken:
#    the next install either refuses on `mailda deploy`'s guard or silently takes it over.
pnpm exec wrangler workflows delete mailda-butler-runs
```

然后 `mailda deploy` 会走首次安装的路径，创建全部三个绑定，并应用迁移。

**拖延已久的升级会碰到的两件事，都是在 2026 年 9 月 5 日把一个节点从结构 0034 升到 0054、一次跑二十个迁移时测到的。**

*D1 超时。* `D1 DB storage operation exceeded timeout which caused object to be reset [code: 7429]`，发生在一个以完整 FTS 重建结尾的批次上。没有丢失任何东西。一个迁移已经完成，其余的没有，直接重跑就应用了剩下的十九个。所以这里的超时是**重试**，而不是修复：`d1 migrations apply` 天然可以续跑，因为它记录了已应用的内容。

*金丝雀拒绝了，而它不该拒绝。* `The RPC receiver does not implement the method "ensureKey"`。金丝雀以 0% 流量运行新代码，而 Durable Object 命名空间仍运行**已部署**版本的类，所以金丝雀调用自己这个版本新增的方法时，调用的是旧对象。跨越一个修改了 DO 接口的版本进行升级的节点会遇到这种情况，它是版本固定造成的假象，而不是回归：用 `wrangler versions deploy <id>@100%` 提升即可解决，因为类会随部署一起更新。要对照现役版本的说法来判断，而不是只看金丝雀。

**`mailda deploy --plan` 现在会说明一个账户实际需要其中哪些步骤**（#162），从它开始更好：它读取四份列表，把每个资源报告为 create / linked / cannot-adopt / orphaned / stolen，并只打印适用的拆除步骤。本节仍然保留，因为它记录了顺序*为什么*是这个顺序，也因为对一个 `wrangler` 跑不起来的人来说，计划用处不大。顺序本身在代码中只有一处，即 `packages/cli/src/deploy-plan.mjs` 中的 `UNWIND_ORDER`；如果两者不一致，以实际运行过的代码为准。见 [`cloudflare-grant.md`](../cloudflare-grant.md)。

**临时预览账户不能作为目标。** `wrangler deploy --temporary` 会创建一个账户，然后在创建资源的中途拒绝（D1 已经建好之后，在 R2 存储桶上报 `Authentication error [code: 10000]`），因为临时账户不支持 R2、Workflows 或 Email Sending，而且建在 Workers Free 上，而 ADR 25 要求 Paid（[测量记录](../receipts/temporary-account-provisioning.md)）。

**要验证拆除，而不是想当然。** `wrangler d1 list`、`wrangler r2 bucket list`、`wrangler queues list` 和 `wrangler workflows list` 都不应再显示任何名为 `mailda` 的东西，Worker 的 URL 应当返回 404。当时没清掉的正是 Workflow，所以这项检查要明文写出，而不是隐含其中。

**不要用 `wrangler deploy` 修复 D1 已被删除的节点。** 绑定是在服务端关联的。Cloudflare 的更新日志说资源 *“stay linked across future deploys even without adding the resource IDs”*（即使不填写资源 ID，也会在之后的部署中保持关联），所以部署会继承一个指向已删除数据库的绑定，并且什么都不创建，而 `wrangler d1 … CATALOG` 会把同一个名称解析到另一个仍然存在的数据库。两者悄无声息地不一致，`wrangler d1 migrations apply CATALOG --remote` 随后会报告成功，却把每个迁移都应用到了 Worker 并不读取的数据库上。应当按上文的方法删除并重新部署。

## 证明恢复成功

```sh
export MAILDA_EMAIL=<an administrator from the restored catalog> MAILDA_PASSWORD=<their password>

node packages/cli/src/mailda.mjs verify-evidence --url https://<destination-node>
```

它会打开目标存储桶中的每个对象，把明文哈希与恢复后的目录数据库在接收时记录的值进行比较。它区分三种故障，因为它们需要不同的应对：`missing`（拷贝没有带上它）、`unreadable`（密钥库中没有它所标明的密钥代，说明密钥恢复副本没有恢复）和 `altered`（字节发生了变化）。

这里检查全部通过，就是 #92 的第 5 步。只有这一步能证明这份备份值得做。

**全部通过仍然覆盖不到的部分**，由命令打印出来，而不是留作隐含：没有任何接收记录提到的 R2 对象，以及从未进入接收环节的任何东西。

## 数字，以及其中哪些能如实给出

#92 要求测量 RPO 和 RTO。

**RPO**，即会丢失多少，不需要域名就能测量：它就是备份距今的时间。

**RTO** 要拆开看，而且必须说明怎么拆，否则这个数字就是读者以为的任何意思：

- **restore-to-readable**（恢复到可读）：在新账户中，要多久才能解密并验证邮件。下文测量了它，并附有一条让这个数字不如看上去那么有分量的说明。
- **restore-to-receiving**（恢复到可接收）：要多久节点才能再次接收新邮件。需要一个域名、绑定到区域 MX 的 Email Routing，以及 DNS 传播，最后一项不是产品能控制的。**在第三次演练中测量过**，即下文 2026 年 9 月 16 日那次：恢复后的节点通过它自己恢复出来的授权所写的规则，接收了一封来自账户外部的邮件。
