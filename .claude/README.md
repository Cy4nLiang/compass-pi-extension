# `.claude/` — Claude Code 侧的护栏与回归

这里放的是**给 Claude Code 会话用的配置**，与 `skills/compass-selection/`（给 pi 宿主用的运营技能）
是两套东西，互不影响。三块：

| 目录 | 作用 | 何时生效 |
| --- | --- | --- |
| `settings.json` + `hooks/` | 两道 PreToolUse 闸门 | guard 走 Edit / Write / NotebookEdit / Bash，precommit-gate 只走 Bash（仅限在本仓库内启动的会话） |
| `skills/secure-store-write/` | 写路径硬约束，生成时就守 | 模型判断相关时自动加载 |
| `skills/secure-store-write/evals/` | 5 个回归用例，防技能被改坏 | 手动 / CI |

## 1. Hooks

`settings.json` 注册两个 PreToolUse hook，都是仓库内可见、可审、可改的普通脚本：

**作用域：只对以本仓库为工作目录启动的 Claude Code 会话生效。** 这是 project-level settings，
从上层宿主项目根目录启动的会话读不到这份配置，两道闸一道都不在——而 `guard-compass-data.sh`
要保护的 `.pi/compass/` 与 `compass-imports/` 恰恰位于宿主项目根下。这不是缺陷（代码工作本来
就该在本目录内起会话），但别把它当成「装了就全局生效」的护栏。

### `hooks/guard-compass-data.sh` — 挡经营数据被误改

拦截对 `.pi/compass/`（store.json / snapshots / raw / reports / artifacts）和 `compass-imports/`
真实 CSV 的写入。这两块都不在任何 git 仓库里，改错了没有版本历史可回滚，而且手改会绕过
`assertStore` 校验与「临时文件 + rename」原子写。

- `Edit` / `Write` / `NotebookEdit`：按 `file_path` 精确拦截。
- `Bash`：尽力而为的启发式——重定向写入、`sed -i`、`rm` / `truncate` / `chmod` 一类点名受保护路径时拦下。
  **已知盲区**：`mv` / `cp` / `tee` 的目标端不拦，Python/Node 脚本内的写不拦。这道闸挡的是手滑，不是恶意。
- 放行读操作（`cat` / `grep` / `jq`）、`compass-imports/` 下的 `.md` 与 `.gitignore`。
- JSON 解析失败或没装 `jq` 时 fail open，不阻塞正常工作。

### `hooks/precommit-gate.sh` — 提交前跑 check + test

`git commit`（含 `git -C <path> commit`）之前跑 `npm run check && npm run test`，任一失败就拦下提交
并把最后 40 行输出回给模型。本仓库没有 lint、没有 build 产物，tsc 与 node:test 是仅有的两道机器判据，
加起来约 5 秒——比让坏提交进 CI（Node 22/24 两个矩阵）便宜得多。

- 只在暂存区或工作区有 `.ts` 改动时才跑；纯文档 / 纯资源提交直接放行。
- 工具链缺失时 fail open：找不到 `npm`，或探不到 `node_modules/.bin/tsc`（新克隆还没 `npm install`、
  `node_modules` 是空目录、装到一半连 tsc 都没解包；`typescript` 是 devDependency，`--omit=dev` 装出的
  依赖树同样命中这条）。不跳过的话 `tsc` 不存在会被这道闸报成「测试没过」，把排障指向完全错误的方向。
  **判据只探 tsc 这一个点**：tsc 恰好先落地而别的包还没解包完时仍会走下去按「测试没过」拦，此时把
  `npm install` 跑完再提交。
- 除此之外还有一批**不打印任何提示**的静默放行：没装 `jq`、项目根解析或 `cd` 失败、找不到 `package.json`，
  以及 `git` 不可用或当前不在 git 仓库里——那时取不到改动清单，会被当成「没有 `.ts` 改动」一并放行。
- 跳过原因只写在脚本 stderr 上；hook 以 0 退出时会话里看不到它，手动跑下面的自测才可见。

自测（不需要真的提交）：

```bash
printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"/x/.pi/compass/store.json"}}' \
  | bash .claude/hooks/guard-compass-data.sh; echo "rc=$?   # 期望 2"
CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/precommit-gate.sh \
  <<< '{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"}}'; echo "rc=$?   # 期望 0（放行；工作区若无 .ts 改动会直接跳过，并不会真的跑 check/test）"
```

想临时停用：把 `settings.json` 里对应的那段删掉，或整体改名为 `settings.json.off`。

## 2. Skill：`secure-store-write`

把 `CLAUDE.md` 里写路径这一切面的硬约束（主体是「写路径与并发（踩过的坑）」一节，另含「架构」段的持久化
约定与「领域不变式」里若干条，范围口径见 `CLAUDE.md` 的「`.claude/`」小节，逐条以下面 §0–§8 为准）从**读后知道**变成**生成时守住**：模型在改写事务、
Web 写端点、hook 落盘、store 字段或 `assertStore` 时自动加载，按条对照后再动手。

`CLAUDE.md` 仍是唯一真相源；技能是它在写路径这一个切面上的可执行版本。**两边改了要同步**——
`evals/` 就是防这一点走样的。

## 3. Evals：5 个回归用例

每个用例对应一个真实踩过的坑，提示词自包含（沙箱里没有仓库文件），验证模型是否给出正确判断：

| 用例 | 守的不变式 |
| --- | --- |
| `nested-write-transaction` | 写事务禁止嵌套（队列自等待 / 文件锁自旋误报） |
| `web-write-endpoint` | 新写端点必须登记 `WRITE_PATHS` 且走 `enqueueWrite` |
| `snapshot-field-allowlist` | `MarketSnapshot` 新字段必须进 `emptySnapshotPayload` |
| `assert-store-compat` | `assertStore` 加校验会让存量 store 砖化 |
| `hot-path-hook-write` | 热路径 hook 绝不开写事务 |

跑之前要先开早期访问开关（`claude plugin eval` 目前是 early access）。下面三条命令都带 `--no-publish`：
用例提示词与 HTML 报告里含本仓库的架构与写路径细节，只留在本地，不要发布到 claude.ai。

```bash
export CLAUDE_CODE_WALNUT_SPIRE=1

# 冒烟：单个用例、单次运行、不做消融，约 $0.3 / 1 分钟
claude plugin eval .claude/skills/secure-store-write \
  --case snapshot-field-allowlist --runs 1 --ablation none --no-publish

# 全量回归：5 个用例 × 2 次，约 $3 / 10 分钟
claude plugin eval .claude/skills/secure-store-write \
  --ablation none --threshold 0.75 --no-publish

# 看技能相对「没有技能」的增量（成本翻倍）
claude plugin eval .claude/skills/secure-store-write --ablation with-without --runs 1 --no-publish
```

**什么时候必须跑**：改 `SKILL.md`、改 hook 脚本，或改 `CLAUDE.md` 里被 `SKILL.md` 镜像的任一处之后
（范围口径见 `CLAUDE.md` 的「`.claude/`」小节，不止「写路径与并发」一节；逐条以 `SKILL.md` §0–§8 为准）。
低于 `--threshold` 会以退出码 1 结束，可直接接进 CI。`skill-fired` 这条 grader 标了 `arm: with-only`，
在消融模式下只作为「技能确实触发了」的指示器，不计入分数。

结果写到 `evals/results/`（已 gitignore），HTML 报告用 `--report <path>` 另存。
