#!/bin/bash
# guard-compass-data.sh 的离线回归：把构造好的 hook 输入 JSON 喂给脚本，断言退出码。
# 只把命令串当**文本**喂进去看判定，从不执行被测命令，也不碰真实的 .pi/compass/ 与 compass-imports/。
#
# 用法：bash .claude/hooks-selftest/guard-compass-data.sh                     测当前生效的版本
#       HOOKS_DIR=$PWD/.claude/pending-hooks bash .claude/hooks-selftest/guard-compass-data.sh
#                                                                            测待应用的版本（应用前必跑）
# 成功标志：末行 "PASS=<n> FAIL=0"
#
# 本脚本在 Claude Code 会话里可以直接跑：守卫只看 tool_input.command（这里就是
# `bash .claude/hooks-selftest/guard-compass-data.sh` 这一串），脚本文件的内容不在它视野里。
# 会被拦的是把用例**内联成 Bash 片段**贴进去的写法——那时受保护路径的字面量会进命令全文，
# 见 .claude/README.md 的自测小节。
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LIVE="$ROOT/.claude/hooks"
H="${HOOKS_DIR:-$LIVE}"
SCRIPT="guard-compass-data.sh"
[ -f "$H/$SCRIPT" ] || H="$LIVE"
PASS=0; FAIL=0

ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }

# run <期望退出码> <json>
run() {
  local want="$1" json="$2" got
  printf '%s' "$json" | bash "$H/$SCRIPT" >/dev/null 2>&1; got=$?
  if [ "$got" != 0 ] && [ "$got" != 2 ]; then
    bad "退出码 $got 既不是 0 也不是 2（fail-open 风险）:: $json"; return
  fi
  if [ "$got" = "$want" ]; then ok; else bad "want=$want got=$got :: $json"; fi
}
bash_json() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; }
edit_json() { printf '{"tool_name":"Edit","tool_input":{"file_path":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; }

echo "== 结构检查（${H}）=="
bash -n "$H/$SCRIPT" 2>/dev/null && ok || bad "$SCRIPT 语法错误"
if sed -E 's/#.*$//' "$H/$SCRIPT" | grep -Eq '(^|[^[:alnum:]_])exit[[:space:]]+1([^[:alnum:]]|$)'; then
  bad "$SCRIPT 用了退出码 1（那是放行，不是阻止）"; else ok; fi

echo "== 文件工具 =="
run 2 "$(edit_json ".pi/compass/store.json")"
run 2 "$(edit_json "/Users/me/amazon-prd/.pi/compass/snapshots/a.json")"
run 2 "$(edit_json "compass-imports/2026-08-01-x-sorftime.csv")"
run 0 "$(edit_json "compass-imports/README.md")"      # 说明文件是唯一允许手改的
run 0 "$(edit_json "compass-imports/.gitignore")"
run 0 "$(edit_json "src/store.ts")"
run 0 '{"tool_name":"Edit","tool_input":{}}'          # 取不到路径 → 放行

echo "== Bash：重定向 / sed -i 写入受保护文件 =="
run 2 "$(bash_json "echo '{}' > .pi/compass/store.json")"
run 2 "$(bash_json "echo x >> compass-imports/a.csv")"
run 2 "$(bash_json "sed -i '' 's/a/b/' .pi/compass/store.json")"

echo "== Bash：读操作必须放行（把读也拦了日常工作寸步难行）=="
run 0 "$(bash_json "cat .pi/compass/store.json | jq .")"
run 0 "$(bash_json "ls -la .pi/compass/reports")"
run 0 "$(bash_json "grep -r asin compass-imports/")"
run 0 "$(bash_json "cat .pi/compass/store.json > /tmp/backup.json")"   # 重定向目标不在受保护区

echo "== M120：删除 / 截断 / 改权限点名【目录本身】=="
# 这一组在修复前全部放行——`rm -rf .pi/compass` 比删单个文件更致命，却因为没有尾斜杠溜过了规则 3。
run 2 "$(bash_json "rm -rf .pi/compass")"
run 2 "$(bash_json "rm -rf compass-imports")"
run 2 "$(bash_json "rmdir .pi/compass")"
run 2 "$(bash_json "chmod -R 000 .pi/compass")"
run 2 "$(bash_json "chown -R nobody compass-imports")"
run 2 "$(bash_json "rm -rf \"\$ROOT/.pi/compass\"")"
run 2 "$(bash_json "rm -rf /Users/me/amazon-prd/compass-imports")"
run 2 "$(bash_json "truncate -s 0 .pi/compass/store.json")"
run 2 "$(bash_json "shred -u .pi/compass/store.json")"

echo "== M120：同前缀的邻居目录不能误伤 =="
run 0 "$(bash_json "rm -rf .pi/compass-backup")"
run 0 "$(bash_json "rm -rf .pi/compass.bak")"
run 0 "$(bash_json "rm -rf compass-imports-old")"
run 0 "$(bash_json "rm -rf .pi/compass_tmp")"
run 0 "$(bash_json "rm -rf node_modules")"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
