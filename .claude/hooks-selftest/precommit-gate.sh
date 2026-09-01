#!/bin/bash
# precommit-gate.sh 的离线回归：把构造好的 hook 输入 JSON 喂给脚本，断言退出码。
# 从不真的提交，也不动本仓库——每个用例在临时目录里现搭一个 git 仓库，其 package.json 的
# check / test 都写成 `exit 3`，于是退出码就是一个干净的观测点：
#   2 = 门禁认出了这条 commit 并真的跑了 check/test（然后失败）
#   0 = 门禁放行（没认出命令，或判定这次改动与测试无关）
#
# 用法：bash .claude/hooks-selftest/precommit-gate.sh                     测当前生效的版本
#       HOOKS_DIR=$PWD/.claude/pending-hooks bash .claude/hooks-selftest/precommit-gate.sh
# 成功标志：末行 "PASS=<n> FAIL=0"
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LIVE="$ROOT/.claude/hooks"
H="${HOOKS_DIR:-$LIVE}"
SCRIPT="precommit-gate.sh"
[ -f "$H/$SCRIPT" ] || H="$LIVE"
PASS=0; FAIL=0

ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }

bash_json() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; }

echo "== 结构检查（${H}）=="
bash -n "$H/$SCRIPT" 2>/dev/null && ok || bad "$SCRIPT 语法错误"
if sed -E 's/#.*$//' "$H/$SCRIPT" | grep -Eq '(^|[^[:alnum:]_])exit[[:space:]]+1([^[:alnum:]]|$)'; then
  bad "$SCRIPT 用了退出码 1（那是放行，不是阻止）"; else ok; fi

# 假仓库：check / test 必然失败，node_modules/.bin/tsc 存在（否则门禁会按「依赖没装」跳过）
T=$(mktemp -d "${TMPDIR:-/tmp}/pcg-selftest.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/node_modules/.bin"
printf '{"scripts":{"check":"exit 3","test":"exit 3"}}' > "$T/package.json"
printf '#!/bin/sh\nexit 0\n' > "$T/node_modules/.bin/tsc"; chmod +x "$T/node_modules/.bin/tsc"
( cd "$T" && git init -q && git config user.email selftest@example.com && git config user.name selftest )

# stage_only <相对路径...>：清空暂存区后只放这几个文件。用 git add -A 会把 package.json 与
# node_modules 一起带进来，`.json` 命中相关文件过滤器，「纯文档提交应放行」那条就假红了。
stage_only() { ( cd "$T" && git reset -q && git add -f "$@" >/dev/null 2>&1 ); }

# gate <期望退出码> <命令串>
gate() {
  local want="$1" got
  printf '%s' "$(bash_json "$2")" | env "CLAUDE_PROJECT_DIR=$T" bash "$H/$SCRIPT" >/dev/null 2>&1; got=$?
  if [ "$got" != 0 ] && [ "$got" != 2 ]; then
    bad "退出码 $got 既不是 0 也不是 2（fail-open 风险）:: $2"; return
  fi
  if [ "$got" = "$want" ]; then ok; else bad "want=$want got=$got :: $2"; fi
}

echo "== M121：命令位置的 git commit（2 = 门禁跑了）=="
touch "$T/a.ts"; stage_only a.ts
gate 2 "git commit -m x"
gate 2 "git -C . commit -m x"
gate 2 "git -c user.name=x commit -m x"
gate 2 "command git commit -m x"
gate 2 "/usr/bin/git commit -m x"
gate 2 "GIT_AUTHOR_NAME=x git commit -m x"
gate 2 "GIT_AUTHOR_DATE=\"2026-01-01 00:00\" git commit -m x"
gate 2 "env GIT_EDITOR=true git commit -m x"
gate 2 "npm test && git commit -m x"

echo "== M121：只读命令不能白跑一次 check + test =="
gate 0 "git log --grep=commit"
gate 0 "git show --format=%B HEAD"
gate 0 "git config commit.gpgsign false"
gate 0 "git commit-graph write"
gate 0 "echo commit"
rm -f "$T/a.ts"

echo "== M133：测试真的读得到的非 .ts 文件也要触发 =="
# 只看 .ts 是不够的：web-markdown.test.ts 静态 import web/assets/markdown.js，
# 它与 web-server.test.ts 各有一处 readFile 断言 web/assets/app.js，
# examples/demo-market.csv 是 6 个测试文件的输入夹具。
mkdir -p "$T/web/assets"; touch "$T/web/assets/app.js"; stage_only web/assets/app.js
gate 2 "git commit -m x"
rm -rf "$T/web"
mkdir -p "$T/examples"; touch "$T/examples/demo-market.csv"; stage_only examples/demo-market.csv
gate 2 "git commit -m x"
rm -rf "$T/examples"
touch "$T/tsconfig.json"; stage_only tsconfig.json
gate 2 "git commit -m x"
rm -f "$T/tsconfig.json"
mkdir -p "$T/.github/workflows"; touch "$T/.github/workflows/ci.yml"; stage_only .github/workflows/ci.yml
gate 2 "git commit -m x"
rm -rf "$T/.github"
# README.md 被 static-invariants.test.ts 读取（工具表覆盖断言），删一行就红——必须触发门禁
touch "$T/README.md"; stage_only README.md
gate 2 "git commit -m x"
rm -f "$T/README.md"

echo "== 纯文档提交放行 =="
touch "$T/NOTES.md"; stage_only NOTES.md
gate 0 "git commit -m x"
rm -f "$T/NOTES.md"

echo "== fail open：依赖没装时跳过（把「没装依赖」误报成「测试没过」会把排障带偏）=="
touch "$T/a.ts"; stage_only a.ts
mv "$T/node_modules/.bin/tsc" "$T/tsc.bak"
gate 0 "git commit -m x"
mv "$T/tsc.bak" "$T/node_modules/.bin/tsc"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
