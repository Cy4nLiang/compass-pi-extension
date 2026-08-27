---
name: compass-selection
description: Amazon US 中小卖家精铺选品工作流。用于市场 CSV 导入、QRD/CR3/新品占比粗筛、利润与 CPC 测算、差评痛点、认证/IP/季节/政策风险、候选池、历史检索、结果复盘、策略回测、预算和五维报告。用户提到亚马逊选品、卖家精灵、西柚、Sorftime、ASIN、精铺或罗盘时使用。
---

# 罗盘 Compass 选品工作流

> 本技能配合项目内 `compass_*` 工具使用。若目标工具未激活，先调用 `compass_tools` 描述任务并动态加载。

## 决策纪律

1. **snapshot-first**：任何结论必须指向市场快照；不得把当前网页印象当成历史证据。
2. **GSE**：先跑 Gate，再看 Score；每个数字都要保留来源、采集时间和置信度。
3. **缺数据不判绿**：缺失硬指标时结论为 `review`，不要自行补造数字。
4. **粗筛省钱、深研付费**：线索/粗筛优先 C 档 CSV/用户触发采集；只有通过粗筛的少数市场才拉 A 档数据。
5. **风险不是法律意见**：认证、专利、商标、版权和政策必须附最新官方来源 URL；模型记忆只用于生成检索式，不能单独支持 `pass`。
6. **复盘也要证据**：OutcomeCheck 没有新快照或数字实绩时只能是 `inconclusive`；Lesson 必须关联现存 `chk_*` / `dec_*` / `run_*` evidence。

## 标准阶段流转（七个工作阶段 + 归档）

`lead 线索 → screen 粗筛 → deep_research 深研 → risk 风控 → decision 决策 → testing 测品 → review 复盘 → archived 归档`

阶段移动必须调用 `compass_pool(action="move", reason=...)`，写明为什么移动。最终决策必须调用 `compass_pool(action="decide", decision_status="go|waitlist|no_go", reason=...)`；阶段、Gate 和最终决策的每一种状态都必须有原因。否决品也保留，不删除。

## 推荐执行顺序

### 1. 线索、导入与粗筛

1. 只有词根、竞品或榜单灵感时，先调用 `compass_lead` 建立线索；不要为填表而虚构市场数据。
2. 用户从卖家精灵/Sorftime 导出 CSV；不要要求提供账号密码。
3. 调用 `compass_import_csv`，填写市场/关键词族名。工具会：
   - 自动识别中英文表头；
   - 归档原 CSV；
   - 计算 QRD、CR3/5/10、HHI、AMZ 占比、新品占比、腰部指标；
   - 创建候选卡并运行默认 `screen` Gate。
4. 批量市场用 `compass_market_scan` 筛选和排序；尚无快照的线索不会参与 Gate 排名。
5. 同市场新快照与决策基线相隔至少 7 天时，导入会自动生成 OutcomeCheck：`validated`=原判断得到支持，`challenged`=建议人工复看，`inconclusive`=证据不足。challenged 不会自动翻转决策。

默认粗筛口径：

- `AMZ 自营占比 > 30% && CR3 > 60%` → 一票否决；
- `新品占比（≤12月） >= 15%` → 必须满足；
- `QRD(300) >= 20` → 必须满足，其中 300 = 日均10单 × 30天。

### 2. 深研与单位经济

调用 `compass_profit_estimate`。所有金额输入必须使用同一币种，百分比使用 0–1 小数。

公式：

- 落地成本 = 采购 + 头程 + 关税；
- 毛利率 = `(售价 - 佣金 - FBA - 落地成本) / 售价`，不含广告与退货；
- BE-CPC = `售价 × 毛利率 × CVR`；
- CPC 承受度 = `主词 CPC / BE-CPC`；
- 净利率情景 ≈ `毛利率 - TACOS - 退货损失率`。

默认：毛利率 ≥40%；CPC 承受度 ≤0.60 通过，0.60–0.80 复核，>0.80 否决。若已关联市场且未传 CPC，工具会尝试复用关键词快照里的主词 CPC。

需要补数时先调用 `compass_data_route`，不要无节制调用付费源。ASIN/关键词窄历史可用 `compass_asin_history` 与 `compass_keyword_metrics`；全局时间线、相似市场、决策检索、复盘台账和经验卡统一用 `compass_history`。这些工具只读取本地快照，不会联网，也不要绕过它们直接读取 `.pi/compass/store.json`。

### 3. 产品力与差评

对 Top10 竞品的 1–3 星评论聚类：质量、尺寸、运输损坏、期望落差、使用困惑、其他。每个主题标记可改良性：

- `factory` 工厂可解；
- `packaging` 包装可解；
- `copy` 文案/说明可解；
- `none` 无法解决；
- `unknown` 尚未判断。

用 `compass_reviews_record` 保存主题、证据原句和改良建议。不要粘贴无关个人信息。

### 4. 风险核查

使用配置的浏览器/网页检索能力检查最新官方来源，优先：USPTO、Google Patents、WIPO、CPSC、FDA、FCC、EPA 和 Amazon 官方政策。然后调用 `compass_risk_check` 留痕。

- `pass`：已有足够官方证据支持；
- `review`：需要人工/律师/认证机构判断；
- `red`：明确红色风险；
- `unknown`：尚未查清。

强季节品用 `season_flag="strong"`，默认转人工。高风险知识产权项必须建议律师复核。

### 5. 完整策略与报告

1. 调用 `compass_strategy_run(mode="full")`。
2. 对所有 `missing/review/fail/veto` 逐条解释，不只报总分。
3. 调用 `compass_market_report` 生成报告并保存到 `.pi/compass/reports/`。
4. 经用户确认后再移动候选阶段，并记录最终 `go`、`waitlist` 或 `no_go` 决策及原因。

策略可用 `/compass-strategy` 或 `compass_strategy_manage` 编辑。每次保存产生新版本，禁止覆盖历史版本。表达式支持比较、`&&`、`||`、`!`、括号和 `qualify_rank_depth(q)`；不支持任意代码执行。`screen` 模式只执行保留阶段名 `market_screen`；自定义策略若没有该阶段或规则为空，会转人工复核。

## 待办清单

- 会话开始或用户问「有什么要做的」时，先调用 `compass_todo`（P1 最高–P5 最低，逾期 >30 天升 1 级）；事项由 store 状态自动推导，解决后自动消失，不要另建手工清单。
- 每条待办自带 suggestedAction（指向具体工具/命令），可代办的（重跑策略、生成补数计划）直接执行；需要运营外部动作的（导出 CSV、补官方证据、录实绩）明确转告用户。

## 复盘闭环

- 先用 `compass_retro(action="due")` 看逾期对象，或运行 `/compass-retro` 进入交互式复盘会。
- go/testing 品用 `record_actuals` 录入日销、TACOS、退货率、净利率；日销达到策略目标 70% 且净利为正才记为 validated，低于 40% 或净利为负记为 challenged，字段不足则 inconclusive。
- no_go/waitlist 在新快照到场后用 `check` 回看；疑似错杀仍须人工确认后再 `compass_pool move`。
- 调策略前先用 `backtest` 比较 `strategy_id` 与 `baseline_strategy_id`（支持 `id@vN`），验证翻转矩阵和后验一致率，再保存新版本。
- 经验只通过 `save_lesson` 保存，evidence 必须非空；过时经验用 `retire_lesson` 并填写 reason，不删除。

默认到期周期：go 30 天、testing 停留 60 天、waitlist 45 天、no_go 90 天抽样、review 30 天。可在策略 `meta` 的 `retro_*_days` 字段调整。

## 数据成本与合规红线

- 用 `compass_budget` 记录每次付费数据成本，并尽量关联 `market_ref`；80% 告警、100% 熔断。
- Sorftime 等 MCP 在线调用由罗盘自动计量（无需手工 record）；可用 `compass_budget configure source=sorftime cost_per_call_cny=… monthly_call_limit=…` 配置单价与次数上限（0=清除），金额或次数任一达限即熔断并拦截后续调用，解除方式以拦截提示为准。`mcpScript` 内部调用不计量。
- 不做刷单、测评、跟卖等违规操作；不对外转售采集数据。
- 优先官方 API、官方导出和用户主动触发采集。
- **采集环境与卖家主账号登录环境必须物理隔离，不共用机器/IP/浏览器指纹。**
- 本 Extension 不自动登录 Amazon、卖家精灵或 Sorftime，也不保存这些账号凭据。

## 常用入口

- `/compass`：六页 TUI（总览/待办/市场/候选池/预算/复盘）；
- `/compass-web [端口|stop]`：浏览器版工作台（多市场档案、导入向导两页），仅本机可访问，不要转发到局域网/公网；也可脱离 pi 用 `npm run web` 独立启动；
- `/compass-import <csv>`：交互导入；
- `/compass-report [market]`：生成并在会话中展示报告；
- `/compass-strategy`：版本化编辑 YAML；
- `/compass-retro`：交互式复盘会；
- `/compass-history-brief on|off`：切换本会话自动历史速览；
- 数据文件：`.pi/compass/store.json`（权限 0600）；原始快照：`.pi/compass/raw/`；快照明细：`.pi/compass/snapshots/`。
