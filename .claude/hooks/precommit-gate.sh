#!/usr/bin/env bash
# PreToolUse 门禁：git commit 之前必须 npm run check + npm test 全绿。
#
# 本仓库没有 lint、没有 build 产物，tsc --noEmit 与 node:test 是仅有的两道机器判据，
# 加起来约 5 秒——比让一次坏提交进 CI（Node 22/24 两个矩阵）便宜得多。
# 只在这次提交会带上 .ts 时才跑：纯文档 / 纯资源提交直接放行。
# fail open 的口子很宽：没有 npm、探不到 node_modules/.bin/tsc、没装 jq、找不到 package.json，
# 以及 git 不可用 / 不在 git 仓库里（取不到改动清单，被当成没有 .ts 改动）——一律放行。
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
# 同时覆盖 `git commit` 与 `git -C <path> commit`
printf '%s' "$cmd" | grep -qE '\bgit\b[^;&|]*\bcommit\b' || exit 0

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

# 暂存区 + 工作区已跟踪改动，两边只要有 .ts 就跑（git commit -a 会把后者一起带上）
changed=$( { git diff --cached --name-only; git diff --name-only; } 2>/dev/null )
printf '%s\n' "$changed" | grep -qE '\.ts$' || exit 0

if ! out=$( { npm run --silent check && npm run --silent test; } 2>&1 ); then
	printf '提交被拦下：npm run check / npm test 未通过，先修好再提交（--no-verify 绕不过这道闸，CI 也会再拦一次）。\n\n%s\n' "$(printf '%s' "$out" | tail -n 40)" >&2
	exit 2
fi
exit 0
