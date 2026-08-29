#!/usr/bin/env bash
# PreToolUse 门禁：git commit 之前必须 npm run check + npm test 全绿。
#
# 本仓库没有 lint、没有 build 产物，tsc --noEmit 与 node:test 是仅有的两道机器判据，
# 加起来约 5 秒——比让一次坏提交进 CI（Node 22/24 两个矩阵）便宜得多。
# 只在这次提交会带上 .ts 时才跑：纯文档 / 纯资源提交直接放行。
# 工具链缺失（没有 npm/node）时 fail open：这道闸是防手滑，不是防人。
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

# 暂存区 + 工作区已跟踪改动，两边只要有 .ts 就跑（git commit -a 会把后者一起带上）
changed=$( { git diff --cached --name-only; git diff --name-only; } 2>/dev/null )
printf '%s\n' "$changed" | grep -qE '\.ts$' || exit 0

if ! out=$( { npm run --silent check && npm run --silent test; } 2>&1 ); then
	printf '提交被拦下：npm run check / npm test 未通过，先修好再提交（--no-verify 绕不过这道闸，CI 也会再拦一次）。\n\n%s\n' "$(printf '%s' "$out" | tail -n 40)" >&2
	exit 2
fi
exit 0
