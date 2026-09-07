# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

罗盘 Compass：pi coding agent 的项目级 Extension（纯 TypeScript，无构建步骤），把 Amazon US 精铺选品工作流落进终端。入口由 `package.json` 的 `pi.extensions: ["./index.ts"]` 声明，pi 宿主直接加载 TS 源码（Node type stripping）；本仓库被 clone 到使用方项目的 `.pi/extensions/compass/` 下生效。

## 常用命令

```bash
npm test          # 全部测试（node:test，tests/*.test.ts；单用例 30 秒硬超时）
node --experimental-strip-types --test tests/strategy.test.ts                       # 单个测试文件
node --experimental-strip-types --test --test-name-pattern "veto" tests/*.test.ts   # 按用例名过滤
npm run check     # tsc --noEmit 类型检查
```

Node >= 22.19；无 build 产物。**没有 lint，静态检查全部由 `tsconfig.json` 的编译开关承担**——`strict` 之外另开了 `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch` / `noImplicitOverride` 与 `allowUnreachableCode: false`（实测不增加 tsc 耗时），不要为了让 `npm run check` 过而关掉其中任何一个。CI（`.github/workflows/ci.yml`）在 Node 22/24 上跑 test + check，job 级 `timeout-minutes: 10` 兜底，安装用 `npm ci --ignore-scripts`（本仓库不依赖任何 install 脚本）；`.nvmrc` 钉 24（矩阵里的 Active LTS 线）。`npm test` 里的 `--experimental-strip-types` 在 Node <22.18 是必需 flag、更高版本是无告警的 no-op，不要删。

## 关键约束：依赖由 pi 宿主提供

运行时依赖只有 `yaml`。`@earendil-works/pi-*` 与 `typebox` 在运行时由 pi 宿主解析提供，devDependencies 声明它们只为 IDE 类型与 `npm run check`：

- `typebox` 必须钉在 **1.3.7**（与宿主捆绑版本一致）；升级会触发 tsc TS2589 深度实例化错误。
- `@earendil-works/pi-coding-agent` 自带 npm-shrinkwrap，其依赖嵌套安装、不 hoist，因此 `pi-ai` / `pi-tui` 必须在 devDependencies 显式声明 tsc 才能解析。
- 不要把 pi 系列包挪进 dependencies 或打包进扩展。

## 架构

单向分层：`index.ts`（19 个领域工具 + `compass_tools` 路由 + 9 个 slash command 的注册薄层及只读 hook）→ `importer.ts` / `gapfill-convert.ts` / `dispatch.ts` / `service.ts` → 领域模块 `csv.ts` / `metrics.ts` / `economics.ts` / `strategy.ts` / `history.ts` / `todo.ts` / `gaps.ts` / `report.ts` → `store.ts`（持久化）。`service.ts` 承载纯内存的编排与业务规则（第一参数约定为 store 数据对象，`importContentHash` 等少数纯工具函数除外，不接触磁盘）；`importer.ts` 是 CSV 导入链路上唯一做文件 I/O 的编排模块（路径解析→查重→解析→归档→写事务），事务语义由调用方经 `deps.mutate` 注入，pi 会话与其他入口可共用同一链路。`gapfill-convert.ts` 与它平级（同为编排层、同样做文件 I/O），只 import `csv.ts` 与 `store.ts` 的类型，绝不反向被纯函数层 import。`dispatch.ts` 也在这一层，是全仓**唯一做进程内 LLM I/O** 的模块：只 import `types.ts` 的领域枚举与运行期依赖 `yaml`，宿主包连 `import type` 都不用——它自声明宿主类型的结构子集（`DispatchContext` / `DispatchRegistryLike` / `DispatchModelLike` / `DispatchUsage`），所以测试不拉起 pi 也能跑，而那个自声明的 Context **故意不含 `tools` 字段**，「零工具」因此是类型错误而不是约定。`types.ts` 是共享数据模型；`errors.ts` 是零 import 的叶子模块，只放领域错误类（`NotFoundError` / `ValidationError`），任何层都可顺向 import——**错误的分类信息必须落在类型上而不是中文文案里**，Web 层的 404 / 400 分级按 `instanceof` 判定（`web/server.ts` 的 `asDomainError`，由 `tests/static-invariants.test.ts` 的切片用例守着），改一句措辞不会连带改掉状态码；`ui.ts` 只做六页 TUI 渲染（总览/待办/市场/候选池/预算/复盘）。测试直接 import service 与领域模块、不经过 `index.ts`，因此脱离 pi 宿主即可运行。

Web UI（`web/` 目录，TUI 之外的第二套前端，读同一个 store）：`data.ts`（DTO 组装层，纯函数 `(store, ...) => JSON 安全对象`，每页一个入口，不 import node:http、不接触磁盘——**这是模块 import 层的约束，不等于「读端点零磁盘 I/O」**：`data.ts` 调的 `listWorkbenchTodos` → `metricDivergences` 对**多来源市场**会按当前 q 重算 QRD，从而触发快照明细 sidecar 的懒读；单来源市场被提前退出挡住，真实 store 目前 0 个多来源市场）→ `server.ts`（node:http 服务：`startCompassWebServer` 统一入口，路由/静态资源/写队列/回环地址与同源校验，只绑定 127.0.0.1）→ `standalone.ts`（脱离 pi 的独立入口，`COMPASS_ROOT` 指定宿主项目，供 `npm run web` 使用）；`assets/`（`index.html`/`style.css`/`app.js`/`markdown.js`，纯 JS 单页应用、无框架无构建步骤，hash 路由八个视图；`app.js`/`style.css` 不在 `tsconfig.json` 的 `include` 范围内，`npm run check` 不检查它们）。`markdown.js` 是唯一例外：它被 `app.js` 静态 import（404 会让整张页面白屏，不只是弹窗坏掉），同时是纯函数、能脱离 DOM 跑，因此由 `tests/web-markdown.test.ts` 覆盖，并靠同目录手写的 `markdown.d.ts` 让 tsc 解析那次 import。市场档案的五维报告只在浏览器端把 Markdown 渲染成 HTML 弹窗阅读，**落盘产物仍然只有 `.md`**（`resolveOutputPath` 硬性要求 `.md` 扩展名），不要为了「看得好看」再生成一份 HTML 文件。`index.ts` 的 `/compass-web` 命令与 `standalone.ts` 共用同一个 `server.ts:startCompassWebServer`，行为一致；不做鉴权（本机单用户模型），文档与实现都要强调禁止端口转发暴露到局域网。**外链策略**：`index.html` 保留唯一一条 Google Fonts 外链（IBM Plex，设计系统指定的字体，回退栈见 `web/assets/style.css` 的 `--f-sans` / `--f-mono`），但**必须是非阻塞形态** `media="print" onload="this.media='all'" referrerpolicy="no-referrer"`——实测 render-blocking 写法在字体主机不可达（断网/被墙）时会让 `app.js` 根本不执行、一个 `/api` 请求都不发，页面永久停在「正在加载罗盘工作台…」；离线时由 `style.css` 的 `--f-sans` / `--f-mono` 回退栈接管。除这一条外 `app.js` / `markdown.js` / `style.css` 一律零外链，要加第二条外链先回来改这一段（`tests/web-assets.test.ts` 会拦）。

数据流：CSV 导入（`csv.ts`：UTF-8/16 解码并在非法 UTF-8 时回退 GB18030、按每行计数一致性嗅探分隔符、中英文字段别名映射、数值列白名单式解析、关键词行去重）→ 生成不可变市场快照并把原始文件归档到 `raw/` → `metrics.ts` 计算五维指标，每个数字都是 MetricEvidence（value + source + capturedAt + confidence）→ `strategy.ts` 执行 GSE（Gate → Score，veto 命中即整体否决）→ 候选卡按阶段流转并写 decisionLog → `report.ts` 输出五维 Markdown 报告。

持久化（`store.ts` 的 CompassRepository）：单一 JSON store（schemaVersion 1，load 时 assertStore 校验）写入**宿主项目**（运行 pi 的 cwd）的 `.pi/compass/`，而不是扩展自身目录。新增顶层集合一律走「可选数组 + `ensureDefaults` 回填 + `load()` 迁移检测与回写」（`outcomeChecks` / `lessons` / `todoResolutions` 是先例），schemaVersion 保持 1，旧版扩展回滚后忽略新字段即可打开。写入走临时文件 + rename 原子替换，目录 0700、文件 0600。`resolveInputPath` / `resolveOutputPath` 把一切输入输出路径限制在宿主项目内——不要绕过它们直接拼路径。

补数缺口（`gaps.ts`）与待办同属「不实体化」的只读派生：不落 store、不新增顶层集合。`deriveGaps` 必须由调用方把已算好的 `listWorkbenchTodos` 结果传进来——它对多来源市场会经 `metricDivergences` 触发快照明细的同步读，模块自己再算一遍就是同一次写事务里多一次磁盘 I/O。唯一落盘是补数档位与静音清单（`gapfill/state.jsonc`），只从 `/compass-fill` 命令 handler 写（命令不是 hook，是天然安全点；写它的队列 key 与 store 不同，不构成嵌套）。文件名必须用 `.jsonc` 扩展名：本文件下面那条 bash 读守卫的正则会拦住 `.json` 结尾的读命令。`/compass-fill` 的注册位置也不自由——它的 handler 带写事务标记，必须排在所有 `pi.on(...)` **之前**，否则会被 `tests/static-invariants.test.ts` 的 hook 切片器算进某个热路径 hook 而直接测试红。

A 档补数（`compass_gaps approve` / `convert` + `gapfill-convert.ts`）另有四条不变式：

- **确认单只有一张，且是内存的**：`gapfillTicket` 是 `index.ts` 里的单变量而不是 Map——「同一时刻只有一张」若靠 Map 就成了要自觉遵守的约定。它只活到 `/reload`；`activeGapfillTicket()` **只按过期判有效、不看剩余次数**，因为次数用尽的单子仍是这一批的身份证（convert 靠 `issuedAt` 界定哪些载荷属于这批）。次数是调用额度，过期才是生命周期。
- **扣额度与拿到载荷解耦**：被熔断门 block 的调用根本不经过 `tool_result`（pi 走 `kind:"immediate"`，不计量也不扣额），而超时 / 中断的调用计费但零载荷。所以「扣了一次却没有载荷」是正常形态，不是异常。这条同时是「在途预占只能登记在两道门都放行之后」的依据：登记在门之前的话，被拦的调用不会回来释放，`pendingCallCounts` 只增不减，几次之后整个池被假熔断且 `/reload` 前不自愈。
- **完整快照原则只对 snapshot 单**：convert 必须在同一张确认单内**同时**拿到 listing 与关键词两份载荷才写 CSV。实测负向对照：只有关键词行时 21 个指标只剩 4 个，只有 listing 行时丢 `main_cpc` 等 3 个，而**三种情况 `parseMarketCsv` 的告警数都是 0**——残缺快照会静默抹掉指标。**material 单（差评材料）不适用**：它的「完整」= 每个批准的 ASIN 都有载荷，缺的点名进 `missing_asins` 而不是整批拒绝——差评是逐 ASIN 独立的证据，少一个不会让另一个的聚类失真。只有一条评论都没拿到时才拒绝写文件。
- **映射表在宿主工作区、不在本仓库**（本仓库是公开的）：缺失或结构不全一律抛错**不降级**，且校验要在 approve 花掉真实调用**之前**跑（`parseSorftimeFieldMap` 连列名是否在 `CSV_ALIAS_HEADERS` 里都查）。转出的 CSV 是全英文表头，导入时必须显式 `source=sorftime`，否则 `detectSource` 判成 `generic_csv`，在已有的 sorftime 市场里凭空造出「多来源」。convert 给出的 `captured_at` 必须是**完整 ISO 时间戳**（`capturedAtForBatch`：这批载荷最后一次收到返回的时刻），不能只给 `YYYY-MM-DD`——导入侧把纯日期归一到 UTC 零点，而「最新快照」按 (capturedAt, importedAt) 比，同一 UTC 日早些时候手工导入的快照会把花钱补来的这份压成「旧快照」（2026-09-05 真实冒烟实测；`tests/importer.test.ts` 有正反两向用例）。导入入口（工具与 `/compass-import`）露出的 warnings 取 `snapshot.warnings` 而非 `parsed.warnings`，否则这条「早于最新快照」的告警会被吞掉。

新增工具时：在 `catalog.ts` 同时更新 `DOMAIN_TOOLS` 与 `TOOL_CATALOG`（`compass_tools` 的动态激活检索依赖后者，打分逻辑在同文件的 `rankTools`），并同步 README 工具表与 SKILL.md。`tests/tool-catalog.test.ts` 会比对 `index.ts` 里 `registerTool` 的工具名与 `DOMAIN_TOOLS`，漏登记/重复登记会直接测试红。

## 写路径与并发（踩过的坑，改写事务前必读）

- **写事务禁止嵌套**：`mutateStore`（宿主 `withFileMutationQueue`）、Web 的 `writeChain`、`store.json.lock` 三层串行都没有重入检测。在 mutator 内再开一次写事务，队列侧自等待、永久挂死且无超时；文件锁侧因「自己的 pid 存活 ⇒ 永不判 stale」空转满 10 秒后抛出误导性的「被其他进程锁定」，把排障引向跨进程冲突。读文件、查重、CSV 解析、归档等准备工作一律放在事务外（`importer.ts` 即此形状）。
- **抢锁自旋的 `await delay(50)` 必须保持默认 ref、绝不 unref**：调用方正在 await 这次写入，unref 会让 event loop 一空就退出、pending 的写静默丢失。node:test 报「Promise resolution is still pending but the event loop has already resolved」就是此病——别去加大超时或重跑 CI。代价是进程退出最多被在途写拖 10 秒（抢锁 deadline 兜底），属刻意接受的正确语义；要缩短宿主关停等待只能在**关停侧**做——`web/server.ts` 的 `close()` 用 unref 的 3 秒定时器 race 写队列，放弃等待但不打断写。
- **`npm test` 固定带 `--test-timeout=30000`，这是把挂死收敛成失败、不是放宽超时**：node:test 的默认单用例超时是 `Infinity`，上面两条坑真被踩中时用例会永远挂着，CI 只能耗到 GitHub 的 360 分钟默认上限。30 秒是**上限**，只能把挂死判成失败、不可能把失败变成通过，与 SKILL.md 的「不能靠加超时让它过」不冲突（那说的是调大既有超时把慢用例放过去）；「Promise resolution is still pending」也与它无关——那是 event loop 空转时即刻抛出的，跟超时值无关。当前最慢用例 308ms（`新鲜的活锁不会被抢走`），抢锁 deadline 上限 10 秒，30 秒已留 3 倍余量，**不要往大调**：真有用例逼近 30 秒，说明它在等一个不该等的东西。另有两点必须一起记住——超时只判用例失败、不强杀进程（挂死代码若留下 ref 的定时器 / socket，进程照样退不掉，所以 `ci.yml` 的 job 级 `timeout-minutes: 10` 必须并存），以及超时用例在汇总里记进 `cancelled` 而非 `fail`（退出码仍是 1），别拿 `grep 'fail 0'` 判绿。手跑单文件排障时也把 `--test-timeout=30000` 带上。
- **落盘前会复核锁的归属**：残留锁的回收判据（ESRCH 立即回收 / 否则看 mtime 年龄）无论把阈值取多长，都挡不住「笔记本休眠、SIGSTOP、NFS 卡顿让一个**活着**的写事务持锁超过阈值」——锁被别人回收后，原持有者若照常 rename 就会盖掉抢锁方刚写入的内容，且两边都不报错。`saveUnlocked` 因此在 rename 之前复核锁文件仍是自己那把，不是就抛 `StoreIoError` 中止本次写入。**不要为了「让写更容易成功」把这道复核去掉**：它把静默的数据丢失换成了一次可重试的失败。
- **Web 侧一切写入走 `enqueueWrite` 串行队列**（含逻辑上只读的市场报告落盘），新增写端点不得直接调 `repo.update`——文件锁只跨进程互斥，同进程并发写只会互相抢锁重试。关停顺序固定为先 `server.close()` 停 accept（drain 期间不再有新写排进队尾）、再排空写队列（3 秒兜底），不得掐断在途写事务。
- **新增 Web 写端点必须登记进 `server.ts` 的 `WRITE_PATHS`**：本服务无鉴权，POST-only 判定与「Content-Type 必须 application/json + Origin 限回环」这道跨站防线只挂在该白名单命中的那个分支上。在只读分支旁另起 `if (pathname === …)` 自行读 body 写事务照样功能正常，却静默丢掉全部写侧防护（测试只硬编码了现有路径，抓不到漏登记）。
- **快照明细（`listings` / `keywords`）不进 store.json**，导入时一次性写进 `.pi/compass/snapshots/<id>.json` sidecar，store 只留元数据。给 `MarketSnapshot` 加字段必须同步登记进 `store.ts` 的 `emptySnapshotPayload` 白名单（否则每次 save 静默抹掉）；改已导入快照的明细必须新建 snapshot id（`persistSnapshotPayload` 见文件已存在即跳过写入）。sidecar 内容 load 时只做整体 `as` 强转、`assertStore` 不逐条校验，消费侧在 sort / slice / `toFixed` 之前必须自行 `Number.isFinite` / `typeof` 过滤——坏 rank 会按原位挤占 top-N 席位，字符串数值会让前端抛错。
- **给 `assertStore` 加新硬校验前必须先确认存量 store 能通过**（新增字段一律可选 + `ensureDefaults` 回填）：load 与 save 跑的是同一份 `assertStore`，一条不合规的老记录会让 store 既读不出也写不进、扩展直接砖化，且失败被包成 StoreIoError 后只显示「读取罗盘数据失败」，看着像文件损坏而不是自己刚加的校验太严。这与上面「架构」里的回滚兼容互为反方向，向前向后两个方向都要守。

## `.claude/`：Claude Code 侧的开发期护栏

`.claude/` 是**给 Claude Code 会话用的项目级配置**，pi 宿主不读它，与 `skills/compass-selection/`（给 pi 用的运营技能）是两套东西；只对以**本仓库**为工作目录启动的 Claude Code 会话生效（从上层宿主项目根目录启动的会话不加载它）。完整说明与自测/跑分命令见 `.claude/README.md`。

- `settings.json` + `hooks/`：两道 PreToolUse 闸门——`guard-compass-data.sh` 拦对 `.pi/compass/` 与 `compass-imports/` 真实数据的误写，`precommit-gate.sh` 在 `git commit` 前跑 `npm run check && npm run test`（改动含 `.ts` / `.js` / `.css` / `.html` / `.json` / `.csv` / `.yml`，或落在 `web/assets/` / `examples/` / `tests/` 下，或是 `README.md`——它被 `static-invariants` 的工具表断言读取；其余纯文档提交放行）。两者解析失败一律 fail open，离线回归见 `.claude/hooks-selftest/`。
- `.claude/skills/secure-store-write/SKILL.md` 把本文件里**写路径 / 持久化 / hook 落盘 / 待办闭环这几个切面的主要硬约束**（注意：不等于这几个切面的全部断言）复述成生成时的检查清单，CLAUDE.md 仍是唯一真相源。已镜像的有：上面「写路径与并发」整节；「架构」段的原子写与权限位、`resolveInputPath` / `resolveOutputPath`、顶层集合的 `ensureDefaults` 迁移、报告只落 `.md`；「领域不变式」里 hook 落盘与展示预算、MCP 计量、decisionLog 白名单、派生待办 id 与状态机迁移函数、Web 写端点条数。**两边互相都不是封闭名单**——未被镜像的（如勾选侧 `assertStore` 硬校验、深研写入的前置硬门槛）照样是不变式。改到上述任一切面时一律回看 SKILL.md §0–§8 做同步，再跑 `.claude/skills/secure-store-write/evals/` 那 5 条回归用例。

## 领域不变式（有测试守护，改动不得破坏）

- 缺失硬指标 → 结论为 `review`，绝不把缺数据伪装成 pass。
- 策略 veto 规则命中即整体否决，优先于 Score（红海条件为真时 veto 胜出）。
- percentile 归一化只在同批 scan 的比较组内做；单市场运行保留策略引擎的有界基准分。
- 策略表达式由 `strategy.ts` 自研 tokenizer/parser 求值（missing 值会沿表达式传播）；禁止引入 eval / new Function。
- **未知标识符在保存期拒收，不在运行期伪装成缺数据**（M17）：合法标识符 = `LITERALS`（9 个）∪ `defaults.ts` 的 `KNOWN_METRIC_NAMES`（36 个指标名）∪ `STRATEGY_FUNCTION_NAMES`（当前只有 `qualify_rank_depth`）。校验只挂在 `parseStrategyYaml` 里那一次 dry run 上（传 `{ ruleId }` 开 strict），因此**两个写入口——默认安装与 `saveStrategyVersion`——共用同一处**，不要在 `service.ts` 里各写一遍；也**绝不要放进运行期求值**：存量 store 的 `definition` 绕过 `parseStrategyYaml`，运行期收紧等于砖化，而且 missing 传播语义必须一字不动（函数名检查提前同理，只在 strict 提前，否则 `status=missing` 会变成 `status=error`，改掉存量策略的留痕文案）。`KNOWN_METRIC_NAMES` 是**手维护**清单——`MetricMap` 是纯索引签名，四个生产者（`metrics.ts` 的 `calculateMarketMetrics` + `targetDependentMetrics`、`economics.ts` 的 `profitMetrics`、`service.ts` 的 `riskMetrics` / `reviewMetrics`）没有可派生的注册表，`report.ts` 的 `METRIC_LABELS` 缺三个名字不能当判据——**给任一生产者加指标必须同步登记**，`tests/integration.test.ts` 的双向集合等式用例会在漏登记 / 多登记时点名变红。漏一个名字比原缺陷更痛：运营写对的策略会被拒收。
- **Gate 阈值单一事实来源**（D-1 缺陷组 ②）：毛利 / CPC / 新品占比 / QRD 的数字只有两处来源——`defaults.ts` 的 `DEFAULT_GATE_THRESHOLDS`（内置 YAML 由它插值生成，逐字节与手写版相同）与运行期 `service.ts` 的 `gateThresholds(store)`（从最新**默认策略**的规则表达式经 `strategy.ts` `ruleThreshold` 读出，只认 `<metric> <op> <number>` 与 `<fn>(<number>) <op> <number>` 两种形状、数字文法与 tokenize 一致，解析不出回落常量并把字段记进 `fallbacks`，文案标「（内置默认）」）。economics / service / index 不得再以字面量比较（`tests/static-invariants.test.ts` 负向全称断言）；decisionLog `type=profit` 只中性留痕不写达标结论；`compass_profit_estimate` 无 `market_ref` 也读一次 store 取阈值。CPC 0.60 / 0.80 三条警告文案被 `gaps.ts` 与工作区 follower 逐字匹配，本批只把比较改读常量、不随策略走，改文案先补存在性断言。
- 候选卡移动强制填 reason 并写入 decisionLog；否决品保留、不删除。
- **阶段迁移的 from / to 落在字段上，不落在文案里**（M90）：`stage_move` 写 `fromStage` / `toStage` 两个可选字段，读侧统一走 `defaults.ts` 的 `isStageMoveInto`（字段在就以字段为准，只有**缺失**——存量记录——才回退解析 `conclusion` 的「→ stage」后缀）。`conclusion` 是给人看的展示串，改一句措辞不得连带改掉「深研抑制水位」（`todo.ts` 的 `stageEntryTimes`，会落进 `todoResolutions[].basis.stageEnteredAt`）与「测品/复盘停留超上限」（`history.ts` 的 `latestStageMove`）这两条判定。与 `errors.ts` 那条「错误的分类信息必须落在类型上」同一家族：**语义不许寄生在展示文案里**。字段是刻意加的可选项而不是新 `decisionLog.type` 取值（回滚红线），`assertStore` 不为它加硬校验，存量记录不回填、不清洗。
- 候选池措辞统一为「七个工作阶段 + archived 归档」（CANDIDATE_STAGES 共 8 个值），不要写成「八阶段」。
- 利润输入中大于 1 的百分比一律拒绝（`economics.ts`）。
- **预算结算月 = UTC 月**：`budgetStatus` / `evaluateMcpGate` 熔断 / TUI 预算页 / 待办 / Web 总览与预算页六个面共用 `service.ts` 的 `budgetMonth()`，任何一面都不得改用本地时间。UTC 月初 = 北京时间当月 1 日 08:00，对外文档与熔断文案必须写明这个时刻（`web/assets/app.js` 的 `formatDateShort` 是本地日，别把它用在预算面上）。
- **「最新快照」= (capturedAt, importedAt) 二元组降序**：只比 capturedAt 会让同一 UTC 日重导的修正版对所有读面不可见（Web 向导只发 YYYY-MM-DD，纯日期一律归一到同一 UTC 零点）。**纯日期**（`YYYY-MM-DD` / `YYYY/M/D` / `YYYY.M.D` / `YYYY年M月D日`，零填充与否）一律经 `csv.ts` 的 `calendarDateUtcMs` 显式按 UTC 零点构造、与运行机器时区无关，上架日期列与 `captured_at` 同口径——不能靠 `Date.parse` / `new Date(原串)`：只有零填充的 ISO 形态按 UTC 解释，`2025-1-1` 这类会落到 V8 旧版解析器按本机本地零点算，UTC+8 下少一天、每月 1 号上架的行月龄多一个月（D-1 缺陷组 ③，`tests/helpers/time-zones.ts` 四时区用例守着）。不存在的日期（2 月 30 日）上架列判缺失、`captured_at` 拒绝；**不带时区的日期时间**（`2026-09-01 10:00`）仍按本机本地解释，是已知未消除的歧义，要跨机器一致只用纯日期或带时区 ISO。全部取最新的地方共用 `defaults.ts` 的 `compareSnapshotRecency` / `compareSnapshotRecencyDesc` / `isNewerSnapshot`，包括 `todo.ts` 的 `divergenceWatermarks` 指纹——指纹不跟着变就是漏提醒。`capturedAt` 的 [2000-01-01, now+36h] 区间校验只在写入侧（`normalizeCapturedAt`），不得放进 `assertStore`。
- Lesson 必须挂非空且可解析的 evidence；OutcomeCheck 缺少新快照或数字实绩时 verdict 只能是 `inconclusive`，不得伪装成 `validated`。waitlist 锚点的 OutcomeCheck 恒为 `inconclusive`（没有可比的期望结果，不进四率也不进 backtest 对齐；`isComparableCheck` 只认 go / no_go，是四率、`latestComparableChecks`、`desiredOutcomeForCheck` 与 backtest 共用的唯一判据）。统计披露四桶互斥且恒等：`total = comparable + strategyOnly + waitlistAnchored + inconclusive`，口径唯一所有者是 `history.outcomeStatistics`，`compass_history` header / 复盘报告 §1 / Web 复盘页只透传不自算（D-1 缺陷组 ①）。
- 热路径 hook（before_agent_start / tool_call / tool_result / session_before_compact）只做只读计算、展示增强、上下文注入与调用拦截，绝不开 store 写事务；只有 `session_start`（ensureDefaults 回填）与 `session_shutdown`（兜底落账）两个生命周期 hook 例外，且写入必须包在 `withFileMutationQueue` 内串行落盘。**`modelRegistry.complete` 与任何 `*Dispatch(` 调用视同写事务标记**：派发会花钱、走网络、可能等上两分钟，出现在热路径里比一次落盘更糟；`compass_dispatch` 的注册块也必须排在所有 `pi.on(...)` 之前，否则 `hookBodies` 切片器会把它整块算进某个 hook（与 `/compass-fill` 同一条规则）。历史速览 ≤12 行，工具历史尾注 ≤8 行，压缩台账 ≤20 行。工具尾注实际由 `history.ts` 导出的 `HISTORY_NOTE_LIMITS.footer`（7 行 / 650 字）收口，且【补数缺口】与【历史对照】**共用这一个预算**：缺口先切 `HISTORY_NOTE_LIMITS.gap`（5 行 / 400 字）并排在前，剩余额度才给历史对照；`renderHistoryNote` 的初切上限是 `HISTORY_NOTE_LIMITS.note`（8 行 / 1600 字）。三组数字只在 `HISTORY_NOTE_LIMITS` 定义一次，`index.ts` 的 `tool_result` 与 `/compass-import` 都读它（`tests/static-invariants.test.ts` 钉着，手写数字会红）——改上限只改常量，并同步这里与 secure-store-write SKILL 的数字。两段各归各的开关（缺口归 `/compass-fill`，历史对照归 `/compass-history-brief`），互不遮蔽。
- MCP 调用计量遵守同一约束：tool_result hook 只做内存 pending 自增，落账仅在安全点事务内（mutateStore 顺带 / 查看面 flush / session_shutdown 尽力）。**熔断口径 = 已落账 + 已完成待落账（`pendingUsage`）+ 已放行在途（`inflightMcpCalls`）**：宿主同一轮是「先把整批的 tool_call 判定跑完，再 Promise.all 执行」，少了在途这一项，一批 k 个调用会各自看到同一个旧计数而全部放行，触限前一次都不落地。在途预占在 `tool_call` 两道门都**早退之后**登记（锚点是 `if (refusal) return …` 那一行，不是 `gapfillTicketGate(` 的调用点——塞在调用与早退之间等于登记了被拦的调用）、在 `tool_result` 最前释放，只并进 `pendingCallCounts()`，**不参与落账**——它还没回结果，落账它会与 tool_result 的自增双计。**释放不是万无一失的**：用户 ESC 中断（宿主在 `beforeToolCall` 返回后立刻查 `signal.aborted`）与后加载扩展的 block 都走 `kind:"immediate"`、不产生 `tool_result`，条目会留在工厂闭包里活到整个 pi 进程结束（不随会话销毁），表现是「明明没调几次却说熔断了」。所以 `before_agent_start` 首行（早退守卫**之前**）无条件 `inflightMcpCalls.clear()`——新一轮开始时上一轮要么已释放要么已中断，剩下的按定义就是泄漏；`INFLIGHT_CALLS_MAX` 的有界 FIFO 只是同一轮内的第二道兜底。
- **计费口径是拒绝名单，不是白名单**：`classifyMcpToolResult` 只把 `NON_BILLABLE_MCP_ERRORS`（pi-mcp-adapter 的 `details.error` 全量取值里「请求没发出去」的那些）判为不计费，其余一律计——`call_failed`（30 秒超时 / 服务端 JSON-RPC 错误应答 / 发出后中断）与 `aborted` 都发生在 `callTool` 之后，点数已经扣了。改回白名单会让最贵的一类调用漏计、`monthly_call_limit` 熔断滞后；方向上宁多勿漏。
- **归因回退链顺序固定**：`details.tool` → `details.resourceUri` → `<池名>_` 前缀截取 → `"unknown"`。第三档不是可有可无的兜底——adapter 的 direct 工具只在**成功**分支带 `tool`，失败分支（`tool_error` / `call_failed` / `aborted` / `url_elicitation_required`）只有 `{error, server}`，少了它 `recordMcpUsage` 的 `server + tool` 合并键会把同一批里几个不同工具的失败撞成一条「unknown × N」，工具维度事后不可恢复。把前缀档插到 `resourceUri` 之前会让资源读的归因退化成工具名；截出空串（`toolName` 恰为 `<池名>_`）必须回落 `"unknown"`，载荷缓存那侧没有落账的 `|| "unknown"` 兜底。归因**不参与计费判定**，上一条的拒绝名单仍是 billable 的唯一口径。
- **熔断口径 = 计量口径，判据是白名单**：不向服务端发 `tools/call` 的网关形态（列工具 / `describe` / `search` / `instructions` / `connect` / `action=ui-messages|auth-start|auth-complete`）既不花钱也不该被熔断拦——计量侧早就是这条界线（`classifyMcpToolResult` 对 `mode !== "call"` 返回 undefined），熔断门从前漏了它，池一熔断 agent 连「这个源有哪些工具」都问不出来。判据是 `service.ts` 的 `isMcpNonCallGateway`，走 `MCP_NON_CALL_GATEWAY_KEYS` / `..._ACTIONS` 两份**白名单**：名单之外的一切——`tool`、把参数套进 `args` 的兼容形态、`action` 的未知取值、adapter 将来新增的键——一律当调用照拦。与上一条不冲突，两条都朝「别把钱漏出去」偏：那条管**计不计费**（拒绝名单，宁多勿漏），这条管**拦不拦**（白名单，宁少勿滥）。它比 `index.ts` 的 `isGatewayCall`（确认单预扣与在途预占用的那份）**严格更保守**：白名单判非调用 ⇒ 那边也判非调用，反之不成立。
- **预算池 `enabled=false` = 不可调用**：`recordCost` 拒绝落账、`compass_data_route` 判为不可用、`evaluateMcpGate` 必须拦截，三处同口径；禁用判定要排在「配了上限才拦」的前提之前，否则默认零成本池（sorftime ¥0、无次数上限）禁用后照样放行。上一条的非调用豁免只覆盖熔断、**不覆盖禁用**（禁用说的是「当前不允许使用这个源」，与花不花钱无关），所以 `evaluateMcpGate` 的判定顺序固定为 禁用 → 非调用豁免 → 有可生效上限 → fused。
- **`compass_gaps approve` 的熔断预检必须带真工具名发问**：那条预检问的是「这批 N 次调用做得完吗」，从前用「有 server 无 tool」的合成形态发问，而那正是非调用豁免的形状——不带 `chain[0].tool` 它会被自己的豁免打成永远放行，运营拿到一张注定中途熔断的确认单、前几次真钱照花。这条链路没有行为级覆盖（测试不 import `index.ts`），只有 `tests/static-invariants.test.ts` 钉着发问的那一行。
- 待办是**混合语义**：条目本体永远由 `todo.ts` 派生（唯一所有者，不实体化、不双真相源），但闭环四类（`metric_divergence` / `budget_warning` / `budget_fused` / `deep_missing_data`）另有持久化的处理记录 `store.todoResolutions`，派生层把记录合成到条目上（状态徽标 / 抑制 / 失效浮出）。其余六类仍是「条件解决即消失」。
- 派生待办 id（`todo_<kind>_<市场/候选/来源>` 拼接）是条目与 `store.todoResolutions.todoId` 之间唯一的关联键，assertStore 只校验它全局唯一、悬空记录一律静默忽略，因此这个字符串本身已是持久化数据格式的一部分：改闭环四类的 id 拼法、kind 取值或实体 id 来源，必须连带迁移存量记录，否则已勾选条目重新浮出、已处理分区留下永久孤儿且全程无报错。
- 处理记录的状态机（提交 → 验证 → 勾选 → 重开）只能经 `service.ts` 的四个函数迁移；`assertStore` 硬校验「勾选必须存在验证通过的末轮 + 该类水位锚点」，杜绝未经验证的已处理——同 OutcomeCheck「无证据不得非 inconclusive」。
- 处理动作**不写 decisionLog**：旧版 assertStore 对 `decisionLog.type` 是严格白名单，新增取值会让回滚后的 store 打不开。审计链由记录自身承载（每个动作含 actor / 时间 / 说明或理由），`history.ts` 在**读侧**合并成时间线事件。
- 抑制必须带失效水位（预算=月份、偏差=参与比较的快照集合指纹、深研=本次进入 deep_research 的周期）：水位失效即重新浮出。派生层只读判定、绝不改写记录；错位的最坏情况必须是「多提醒一次」，绝不能是漏提醒。
- 验证只在 pi 会话由 agent 执行（`compass_todo action=verify`）：Web 端无 LLM 通道，待办闭环在 Web 侧只有 submit/complete/reopen，不得新增 verify 端点（Web 写端点共 7 条，另四条是 pool/move、pool/decide、import、report）。深研类的代码硬门槛（四指标齐备 + 该市场有利润测算）在 service 层前置于任何写入，不满足时 `verdict=pass` 直接拒绝落库。

## 进程内子代理不变式（`compass_dispatch` + `dispatch.ts`）

它把材料或几条 store 事实交给一个小模型，拿回结构化 JSON。**这是全仓唯一会把数据发出本机的功能**（MCP 取数之外），所以边界比别处密。

- **零工具**：传给 `complete` 的 Context 没有 `tools` 键。第一道是类型——`DispatchContext` 里就没有这个字段；第二道是运行期键集断言（`Object.keys(context)` 恰为 `messages` 与 `systemPrompt`），它能抓住用展开塞进来的、tsc 看不见的额外键。两道都要留：只有类型时，一次 `...({tools:[]} as Record<string, unknown>)` 就能绕过去且编译零报错。
- **零子进程、零 store 写、零落盘**：`dispatch.ts` 不出现 `child_process` 与 spawn / exec 那一族（负向全称断言，注释里也不能写出这些标识符）；execute 用只读的 `readStore` 而不是 `readStoreFlushingUsage`（后者在有未落盘计量时会真开一次写事务）；子代理输出只回到工具结果里，材料只从 `materials/` 读。
- **收束靠两道**：合并 signal 是主路径，工具 signal 与超时 signal **各留引用**才分得清「派发已取消」与「派发超时」；`withDeadline` 是「供应商不理 abort」时的第二兜底。整段共享一个 deadline，重问不刷新——否则 120 秒硬超时会在重问后悄悄变成 240 秒。
- **校验是硬门**：三个子代理各有 schema 校验函数，失败就把错误清单作为第二条 user 消息、上一条 AssistantMessage 原样放回后重问**一次**，再失败即返回失败结果、不写回。`estimated_rating` 必须显式为 `null`——预估星级由人给，不让模型猜。注意写回工具的该参数是 `Type.Optional(Type.Number(...))`，**TypeBox 的 Optional 不接受 null**，所以主会话真去写回时必须省掉这个键。
- **校验放宽只放形态、不放来源**（2026-09-06 真实冒烟核出）：`evidence` 的逐字比对走 `foldForEvidenceMatch`，两边同一套归一——折叠空白之外还放宽**首字母大小写**与**印刷体标点**（`‘ ’ “ ” – — …` 对 ASCII）。这两类是「模型合规引用」与「材料原文」之间必然出现的差异：把整句当句中引文引用时首字母会变小写，弯引号会被规范成直引号。首次真实冒烟四次校验失败**全部**属于此类，被点名的句子在材料里逐条都找得到，模型一个字都没编——旧的大小写敏感比对等于让默认模型必然失败、每失败一次烧一次钱。放宽到此为止：判据仍是「必须在材料里找得到」，编造的句子照样红，`tests/dispatch.test.ts` 有反向对照。同类前科是 `materialCorpus` 对转义 JSON 的归一，都属于「合规输出被判失败」这一族，再遇到先怀疑比对而不是模型。
- **`review_count` 是等值判据，不是上界**：它必须**等于**材料里的评论行数（`materialReviewCount`），少报多报都判失败；材料解析不出 `reviews` 数组（手工材料）时跳过该判定。只查 `Σcount ≤ review_count` 是不够的——那只在模型自报的数字内部自洽，少报照样过，而 `share` 的分母与写回 `compass_reviews_record` 的条数都取自它（真实冒烟：材料 72 条，三次输出报 55 / 70 / 70，无一对上）。配套地，`<material>` 元信息把「实际 N 条」直接写给子代理，别让它自己数上百条。
- **usage 形状永远完整**：宿主的会话统计是 `totals.cost += usage.cost.total`，没有可选链——缺 `cost` 会当场抛 TypeError 而不是显示 NaN。中止与失败路径也要给全零但完整的形状。
- **会话计数在 `session_start` 清零**：`/reload` 会以 `reason: "reload"` 重发 session_start，所以新会话与 `/reload` 都覆盖到。删掉那一行清零调用，40 次上限会变成跨会话累积拒绝。
- **内部口径不进 prompt**：子代理只拿市场名 / 类目 / 候选标题 / 待查风险类别 / 取了假设值的字段名，**绝不发金额**。工作区的内部提示层由主会话在结果**下方**本地拼接，`dispatch.ts` 连读都不该读到它。工作区的 `.pi/agents/*.md` 覆盖文件正文会**逐字**出境，那边另有一套自动化检查。
- **受限会话四层拦截**：guard 的工具名单（每轮重跑过滤）、execute 首行自拒、`before_agent_start` 禁语、跨仓库钉子。四层都是软件逻辑。曾有第五层硬边界——启动器不给受限会话播种子代理默认模型的凭据——但 **2026-09-07 起该层不在**：宿主侧只剩一家有效凭据，继续剥它受限会话就没有任何模型可用（实测整个模式起不来）。所以现在挡住付费派发的**只有这四层软件逻辑**，改 `compass_dispatch` 的 action 枚举时务必让跨仓库钉子先红再动。宿主凭据恢复多家后应把该层加回。

## 文档与数据卫生

- README 工具表、运营使用手册.md、运营速查卡.md、skills/compass-selection/SKILL.md 是运营可见的产品表面：改工具、命令或默认阈值时必须同步这四处。
- 用户可见字符串与文档用中文，代码标识符用英文；缩进用 tab。
- `examples/` 中的数据必须保持虚构（B0DEMO 前缀 ASIN、虚构品牌），不得出现真实品牌或真实经营数据；公开文档不引用内部 PRD 路径。
- 不保存任何平台凭据、不自动登录或绕过验证码；AI 风险初筛不得表述为法律意见。
