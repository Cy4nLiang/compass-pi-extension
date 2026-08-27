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
| `compass_pool` | 候选池管理；阶段、Gate 和最终 `go/waitlist/no_go` 状态均强制记录原因 |
| `compass_risk_check` | 认证/IP/季节/政策/物流风险及官方证据 |
| `compass_reviews_record` | 差评主题、Kano 可改良性、星级差 |
| `compass_budget` | 数据源预算与 MCP 调用计量（`cost_per_call_cny` 单价、`monthly_call_limit` 次数上限）、80% 告警、100% 熔断、市场归因 |
| `compass_todo` | 工作台待办清单：自动推导需人工干预的事项（复核/补数/复盘/预算等 10 类），P1–P5 优先级，事项解决后自动消失 |
| `compass_asin_history` | 本地 ASIN 跨快照历史 |
| `compass_keyword_metrics` | 本地关键词搜索量/CPC 历史 |
| `compass_data_route` | 按字段 × 新鲜度 × 阶段 × 预算生成补数计划 |
| `compass_history` | 时间线、决策检索、相似市场、OutcomeCheck 统计与经验卡 |
| `compass_retro` | 到期复盘、快照对照、实绩录入、复盘报告、策略回测与 Lesson 管理 |

## Slash commands

- `/compass-help`：在 pi 会话中显示运营使用手册
- `/compass`：六页 TUI（总览 / 待办 / 市场 / 候选池 / 预算 / 复盘）
- `/compass-web [端口|stop]`：启动本地浏览器版工作台（八页：总览/待办/市场/市场档案/候选池/预算/复盘/导入），无参复用已在跑的服务，数字参数指定端口，`stop` 关闭
- `/compass-import <csv>`：交互导入
- `/compass-report [market_id|市场名]`：生成报告并作为 TUI 会话条目显示
- `/compass-strategy [strategy_id]`：编辑 YAML 并保存新版本
- `/compass-retro`：交互式复盘会（到期项 → 对照/实绩 → 报告 → Lesson）
- `/compass-history-brief on|off`：切换本会话自动历史速览与工具尾注

## Web 工作台

不想用 TUI 也可以用浏览器：在 pi 会话里输入 `/compass-web`，会打印本机访问地址（默认 `http://127.0.0.1:4780`，浏览器打开即可）；`/compass-web 5000` 指定端口；`/compass-web stop` 关闭。会话结束（含正常退出、`/reload` 等触发的会话重建）会自动兜底关闭。

也可以完全脱离 pi 独立启动：

```bash
cd .pi/extensions/compass
npm run web                          # 默认端口 4780
COMPASS_WEB_PORT=5000 npm run web    # 或 npm run web -- --port 5000
```

`COMPASS_ROOT` 环境变量指定宿主项目根目录（默认当前目录）；`Ctrl+C` 优雅退出。

**仅绑定 `127.0.0.1`，不做鉴权（本机单用户模型）：不要用端口转发把它暴露到局域网或公网**——工作台能读写全部选品经营数据。

## 数据与安全

运行数据写入宿主项目的：

```text
.pi/compass/
├── store.json       # 0600，策略、指标、决策日志、OutcomeCheck、Lesson 与快照元数据
├── raw/             # 原始 CSV 不可变归档
├── snapshots/       # 每个快照的 listing/keyword 数据文件（按需回放）
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

支持 UTF-8、UTF-16LE/BE，逗号/Tab/分号/竖线分隔和带引号字段。中英文别名覆盖：

- ASIN、标题、排名、价格、星级、评论数、月销量、月销售额；
- 品牌、卖家类型/是否 Amazon 自营、上架日期/月龄、类目；
- 关键词、搜索量、建议 CPC。

Sorftime 等 MCP 在线调用由罗盘自动计量（按次计入 `sorftime` 预算池，默认只计数；单价仅用于折算成本，配置**月度金额上限或次数上限**后按「金额或次数任一达 80%/100%」告警/熔断，熔断时会拦截后续调用并提示解除方式）。已知局限：`mcpScript` 批量脚本内的调用无法归因不计量；会话异常退出会丢失最后一批未落盘计数；跨月交界的最后一批计数记入落盘当月。`.xlsx` 尚未直接解析，请先使用工具的官方 CSV 导出。自定义策略的 `screen` 模式只执行阶段名为 `market_screen` 的规则；若没有该阶段或规则为空，会转人工复核，不会判绿。报告自定义输出路径必须位于 `.pi/compass/reports/` 且使用 `.md` 扩展名。完全相同文件的 SHA-256 会被拒绝重复导入；同市场不同日期的新 CSV 仍会追加不可变快照并自动做历史对照。

## 历史与复盘

新快照与决策基线相隔至少 7 天时，导入流程会自动重放 `no_go` 的原 veto/fail 规则并写入 `OutcomeCheck`。`validated` 表示既有判断得到后验支持，`challenged` 只表示建议人工复看，`inconclusive` 表示证据不足；系统不会自动翻转候选决策。go 品应通过 `compass_retro action=record_actuals` 录入日销、TACOS、退货率和净利率。

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
