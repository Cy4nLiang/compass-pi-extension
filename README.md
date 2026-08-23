# 罗盘 Compass · pi Extension

> **Compass** is a project-level extension for the pi coding agent that turns the terminal into an Amazon US product-research workbench: market CSV snapshots, five-dimension metrics, a versioned Gate/Score screening DSL (GSE), profit & payback modeling, risk and negative-review logging, a candidate pipeline, and data-budget discipline. Requires Node.js >= 22.19. Documentation is primarily in Chinese.

面向 Amazon US 精铺选品的项目级 pi Extension，把选品工作流的 **P0 数字化 + P1 核心工作流**落到终端：CSV 快照、五维指标、GSE 策略、利润测算、风险/差评留痕、候选池、预算和报告。

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
| `compass_pool` | 候选池管理（七个工作阶段 + archived 归档），移动强制原因留痕 |
| `compass_risk_check` | 认证/IP/季节/政策/物流风险及官方证据 |
| `compass_reviews_record` | 差评主题、Kano 可改良性、星级差 |
| `compass_budget` | 数据源预算、80% 告警、100% 熔断、市场归因 |
| `compass_asin_history` | 本地 ASIN 跨快照历史 |
| `compass_keyword_metrics` | 本地关键词搜索量/CPC 历史 |
| `compass_data_route` | 按字段 × 新鲜度 × 阶段 × 预算生成补数计划 |

## Slash commands

- `/compass-help`：在 pi 会话中显示运营使用手册
- `/compass`：四页 TUI（总览 / 市场 / 候选池 / 预算）
- `/compass-import <csv>`：交互导入
- `/compass-report [market_id|市场名]`：生成报告并作为 TUI 会话条目显示
- `/compass-strategy [strategy_id]`：编辑 YAML 并保存新版本

## 数据与安全

运行数据写入宿主项目的：

```text
.pi/compass/
├── store.json       # 0600，策略、指标、决策日志与快照元数据
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

`.xlsx` 尚未直接解析，请先使用工具的官方 CSV 导出。自定义策略的 `screen` 模式只执行阶段名为 `market_screen` 的规则；若没有该阶段或规则为空，会转人工复核，不会判绿。报告自定义输出路径必须位于 `.pi/compass/reports/` 且使用 `.md` 扩展名。

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

- 已完成：P0/P1 的核心数字化、策略与终端工作台；
- 已预留：P2 数据路由与预算纪律；
- 未内置：卖家精灵/Keepa/SP-API 凭据连接器、Playwright 集群、Chrome MV3 插件、真实 6 个月后验回测。

这些 P2/P3 能力需要账号资质、API key、代理/隔离环境和后端服务，后续应以独立连接器接入，而不是把凭据写进 Extension。

## License

[MIT](./LICENSE)
