# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

罗盘 Compass：pi coding agent 的项目级 Extension（纯 TypeScript，无构建步骤），把 Amazon US 精铺选品工作流落进终端。入口由 `package.json` 的 `pi.extensions: ["./index.ts"]` 声明，pi 宿主直接加载 TS 源码（Node type stripping）；本仓库被 clone 到使用方项目的 `.pi/extensions/compass/` 下生效。

## 常用命令

```bash
npm test          # 全部测试（node:test，tests/*.test.ts）
node --experimental-strip-types --test tests/strategy.test.ts                       # 单个测试文件
node --experimental-strip-types --test --test-name-pattern "veto" tests/*.test.ts   # 按用例名过滤
npm run check     # tsc --noEmit 类型检查
```

Node >= 22.19；无 lint 配置、无 build 产物。CI（`.github/workflows/ci.yml`）在 Node 22/24 上跑 test + check。

## 关键约束：依赖由 pi 宿主提供

运行时依赖只有 `yaml`。`@earendil-works/pi-*` 与 `typebox` 在运行时由 pi 宿主解析提供，devDependencies 声明它们只为 IDE 类型与 `npm run check`：

- `typebox` 必须钉在 **1.3.7**（与宿主捆绑版本一致）；升级会触发 tsc TS2589 深度实例化错误。
- `@earendil-works/pi-coding-agent` 自带 npm-shrinkwrap，其依赖嵌套安装、不 hoist，因此 `pi-ai` / `pi-tui` 必须在 devDependencies 显式声明 tsc 才能解析。
- 不要把 pi 系列包挪进 dependencies 或打包进扩展。

## 架构

单向分层：`index.ts`（17 个领域工具 + `compass_tools` 路由 + 7 个 slash command 的注册薄层及只读 hook）→ `service.ts`（编排与业务规则，所有跨模块流程在这里）→ 领域模块 `csv.ts` / `metrics.ts` / `economics.ts` / `strategy.ts` / `history.ts` / `todo.ts` / `report.ts` → `store.ts`（持久化）。`types.ts` 是共享数据模型；`ui.ts` 只做六页 TUI 渲染（总览/待办/市场/候选池/预算/复盘）。测试直接 import service 与领域模块、不经过 `index.ts`，因此脱离 pi 宿主即可运行。

数据流：CSV 导入（`csv.ts`：UTF-8/16 解码、分隔符嗅探、中英文字段别名映射）→ 生成不可变市场快照并把原始文件归档到 `raw/` → `metrics.ts` 计算五维指标，每个数字都是 MetricEvidence（value + source + capturedAt + confidence）→ `strategy.ts` 执行 GSE（Gate → Score，veto 命中即整体否决）→ 候选卡按阶段流转并写 decisionLog → `report.ts` 输出五维 Markdown 报告。

持久化（`store.ts` 的 CompassRepository）：单一 JSON store（schemaVersion 1，load 时 assertStore 校验）写入**宿主项目**（运行 pi 的 cwd）的 `.pi/compass/`，而不是扩展自身目录。写入走临时文件 + rename 原子替换，目录 0700、文件 0600。`resolveInputPath` / `resolveOutputPath` 把一切输入输出路径限制在宿主项目内——不要绕过它们直接拼路径。

新增工具时：在 `index.ts` 同时更新 `DOMAIN_TOOLS` 与 `TOOL_CATALOG`（`compass_tools` 的动态激活检索依赖后者），并同步 README 工具表与 SKILL.md。

## 领域不变式（有测试守护，改动不得破坏）

- 缺失硬指标 → 结论为 `review`，绝不把缺数据伪装成 pass。
- 策略 veto 规则命中即整体否决，优先于 Score（红海条件为真时 veto 胜出）。
- percentile 归一化只在同批 scan 的比较组内做；单市场运行保留策略引擎的有界基准分。
- 策略表达式由 `strategy.ts` 自研 tokenizer/parser 求值（missing 值会沿表达式传播）；禁止引入 eval / new Function。
- 候选卡移动强制填 reason 并写入 decisionLog；否决品保留、不删除。
- 候选池措辞统一为「七个工作阶段 + archived 归档」（CANDIDATE_STAGES 共 8 个值），不要写成「八阶段」。
- 利润输入中大于 1 的百分比一律拒绝（`economics.ts`）。
- Lesson 必须挂非空且可解析的 evidence；OutcomeCheck 缺少新快照或数字实绩时 verdict 只能是 `inconclusive`，不得伪装成 `validated`。
- hook 只做本地只读计算、展示增强和上下文注入；不得在 hook 中开启 store 写事务。历史速览 ≤12 行，工具历史尾注 ≤8 行，压缩台账 ≤20 行。
- MCP 调用计量遵守同一约束：tool_result hook 只做内存 pending 自增，落账仅在安全点事务内（mutateStore 顺带 / 查看面 flush / session_shutdown 尽力）；工作台待办为派生视图（`todo.ts`），不持久化、条件解决即消失。

## 文档与数据卫生

- README 工具表、运营使用手册.md、运营速查卡.md、skills/compass-selection/SKILL.md 是运营可见的产品表面：改工具、命令或默认阈值时必须同步这四处。
- 用户可见字符串与文档用中文，代码标识符用英文；缩进用 tab。
- `examples/` 中的数据必须保持虚构（B0DEMO 前缀 ASIN、虚构品牌），不得出现真实品牌或真实经营数据；公开文档不引用内部 PRD 路径。
- 不保存任何平台凭据、不自动登录或绕过验证码；AI 风险初筛不得表述为法律意见。
