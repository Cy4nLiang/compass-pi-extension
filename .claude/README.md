# `.claude/` — Claude Code 侧的护栏与回归

这里放的是**给 Claude Code 会话用的配置**，与 `skills/compass-selection/`（给 pi 宿主用的运营技能）
是两套东西，互不影响。四块：

| 目录 | 作用 | 何时生效 |
| --- | --- | --- |
| `settings.json` + `hooks/` | 两道 PreToolUse 闸门 | guard 走 Edit / Write / NotebookEdit / Bash，precommit-gate 只走 Bash（仅限在本仓库内启动的会话） |
| `skills/secure-store-write/` | 写路径硬约束，生成时就守 | 模型判断相关时自动加载 |
| `skills/secure-store-write/evals/` | 5 个回归用例，防技能被改坏 | 手动 / CI |
| `hooks-selftest/` | 两道闸门的离线回归（喂 payload 看退出码，不执行被测命令） | 手动 / 改 hook 之后 |

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
- `Bash`：尽力而为的启发式——重定向写入与 `sed -i` 点名受保护目录下的**文件**时拦下；
  `rm` / `rmdir` / `truncate` / `shred` / `chmod` / `chown` 这类删除、截断、改权限的命令还额外认
  **目录本身**（`rm -rf .pi/compass`、绝对路径、`"$ROOT/.pi/compass"`、`rmdir`、`chmod -R 000` 都拦），
  同前缀的邻居不误伤（`.pi/compass-backup` / `.pi/compass.bak` / `compass-imports-old`）。
  **已知盲区**：`mv` / `cp` / `tee` 的目标端不拦（`mv .pi/compass /tmp` 同样放行），Python/Node 脚本内的写不拦。这道闸挡的是手滑，不是恶意。
- 放行读操作（`cat` / `grep` / `jq`）、`compass-imports/` 下的 `.md` 与 `.gitignore`。
- JSON 解析失败或没装 `jq` 时 fail open，不阻塞正常工作。

### `hooks/precommit-gate.sh` — 提交前跑 check + test

`git commit` 之前跑 `npm run check && npm run test`，任一失败就拦下提交
并把最后 40 行输出回给模型。本仓库没有 lint、没有 build 产物，tsc 与 node:test 是仅有的两道机器判据，
加起来约 5 秒——比让坏提交进 CI（Node 22/24 两个矩阵）便宜得多。

- 只在暂存区或工作区有「测试真的读得到的东西」时才跑：`.ts` / `.js` / `.css` / `.html` / `.json` /
  `.csv` / `.yml` 后缀，或落在 `web/assets/` / `examples/` / `tests/` 下的任何文件；纯文档提交
  （`.md`、LICENSE）直接放行。只看 `.ts` 是不够的——`web-markdown.test.ts` 静态 import
  `web/assets/markdown.js`，它和 `web-server.test.ts` 各有一处 `readFile` 断言 `web/assets/app.js`，
  `examples/demo-market.csv` 是 6 个测试文件的输入夹具，纯 `.js` / `.csv` 提交能把它们改坏而一行测试都不跑。
- 命令位置的 `git commit` 认这些前缀：`git -C <path> commit`、`command git commit`、
  `/usr/bin/git commit`、`VAR=值 git commit`、`env VAR=值 git commit`（任意组合；漏掉就是静默 fail open）。
  `git log --grep=commit`、`git commit-graph write`、`git config commit.gpgsign false` 这类只读命令仍不触发。
- 工具链缺失时 fail open：找不到 `npm`，或探不到 `node_modules/.bin/tsc`（新克隆还没 `npm install`、
  `node_modules` 是空目录、装到一半连 tsc 都没解包；`typescript` 是 devDependency，`--omit=dev` 装出的
  依赖树同样命中这条）。不跳过的话 `tsc` 不存在会被这道闸报成「测试没过」，把排障指向完全错误的方向。
  **判据只探 tsc 这一个点**：tsc 恰好先落地而别的包还没解包完时仍会走下去按「测试没过」拦，此时把
  `npm install` 跑完再提交。
- 除此之外还有一批**不打印任何提示**的静默放行：没装 `jq`、项目根解析或 `cd` 失败、找不到 `package.json`，
  以及 `git` 不可用或当前不在 git 仓库里——那时取不到改动清单，会被当成「没有相关改动」一并放行。
- 跳过原因只写在脚本 stderr 上；hook 以 0 退出时会话里看不到它，手动跑下面的自测才可见。

自测（不需要真的提交）。下面的片段**只把命令串包成 hook 输入喂给脚本看退出码，从不执行被测命令**，
也不会碰真实的 `.pi/compass/` 与 `compass-imports/`；但因为片段里带着 `rm -rf .pi/compass` 字样，
在 Claude Code 会话里跑会被守卫自己拦下，请在普通终端里跑：

```bash
# guard-compass-data：文件工具
printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"/x/.pi/compass/store.json"}}' \
  | bash .claude/hooks/guard-compass-data.sh; echo "rc=$?   # 期望 2"
# guard-compass-data：四种整目录破坏形态，全都要 rc=2
for c in 'rm -rf .pi/compass' 'rm -rf /Users/me/amazon-prd/.pi/compass' \
         'rm -rf compass-imports' 'chmod -R 000 .pi/compass'; do
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$c" | jq -Rs .)" \
    | bash .claude/hooks/guard-compass-data.sh >/dev/null 2>&1; echo "rc=$?   # 期望 2  <- $c"
done
# guard-compass-data：读操作必须放行（把读也拦了会让日常工作寸步难行）
printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' 'cat .pi/compass/store.json' | jq -Rs .)" \
  | bash .claude/hooks/guard-compass-data.sh >/dev/null 2>&1; echo "rc=$?   # 期望 0"

# precommit-gate：四种命令前缀都要被认出来（工作区若无相关改动会直接跳过，不会真的跑 check/test）
for c in 'git commit -m wip' 'command git commit -m wip' '/usr/bin/git commit -m wip' \
         'GIT_AUTHOR_DATE=2026-01-01 git commit -m wip'; do
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$c" | jq -Rs .)" \
    | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/precommit-gate.sh; echo "rc=$?   # 期望 0 或 2  <- $c"
done
```

更完整的回归（含「必须放行」的读操作与邻居目录、以及门禁的触发文件集）在 `hooks-selftest/`：

```bash
bash .claude/hooks-selftest/guard-compass-data.sh   # 末行 PASS=<n> FAIL=0
bash .claude/hooks-selftest/precommit-gate.sh       # 末行 PASS=<n> FAIL=0
# 应用 pending-hooks 之前先测待应用的版本：
HOOKS_DIR=$PWD/.claude/pending-hooks bash .claude/hooks-selftest/guard-compass-data.sh
HOOKS_DIR=$PWD/.claude/pending-hooks bash .claude/hooks-selftest/precommit-gate.sh
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
