#!/usr/bin/env bash
# PreToolUse 门禁：git commit 之前必须 npm run check + npm test 全绿。
#
# 本仓库没有 lint、没有 build 产物，tsc --noEmit 与 node:test 是仅有的两道机器判据，
# 加起来约 5 秒——比让一次坏提交进 CI（Node 22/24 两个矩阵）便宜得多。
# 只在这次提交会带上「测试真的读得到的东西」时才跑：源码与前端资源（.ts/.js/.css/.html）、
# 配置与夹具（.json/.csv/.yml），以及 web/assets、examples、tests 三个目录下的任何文件。
# 纯文档提交（.md、LICENSE 之类）直接放行——README.md 除外，它被 static-invariants 测试读取。
# fail open 的口子很宽：没有 npm、探不到 node_modules/.bin/tsc、没装 jq、找不到 package.json，
# 以及 git 不可用 / 不在 git 仓库里（取不到改动清单，被当成没有相关改动）——一律放行。
# 这道闸是防手滑，不是防人。
set -uo pipefail

payload=$(cat)

# 快路径：payload 里没有 commit 字样就不解析
case "$payload" in
	*commit*) ;;
	*) exit 0 ;;
esac

command -v jq >/dev/null 2>&1 || exit 0

cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
# 只认「命令位置上的 git，后面跟着 commit」：从前的 \bgit\b[^;&|]*\bcommit\b 太松，
# git log --grep=commit 这类纯只读命令也会命中，白跑一次全量 check + test（约 4.4 秒）。
# 命令位置允许的前缀（都是日常真会出现的写法，漏掉就是 fail open 静默放行）：
#   任意顺序、任意条数的 env / command 包装与 VAR=值 环境变量赋值（值可带双引号），
#   外加可选的目录前缀（/usr/bin/git）；git 与 commit 之间仍只允许 -C/-c 及其参数
#   或 --xxx 形式的全局选项，所以 git log --grep=commit 这类只读命令依旧不会命中。
# **这份枚举不完备**，别当成穷举：`( … )` / `{ …; }` / for-do、while-do、if-then 里的命令位置，
# 以及 sudo / time / nohup / nice / exec 包装，都还认不出来，命中不了就是静默放行。
# 这是可接受的——本闸是防手滑不是安全围栏，漏网的代价只是少跑一次本地 check+test，CI 会再拦一次。
# 真要收紧：锚点 [;&|] 加 ({，(env|command) 加 sudo|time|nohup|nice|exec，
# 并往 .claude/hooks-selftest/precommit-gate.sh 的 M121 段补上对应的 gate 2 用例。
printf '%s' "$cmd" | grep -qE '(^|[;&|][[:space:]]*)(([^[:space:]]*/)?(env|command)[[:space:]]+|[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|[^[:space:]]*)[[:space:]]+)*([^[:space:]]*/)?git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|--[^[:space:]]+))*[[:space:]]+commit([^-[:alnum:]_]|$)' || exit 0

root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
	root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd) || exit 0
fi
cd "$root" 2>/dev/null || exit 0
[ -f package.json ] || exit 0

export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v npm >/dev/null 2>&1 || {
	echo "precommit-gate: 找不到 npm，跳过门禁" >&2
	exit 0
}
# 新克隆还没 npm install、node_modules 是空目录、或装到一半连 tsc 都没解包：跑下去只会把
# 「依赖没装」误报成「测试没过」，把排障指向完全错误的方向。探 tsc 本体而不是只看
# node_modules/ 在不在——空目录照样过得了目录判定。
# 只探这一个点是刻意的：tsc 恰好先落地而别的包没解包完时，仍会往下走按「测试没过」拦，
# 那种状态罕见、npm install 一跑就好，不值得为它在每次提交前多付一次 npm ls 的开销。
[ -x node_modules/.bin/tsc ] || {
	echo "precommit-gate: 没找到 node_modules/.bin/tsc（先跑 npm install），跳过门禁" >&2
	exit 0
}

# 暂存区 + 工作区已跟踪改动，两边只要有相关文件就跑（git commit -a 会把后者一起带上）。
# 只看 .ts 是不够的：测试直接读 web/assets/markdown.js（web-markdown.test.ts 静态 import）、
# web/assets/app.js（web-markdown 与 web-server 两处 readFile 做一致性断言）与
# examples/demo-market.csv（6 个测试文件的输入夹具），纯 .js / .csv 提交能把它们改坏而
# 一行测试都不跑。tsconfig 的 include 也吃 .json，CI 工作流是 .yml。
changed=$( { git diff --cached --name-only; git diff --name-only; } 2>/dev/null )
# README.md 也算：tests/static-invariants.test.ts 读它做「工具表覆盖全部对外工具」的断言，
# 删掉一行工具表就会红。它是唯一被测试读取的根目录 .md，别的纯文档提交仍然放行。
printf '%s\n' "$changed" | grep -qE '\.(ts|js|css|html|json|csv|ya?ml)$|^(web/assets|examples|tests)/|^README\.md$' || exit 0

if ! out=$( { npm run --silent check && npm run --silent test; } 2>&1 ); then
	printf '提交被拦下：npm run check / npm test 未通过，先修好再提交（--no-verify 绕不过这道闸，CI 也会再拦一次）。\n\n%s\n' "$(printf '%s' "$out" | tail -n 40)" >&2
	exit 2
fi
exit 0
