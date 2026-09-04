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

Node >= 22.19；无 build 产物。**没有 lint，静态检查全部由 `tsconfig.json` 的编译开关承担**——`strict` 之外另开了 `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch` / `noImplicitOverride` 与 `allowUnreachableCode: false`（实测不增加 tsc 耗时），不要为了让 `npm run check` 过而关掉其中任何一个。CI（`.github/workflows/ci.yml`）在 Node 22/24 上跑 test + check，job 级 `timeout-minutes: 10` 兜底。

## 关键约束：依赖由 pi 宿主提供

运行时依赖只有 `yaml`。`@earendil-works/pi-*` 与 `typebox` 在运行时由 pi 宿主解析提供，devDependencies 声明它们只为 IDE 类型与 `npm run check`：

- `typebox` 必须钉在 **1.3.7**（与宿主捆绑版本一致）；升级会触发 tsc TS2589 深度实例化错误。
- `@earendil-works/pi-coding-agent` 自带 npm-shrinkwrap，其依赖嵌套安装、不 hoist，因此 `pi-ai` / `pi-tui` 必须在 devDependencies 显式声明 tsc 才能解析。
- 不要把 pi 系列包挪进 dependencies 或打包进扩展。

## 架构

单向分层：`index.ts`（18 个领域工具 + `compass_tools` 路由 + 9 个 slash command 的注册薄层及只读 hook）→ `importer.ts` / `gapfill-convert.ts` / `service.ts` → 领域模块 `csv.ts` / `metrics.ts` / `economics.ts` / `strategy.ts` / `history.ts` / `todo.ts` / `gaps.ts` / `report.ts` → `store.ts`（持久化）。`service.ts` 承载纯内存的编排与业务规则（第一参数约定为 store 数据对象，`importContentHash` 等少数纯工具函数除外，不接触磁盘）；`importer.ts` 是 CSV 导入链路上唯一做文件 I/O 的编排模块（路径解析→查重→解析→归档→写事务），事务语义由调用方经 `deps.mutate` 注入，pi 会话与其他入口可共用同一链路。`gapfill-convert.ts` 与它平级（同为编排层、同样做文件 I/O），只 import `csv.ts` 与 `store.ts` 的类型，绝不反向被纯函数层 import。`types.ts` 是共享数据模型；`ui.ts` 只做六页 TUI 渲染（总览/待办/市场/候选池/预算/复盘）。测试直接 import service 与领域模块、不经过 `index.ts`，因此脱离 pi 宿主即可运行。

Web UI（`web/` 目录，TUI 之外的第二套前端，读同一个 store）：`data.ts`（DTO 组装层，纯函数 `(store, ...) => JSON 安全对象`，每页一个入口，不 import node:http、不接触磁盘——**这是模块 import 层的约束，不等于「读端点零磁盘 I/O」**：`data.ts` 调的 `listWorkbenchTodos` → `metricDivergences` 对**多来源市场**会按当前 q 重算 QRD，从而触发快照明细 sidecar 的懒读；单来源市场被提前退出挡住，真实 store 目前 0 个多来源市场）→ `server.ts`（node:http 服务：`startCompassWebServer` 统一入口，路由/静态资源/写队列/回环地址与同源校验，只绑定 127.0.0.1）→ `standalone.ts`（脱离 pi 的独立入口，`COMPASS_ROOT` 指定宿主项目，供 `npm run web` 使用）；`assets/`（`index.html`/`style.css`/`app.js`/`markdown.js`，纯 JS 单页应用、无框架无构建步骤，hash 路由八个视图；`app.js`/`style.css` 不在 `tsconfig.json` 的 `include` 范围内，`npm run check` 不检查它们）。`markdown.js` 是唯一例外：它被 `app.js` 静态 import（404 会让整张页面白屏，不只是弹窗坏掉），同时是纯函数、能脱离 DOM 跑，因此由 `tests/web-markdown.test.ts` 覆盖，并靠同目录手写的 `markdown.d.ts` 让 tsc 解析那次 import。市场档案的五维报告只在浏览器端把 Markdown 渲染成 HTML 弹窗阅读，**落盘产物仍然只有 `.md`**（`resolveOutputPath` 硬性要求 `.md` 扩展名），不要为了「看得好看」再生成一份 HTML 文件。`index.ts` 的 `/compass-web` 命令与 `standalone.ts` 共用同一个 `server.ts:startCompassWebServer`，行为一致；不做鉴权（本机单用户模型），文档与实现都要强调禁止端口转发暴露到局域网。**外链策略**：`index.html` 保留唯一一条 Google Fonts 外链（IBM Plex，设计系统指定的字体，回退栈见 `web/assets/style.css` 的 `--f-sans` / `--f-mono`），但**必须是非阻塞形态** `media="print" onload="this.media='all'" referrerpolicy="no-referrer"`——实测 render-blocking 写法在字体主机不可达（断网/被墙）时会让 `app.js` 根本不执行、一个 `/api` 请求都不发，页面永久停在「正在加载罗盘工作台…」；离线时由 `style.css` 的 `--f-sans` / `--f-mono` 回退栈接管。除这一条外 `app.js` / `markdown.js` / `style.css` 一律零外链，要加第二条外链先回来改这一段（`tests/web-assets.test.ts` 会拦）。

数据流：CSV 导入（`csv.ts`：UTF-8/16 解码并在非法 UTF-8 时回退 GB18030、按每行计数一致性嗅探分隔符、中英文字段别名映射、数值列白名单式解析、关键词行去重）→ 生成不可变市场快照并把原始文件归档到 `raw/` → `metrics.ts` 计算五维指标，每个数字都是 MetricEvidence（value + source + capturedAt + confidence）→ `strategy.ts` 执行 GSE（Gate → Score，veto 命中即整体否决）→ 候选卡按阶段流转并写 decisionLog → `report.ts` 输出五维 Markdown 报告。

持久化（`store.ts` 的 CompassRepository）：单一 JSON store（schemaVersion 1，load 时 assertStore 校验）写入**宿主项目**（运行 pi 的 cwd）的 `.pi/compass/`，而不是扩展自身目录。新增顶层集合一律走「可选数组 + `ensureDefaults` 回填 + `load()` 迁移检测与回写」（`outcomeChecks` / `lessons` / `todoResolutions` 是先例），schemaVersion 保持 1，旧版扩展回滚后忽略新字段即可打开。写入走临时文件 + rename 原子替换，目录 0700、文件 0600。`resolveInputPath` / `resolveOutputPath` 把一切输入输出路径限制在宿主项目内——不要绕过它们直接拼路径。

补数缺口（`gaps.ts`）与待办同属「不实体化」的只读派生：不落 store、不新增顶层集合。`deriveGaps` 必须由调用方把已算好的 `listWorkbenchTodos` 结果传进来——它对多来源市场会经 `metricDivergences` 触发快照明细的同步读，模块自己再算一遍就是同一次写事务里多一次磁盘 I/O。唯一落盘是补数档位与静音清单（`gapfill/state.jsonc`），只从 `/compass-fill` 命令 handler 写（命令不是 hook，是天然安全点；写它的队列 key 与 store 不同，不构成嵌套）。文件名必须用 `.jsonc` 扩展名：本文件下面那条 bash 读守卫的正则会拦住 `.json` 结尾的读命令。`/compass-fill` 的注册位置也不自由——它的 handler 带写事务标记，必须排在所有 `pi.on(...)` **之前**，否则会被 `tests/static-invariants.test.ts` 的 hook 切片器算进某个热路径 hook 而直接测试红。

A 档补数（`compass_gaps approve` / `convert` + `gapfill-convert.ts`）另有四条不变式：

- **确认单只有一张，且是内存的**：`gapfillTicket` 是 `index.ts` 里的单变量而不是 Map——「同一时刻只有一张」若靠 Map 就成了要自觉遵守的约定。它只活到 `/reload`；`activeGapfillTicket()` **只按过期判有效、不看剩余次数**，因为次数用尽的单子仍是这一批的身份证（convert 靠 `issuedAt` 界定哪些载荷属于这批）。次数是调用额度，过期才是生命周期。
- **扣额度与拿到载荷解耦**：被熔断门 block 的调用根本不经过 `tool_result`（pi 走 `kind:"immediate"`，不计量也不扣额），而超时 / 中断的调用计费但零载荷。所以「扣了一次却没有载荷」是正常形态，不是异常。
- **完整快照原则**：convert 必须在同一张确认单内**同时**拿到 listing 与关键词两份载荷才写 CSV。实测负向对照：只有关键词行时 21 个指标只剩 4 个，只有 listing 行时丢 `main_cpc` 等 3 个，而**三种情况 `parseMarketCsv` 的告警数都是 0**——残缺快照会静默抹掉指标。
- **映射表在宿主工作区、不在本仓库**（本仓库是公开的）：缺失或结构不全一律抛错**不降级**，且校验要在 approve 花掉真实调用**之前**跑（`parseSorftimeFieldMap` 连列名是否在 `CSV_ALIAS_HEADERS` 里都查）。转出的 CSV 是全英文表头，导入时必须显式 `source=sorftime`，否则 `detectSource` 判成 `generic_csv`，在已有的 sorftime 市场里凭空造出「多来源」。

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
- 候选卡移动强制填 reason 并写入 decisionLog；否决品保留、不删除。
- 候选池措辞统一为「七个工作阶段 + archived 归档」（CANDIDATE_STAGES 共 8 个值），不要写成「八阶段」。
- 利润输入中大于 1 的百分比一律拒绝（`economics.ts`）。
- **预算结算月 = UTC 月**：`budgetStatus` / `evaluateMcpGate` 熔断 / TUI 预算页 / 待办 / Web 总览与预算页六个面共用 `service.ts` 的 `budgetMonth()`，任何一面都不得改用本地时间。UTC 月初 = 北京时间当月 1 日 08:00，对外文档与熔断文案必须写明这个时刻（`web/assets/app.js` 的 `formatDateShort` 是本地日，别把它用在预算面上）。
- **「最新快照」= (capturedAt, importedAt) 二元组降序**：只比 capturedAt 会让同一 UTC 日重导的修正版对所有读面不可见（Web 向导只发 YYYY-MM-DD，纯日期一律归一到同一 UTC 零点）。全部取最新的地方共用 `defaults.ts` 的 `compareSnapshotRecency` / `compareSnapshotRecencyDesc` / `isNewerSnapshot`，包括 `todo.ts` 的 `divergenceWatermarks` 指纹——指纹不跟着变就是漏提醒。`capturedAt` 的 [2000-01-01, now+36h] 区间校验只在写入侧（`normalizeCapturedAt`），不得放进 `assertStore`。
- Lesson 必须挂非空且可解析的 evidence；OutcomeCheck 缺少新快照或数字实绩时 verdict 只能是 `inconclusive`，不得伪装成 `validated`。
- 热路径 hook（before_agent_start / tool_call / tool_result / session_before_compact）只做只读计算、展示增强、上下文注入与调用拦截，绝不开 store 写事务；只有 `session_start`（ensureDefaults 回填）与 `session_shutdown`（兜底落账）两个生命周期 hook 例外，且写入必须包在 `withFileMutationQueue` 内串行落盘。历史速览 ≤12 行，工具历史尾注 ≤8 行，压缩台账 ≤20 行。工具尾注实际由 `capHistoryLines(…, 7, 650)` 收口，且【补数缺口】与【历史对照】**共用这一个预算**：缺口先切 5 行 / 400 字并排在前，剩余额度才给历史对照——改任一段的行数上限都要同时改这里与 `index.ts` 的 `tool_result`。两段各归各的开关（缺口归 `/compass-fill`，历史对照归 `/compass-history-brief`），互不遮蔽。
- MCP 调用计量遵守同一约束：tool_result hook 只做内存 pending 自增，落账仅在安全点事务内（mutateStore 顺带 / 查看面 flush / session_shutdown 尽力）。
- **计费口径是拒绝名单，不是白名单**：`classifyMcpToolResult` 只把 `NON_BILLABLE_MCP_ERRORS`（pi-mcp-adapter 的 `details.error` 全量取值里「请求没发出去」的那些）判为不计费，其余一律计——`call_failed`（30 秒超时 / 服务端 JSON-RPC 错误应答 / 发出后中断）与 `aborted` 都发生在 `callTool` 之后，点数已经扣了。改回白名单会让最贵的一类调用漏计、`monthly_call_limit` 熔断滞后；方向上宁多勿漏。
- **预算池 `enabled=false` = 不可调用**：`recordCost` 拒绝落账、`compass_data_route` 判为不可用、`evaluateMcpGate` 必须拦截，三处同口径；禁用判定要排在「配了上限才拦」的前提之前，否则默认零成本池（sorftime ¥0、无次数上限）禁用后照样放行。
- 待办是**混合语义**：条目本体永远由 `todo.ts` 派生（唯一所有者，不实体化、不双真相源），但闭环四类（`metric_divergence` / `budget_warning` / `budget_fused` / `deep_missing_data`）另有持久化的处理记录 `store.todoResolutions`，派生层把记录合成到条目上（状态徽标 / 抑制 / 失效浮出）。其余六类仍是「条件解决即消失」。
- 派生待办 id（`todo_<kind>_<市场/候选/来源>` 拼接）是条目与 `store.todoResolutions.todoId` 之间唯一的关联键，assertStore 只校验它全局唯一、悬空记录一律静默忽略，因此这个字符串本身已是持久化数据格式的一部分：改闭环四类的 id 拼法、kind 取值或实体 id 来源，必须连带迁移存量记录，否则已勾选条目重新浮出、已处理分区留下永久孤儿且全程无报错。
- 处理记录的状态机（提交 → 验证 → 勾选 → 重开）只能经 `service.ts` 的四个函数迁移；`assertStore` 硬校验「勾选必须存在验证通过的末轮 + 该类水位锚点」，杜绝未经验证的已处理——同 OutcomeCheck「无证据不得非 inconclusive」。
- 处理动作**不写 decisionLog**：旧版 assertStore 对 `decisionLog.type` 是严格白名单，新增取值会让回滚后的 store 打不开。审计链由记录自身承载（每个动作含 actor / 时间 / 说明或理由），`history.ts` 在**读侧**合并成时间线事件。
- 抑制必须带失效水位（预算=月份、偏差=参与比较的快照集合指纹、深研=本次进入 deep_research 的周期）：水位失效即重新浮出。派生层只读判定、绝不改写记录；错位的最坏情况必须是「多提醒一次」，绝不能是漏提醒。
- 验证只在 pi 会话由 agent 执行（`compass_todo action=verify`）：Web 端无 LLM 通道，待办闭环在 Web 侧只有 submit/complete/reopen，不得新增 verify 端点（Web 写端点共 7 条，另四条是 pool/move、pool/decide、import、report）。深研类的代码硬门槛（四指标齐备 + 该市场有利润测算）在 service 层前置于任何写入，不满足时 `verdict=pass` 直接拒绝落库。

## 文档与数据卫生

- README 工具表、运营使用手册.md、运营速查卡.md、skills/compass-selection/SKILL.md 是运营可见的产品表面：改工具、命令或默认阈值时必须同步这四处。
- 用户可见字符串与文档用中文，代码标识符用英文；缩进用 tab。
- `examples/` 中的数据必须保持虚构（B0DEMO 前缀 ASIN、虚构品牌），不得出现真实品牌或真实经营数据；公开文档不引用内部 PRD 路径。
- 不保存任何平台凭据、不自动登录或绕过验证码；AI 风险初筛不得表述为法律意见。
