# 罗盘复盘报告｜2026-03-01

> 生成时间：2026-03-01T12:00:00.000Z · 对照次数 4 次 · 比率样本 2 个市场（按市场去重：同一市场只取最新一条可判对照）· 本报告为经营复盘辅助，店铺实绩以 SP-API/后台为准。

## 1. 台账概览

- 决策分布：go 1 / waitlist 1 / no_go 1。
- 平均决策周期：17.0 天。
- 验证率：0.0%；go 达成率：0.0%；no_go 正确率：0.0%；错杀率：100.0%（四率按市场去重，样本 2 个市场；无决策锚点与 inconclusive 不计入）。
- 结论分布（按对照次数 4 次）：validated 1 / challenged 2 / inconclusive 1。

## 2. 逐项对照

| 时间 | 市场 / 候选 | T0 决策 | T1 证据 | verdict | 关键 delta / 理由 |
|---|---|---|---|---|---|
| 2026-02-15 | **折叠露营灯 / c_bold | go · snap_bold_base | 实绩：日销2/净利-3.1% | **challenged** | 日销与净利均未达标 |
| 2026-02-10 | 瑜伽垫 \| Yoga Mat Strap / c_pipe | no_go · snap_pipe_base | snap_pipe_t1 | **challenged** | 新品占比 8.0%→22.0% (improved) |
| 2026-01-05 | 硅胶铲 | 策略结论 · snap_wait_base | 缺证据 | **inconclusive** | 缺关键指标 |
| 2025-12-15 | 瑜伽垫 \| Yoga Mat Strap / c_pipe | no_go · snap_pipe_base | snap_pipe_t0 | **validated** | 否决规则重放仍成立 |

## 3. 错杀与漏放

| OutcomeCheck | 市场 | 判断 | 理由 |
|---|---|---|---|
| `chk_bold` | **折叠露营灯 | go 实绩失败，需归因与退出判断 | 日销与净利均未达标 |
| `chk_pipe` | 瑜伽垫 \| Yoga Mat Strap | 疑似错杀，建议重新入池 | 新品占比回升 \| 疑似错杀 建议重新入池 |

## 4. 策略校准建议

- 规则 `veto_ip` 出现在 1 条 challenged 基线中；先用 compass_retro action=backtest 验证阈值，再保存新策略版本。
- 规则 `gate_new_share` 出现在 1 条 challenged 基线中；先用 compass_retro action=backtest 验证阈值，再保存新策略版本。
- gse-default@v2：准确率 50.0%（按对照次数，未去重：validated 1 / challenged 1 / inconclusive 0）。
- 无策略锚点：准确率 0.0%（按对照次数，未去重：validated 0 / challenged 1 / inconclusive 1）。

## 5. 新沉淀经验

| 经验卡 | 结论 | 说明 | evidence |
|---|---|---|---|
| `les_same_day` | 低价段 \| 慎入 | 毛利低于 25% 时 直接放弃 | `chk_pipe` |
| `les_source` | **实绩未达标要先归因 | 先看 TACOS 再看退货率 | `chk_bold` |

## 6. 下一步

- [ ] **折叠露营灯（go，逾期 11 天）：录入日销、TACOS、退货率和净利率
- [ ] 硅胶铲（waitlist，逾期 10 天）：升级重评，或记录 no_go 原因
- [ ] 复看 m_pipe，如确认重新投入，使用 compass_pool move 并填写 reason；challenged 不会自动翻转决策。

---

*复盘 verdict 仅表示历史判断得到支持、受到挑战或证据不足，不构成法律意见或收益承诺。风险项仍须以最新官方来源复核。*
