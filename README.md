# 罗盘 Compass · pi Extension

> **Compass** is a project-level extension for the pi coding agent that turns the terminal into an Amazon US product-research workbench: market CSV snapshots, five-dimension metrics, a versioned Gate/Score screening DSL (GSE), profit & payback modeling, risk and negative-review logging, a candidate pipeline, evidence-backed retrospectives, deterministic history retrieval, and data-budget discipline. Requires Node.js >= 22.19. Documentation is primarily in Chinese.

面向 Amazon US 精铺选品的项目级 pi Extension，把选品工作流落到终端：CSV 快照、五维指标、GSE 策略、利润测算、风险/差评留痕、候选池、结果复盘、历史检索、预算和报告。

> 运营人员请阅读：[运营使用手册](./运营使用手册.md)；日常可打印：[运营速查卡](./运营速查卡.md)。实际 CSV 统一放入宿主项目（运行 pi 的项目）根目录下的 `compass-imports/`（需自行创建）。

## 安装

前置要求：已安装 pi coding agent；Node.js >= 22.19。

在你的宿主项目根目录执行：

```bash
git clone https://github.com/Cy4nLiang/compass-pi-extension.git .pi/extensions/compass
cd .pi/extensions/compass
npm install
cd ../../..
pi
```

`.pi/extensions/compass/index.ts` 位于 pi 的项目级 Extension 自动发现位置，启动 pi 即会加载；已启动 pi 时执行 `/reload`。项目级 Extension 只会在项目被信任后加载。

运行时依赖只有 `yaml` 一个包；`@earendil-works/pi-*` 与 `typebox` 由 pi 宿主在运行时提供，devDependencies 中声明它们只是为了 IDE 类型提示与 `npm run check`。

## 快速体验

```text
/compass
/compass-import .pi/extensions/compass/examples/demo-market.csv
# 市场名输入：yoga mat strap demo
/compass-report yoga mat strap demo
```

示例 CSV 中的 ASIN、品牌与全部数字均为虚构演示数据，见 [examples/README.md](./examples/README.md)。

也可以直接对 agent 说：

```text
导入这个卖家精灵 CSV，按精铺日均10单模板粗筛，然后做利润测算并出报告。
```

Agent 会先调用 `compass_tools`，按需动态激活相关工具。

## 工具

| 工具 | 用途 |
|---|---|
| `compass_tools` | 搜索并动态启用罗盘工具，减少初始工具上下文 |
| `compass_lead` | 把词根/竞品/榜单灵感建立为线索与候选卡 |
| `compass_import_csv` | 自动字段映射、归档原文件、创建市场快照与候选卡 |
| `compass_market_scan` | 按 Gate/QRD/新品占比/CPC 筛选市场 |
| `compass_market_report` | 五维报告 + GSE + Evidence + 决策回放 |
| `compass_profit_estimate` | 毛利、BE-CPC、三情景净利、启动资金、回本 |
| `compass_strategy_run` | 执行 screen/full GSE 策略 |
| `compass_strategy_manage` | YAML 策略 list/get/save/clone，自动版本化 |
| `compass_pool` | 候选池管理；阶段、Gate 和最终 `go/waitlist/no_go` 状态均强制记录原因；`get` 输出附市场 Amazon 搜索链接与 Top5 竞品链接 |
| `compass_risk_check` | 认证/IP/季节/政策/物流风险及官方证据 |
| `compass_reviews_record` | 差评主题、Kano 可改良性、星级差 |
| `compass_budget` | 数据源预算与 MCP 调用计量（`cost_per_call_cny` 单价、`monthly_call_limit` 次数上限）、80% 告警、100% 熔断、市场归因 |
| `compass_todo` | 工作台待办清单：自动推导需人工干预的事项（复核/补数/复盘/预算等 10 类），P1–P5 优先级；事项条件解决即消失，另有四类（多源偏差、预算 80% 告警、预算熔断、深研数据）的人工处理系统感知不到，走「提交处理结果 → agent 验证 → 勾选已处理」闭环，`action=submit/verify/complete/reopen` |
| `compass_asin_history` | 本地 ASIN 跨快照历史 |
| `compass_keyword_metrics` | 本地关键词搜索量/CPC 历史 |
| `compass_data_route` | 按字段 × 新鲜度 × 阶段 × 预算生成补数计划 |
| `compass_gaps` | 汇总数据缺口并按成本档给出补数计划；`approve` 当面确认后授权付费补数，`convert` 把返回体确定性地转成可导入的 CSV |
| `compass_history` | 时间线、决策检索、相似市场、OutcomeCheck 统计与经验卡 |
| `compass_retro` | 到期复盘、快照对照、实绩录入、复盘报告、策略回测与 Lesson 管理 |

所有带 `strategy_id` 的工具（`compass_market_scan`、`compass_market_report`、`compass_strategy_run`、`compass_strategy_manage` 的 `get`/`clone`、`compass_retro` 的 `backtest`）用同一种写法：策略 id、策略名称，或 `id@vN` 锁定历史版本；不写 `@vN` 时一律取该策略的最新版本。

## Slash commands

- `/compass-help`：在 pi 会话中显示运营使用手册
- `/compass`：六页 TUI（总览 / 待办 / 市场 / 候选池 / 预算 / 复盘）
- `/compass-web [端口|stop]`：启动本地浏览器版工作台（八页：总览/待办/市场/市场档案/候选池/预算/复盘/导入），无参复用已在跑的服务，数字参数指定端口，`stop` 关闭
- `/compass-import <csv>`：交互导入
- `/compass-report [market_id|市场名]`：生成报告并作为 TUI 会话条目显示
- `/compass-strategy [策略 id|名称|id@vN]`：编辑 YAML 并保存新版本（写 `@vN` 可基于历史版本改，保存仍是追加新版本）
- `/compass-retro`：交互式复盘会（到期项 → 对照/实绩 → 报告 → Lesson）
- `/compass-history-brief on|off`：切换本会话自动历史速览与工具尾注
- `/compass-fill status|guided|strict|off|mute <gap_id或market_ref> [天数]|unmute <gap_id或all>`：补数缺口提示的档位与静音（跨会话保留）

## Web 工作台

不想用 TUI 也可以用浏览器：在 pi 会话里输入 `/compass-web`，会打印本机访问地址（默认 `http://127.0.0.1:4780`，浏览器打开即可）；`/compass-web 5000` 指定端口；`/compass-web stop` 关闭。会话结束（含正常退出、`/reload` 等触发的会话重建）会自动兜底关闭。

候选池页点开候选卡即进入**全屏单品决策页**：Amazon 搜索链接（≤3）与 Top5 竞品链接可直接点开实况核对，关键指标、五维分、利润测算、风险状态、Gate 规则与决策日志齐屏，move/decide 表单同页完成、成功后自动返回看板。

市场档案页点「生成五维报告」后**直接弹出排版好的全屏报告**：左侧章节目录（九章及其小节）点选即跳转，表格与证据链接渲染完整，可切 Markdown 源码、一键复制全文，Esc 或点遮罩关闭；关掉后面板留一个「查看最近报告」按钮，重看不必再生成一次（仅限停留在本页期间——离开市场档案页后按钮就没了，要么重新生成，要么直接打开落盘的 `.md`）。**落盘产物仍然只有 `.pi/compass/reports/<市场ID>-<日期>.md`**，不额外生成 HTML 文件。

待办页对闭环四类事项提供行内闭环：填处理说明与证据后**提交**、状态徽标显示进展、验证通过后**勾选已处理**、勾错了可**重开**；「已处理」筛选项里能回看每条的说明、证据、验证结论与三个动作的时间和操作者。**验证不在浏览器做**——Web 端没有 LLM 通道，提交后回 pi 会话让 agent 执行 `compass_todo action=verify`。

也可以完全脱离 pi 独立启动：

```bash
node --experimental-strip-types .pi/extensions/compass/web/standalone.ts              # 默认端口 4780
node --experimental-strip-types .pi/extensions/compass/web/standalone.ts --port 5000  # 或 COMPASS_WEB_PORT=5000
```

**必须在宿主项目根目录执行**：工作台把当前目录当作宿主项目根，去读它下面的 `.pi/compass/store.json`。`COMPASS_ROOT` 环境变量可显式指定宿主项目根（默认当前目录）；`Ctrl+C` 优雅退出。

在 `.pi/extensions/compass/` 目录里跑 `npm run web` 也能起服务，但宿主项目根会被算成这个仓库自己、读不到你的数据，页面一片空白——真要在仓库目录里起，必须补上 `COMPASS_ROOT`：

```bash
cd .pi/extensions/compass && COMPASS_ROOT=../../.. npm run web
```

启动时若打印「`.../.pi/compass/store.json` 不存在，将以空数据启动」，就是启动目录不对。

**仅绑定 `127.0.0.1`，不做鉴权（本机单用户模型）：不要用端口转发把它暴露到局域网或公网**——工作台能读写全部选品经营数据。

## 数据与安全

运行数据写入宿主项目的：

```text
.pi/compass/
├── store.json       # 0600，策略、指标、决策日志、OutcomeCheck、Lesson 与快照元数据
├── raw/             # 原始 CSV 不可变归档
├── snapshots/       # 每个快照的 listing/keyword 数据文件（按需回放）
├── gapfill/         # 0600，补数档位与静音清单（state.jsonc）
└── reports/         # Markdown 选品报告
```

`.pi/compass/`（运行数据）与 `compass-imports/`（导入的原始 CSV）都可能包含内部经营数据。如果宿主项目使用 Git，建议把两者都加入宿主项目的 `.gitignore`：

```gitignore
.pi/compass/
compass-imports/
```

Extension：

- 不保存 Amazon/卖家精灵/Sorftime 凭据；
- 不自动登录网页或绕过验证码；
- 不把缺失指标伪装成通过；
- 不把 AI 风险初筛当法律意见；
- 强调采集环境与卖家主账号环境物理隔离。

## CSV 字段

支持 UTF-8（含 BOM）、UTF-16LE/BE；不是合法 UTF-8 时自动尝试按 GB18030（GBK）回退解码并给出告警，表头仍是乱码且几乎映射不到列时拒绝导入而不是落一份空指标快照。分隔符按「每行计数一致性」嗅探，逗号/Tab/分号/竖线分隔和带引号字段都支持。中英文别名覆盖：

- ASIN、标题、排名、价格、星级、评论数、月销量、月销售额；
- 品牌、卖家类型/是否 Amazon 自营、上架日期/月龄、类目；
- 关键词、搜索量、建议 CPC。

数值列的解析口径（缺数据一律按缺失处理，不伪装成 0）：

- **占位文本**（`暂无` / `未知` / `待定` / `TBD` / `?` / `--` / `N/A` / `NaN` / Excel 错误值 / 只有货币符号等）判为缺失，不再算成 `0`；真实的 `0`（如评论数为 0）照常保留。整份文件里这类单元格会汇总成一条告警，并按列名给出条数。
- **一格多值**不猜测：`4.5 (1,234)`、`5 x 3 x 2` 判为缺失；`4.5 out of 5 stars`、`4.5/5` 这类五分制写法取分子。量词后缀（`万`/`千`/`亿`/`k`/`m`）只在紧跟数字时生效，`5cm`、`100 km` 不会被当成百万。
- **评分列**额外做 0–5 范围校验，百分制与越界值判为缺失。
- **上架日期**支持 ISO（含毫秒与时区）、`2024/1/5`、`2024.1.5`、`2024年1月5日` 与 Excel 序列号；该列识别率低于 50% 时给出告警。
- **关键词行去重**：宽表导出常把同一个流量词复制到每条 listing 行上，这类文件会按关键词折叠后再合计搜索量（否则词族搜索量会按行数放大一个量级），并提示「疑似宽表布局、词族可能不完整」。
- **AMZ 自营占比**按月销加权，有效样本是「卖家类型与月销量**同时**有值」的行；有效样本不足半数时按缺失处理转人工复核，不从少数已标记行反推出 0% 或 100%。告警会点名到底缺的是自营列还是月销量列。
- **主词 CPC 为 0** 视为「无竞价数据」而非零成本流量，CPC 承受度 Gate 转待复核。

Sorftime 等 MCP 在线调用由罗盘自动计量（按次计入 `sorftime` 预算池，默认只计数；单价仅用于折算成本，配置**月度金额上限或次数上限**后按「金额或次数任一达 80%/100%」告警/熔断，熔断时会拦截后续调用并提示解除方式，池被 `enabled=false` 禁用时同样直接拦截；**计次口径**是「请求有没有发到服务端」——成功、服务端返回业务错误、30 秒超时、请求发出后被中断或取消都算一次，认证/连接/退避/审批等请求根本没发出去的失败不算；**结算月按 UTC 月计**——北京时间每月 1 日 08:00 整额度清零，1 日凌晨 0–8 点的调用仍记上个月）。已知局限：`mcpScript` 批量脚本内的调用无法归因不计量；会话异常退出会丢失最后一批未落盘计数；跨月交界（同样以 UTC 月界为准）的最后一批计数记入落盘当月。`.xlsx` 尚未直接解析，请先使用工具的官方 CSV 导出。自定义策略的 `screen` 模式只执行阶段名为 `market_screen` 的规则；若没有该阶段或规则为空，会转人工复核，不会判绿。报告自定义输出路径必须位于 `.pi/compass/reports/` 且使用 `.md` 扩展名。完全相同文件的 SHA-256 会被拒绝重复导入；同市场不同日期的新 CSV 仍会追加不可变快照，并对**已有人工决策**的市场自动做历史对照。

## 历史与复盘

**该市场已有人工决策留痕（`compass_pool decide`）**、且新快照与该决策的基线快照相隔至少 7 天时，导入流程会自动重放 `no_go` 的原 veto/fail 规则并写入 `OutcomeCheck`；从未做过决策的市场不会自动对照——需要看「策略结论本身站不站得住」时，用 `compass_retro action=check` 显式发起。「验证率」只统计挂到人工决策锚点的对照，无锚点的策略自我对照单列、不进比率。`validated` 表示既有判断得到后验支持，`challenged` 只表示建议人工复看，`inconclusive` 表示证据不足；系统不会自动翻转候选决策。go 品应通过 `compass_retro action=record_actuals` 录入日销、TACOS、退货率和净利率。验证率、go 达成率、no_go 正确率与错杀率**按市场去重**：同一市场刷再多次快照也只取最新一条可判对照、只算一票，无决策锚点与 `inconclusive` 的对照不计入；对照次数单独列出，与 `compass_retro action=backtest` 的一致率同口径。

Lesson 必须关联现存的 `chk_*`、`dec_*` 或 `run_*` evidence。默认复盘周期为 go 30 天、testing 停留 60 天、waitlist 45 天、no_go 抽样 90 天、review 30 天，可在策略 `meta` 中调整。罗盘会按选品意图注入有预算上限的历史速览；直接读取 `store.json`/快照 sidecar 会被护栏拦截，请使用 `compass_history`。

## 测试与类型检查

```bash
cd .pi/extensions/compass
npm test        # 单元 + 集成测试
npm run check   # tsc --noEmit 类型检查
```

## 复查修复兼容性说明

策略 DSL 不再把 `green`、`yellow` 作为内置字面量；风险状态请使用 `pass`、`review`、`red` 或 `unknown`。旧策略若仍引用这两个无效状态，会按未知指标转人工复核，保存前请更新策略版本。

## 当前边界

这是一个可运行的本地优先 Extension，不是假装完成整个服务端平台：

- 已完成：核心数字化、策略、终端工作台、历史检索、三层复盘与本地策略回测；
- 已预留：P2 连接器侧数据路由执行与跨源预算调度（本地 sorftime 计量与熔断拦截已落地）；
- 未内置：卖家精灵/Keepa/SP-API 凭据连接器、Playwright 集群、Chrome MV3 插件、自动联网采集。

这些 P2/P3 能力需要账号资质、API key、代理/隔离环境和后端服务，后续应以独立连接器接入，而不是把凭据写进 Extension。

## License

[MIT](./LICENSE)
