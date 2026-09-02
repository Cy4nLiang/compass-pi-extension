#!/usr/bin/env bash
# PreToolUse 守卫：禁止把罗盘的「经营数据」当源码改。
#
# 受保护的两块都不属于任何 git 仓库，改错了没有版本历史可回滚：
#   .pi/compass/      运行数据（store.json / snapshots / raw / reports / artifacts）
#   compass-imports/  运营放置的真实市场 CSV（除说明文件外）
# 唯一合法的写入路径是扩展自身的写事务（store.ts 的 CompassRepository）与 pi 会话里的
# /compass-import、compass_* 工具、Web 工作台；手改 JSON 会绕过 assertStore 与原子写。
#
# 覆盖范围：Edit / Write / NotebookEdit 精确拦截；Bash 只做尽力而为的启发式（重定向、
# sed -i、rm/truncate 一类），mv/cp/tee 的目标端不拦——真要绕总能绕，这道闸挡的是手滑。
set -uo pipefail

payload=$(cat)

# 快路径：整段 JSON 里连关键词都不出现就放行，不启动 jq
case "$payload" in
	*".pi/compass"*|*"compass-imports"*) ;;
	*) exit 0 ;;
esac

command -v jq >/dev/null 2>&1 || exit 0

tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')

deny() {
	printf '%s\n' "$1" >&2
	exit 2
}

HOWTO='合法写入方式：pi 会话内用 /compass-import、compass_* 工具或 Web 工作台；代码侧走 store.ts 的 CompassRepository 写事务。需要看内容用 cat/jq 读即可，本守卫只挡写。'

# 说明文件是 compass-imports 里唯一允许手改的东西
allowed_import_doc() {
	case "$1" in
		*.md|*/.gitignore|.gitignore) return 0 ;;
	esac
	return 1
}

classify_path() {
	local path="$1"
	case "$path" in
		*"/.pi/compass/"*|".pi/compass/"*)
			printf '罗盘经营数据不可手工编辑：%s\n该文件由扩展的写事务维护（临时文件 + rename 原子替换、assertStore 校验、0600 权限），手改会绕过校验并可能让 store 读不出来。\n%s' "$path" "$HOWTO"
			return 0 ;;
		*"/compass-imports/"*|"compass-imports/"*)
			allowed_import_doc "$path" && return 1
			printf '这是运营的真实市场 CSV，不可改写：%s\n导入原件的唯一处理方式是 /compass-import（会做查重、解析并归档到 .pi/compass/raw/）。要造测试数据请写到 examples/ 下的虚构数据。\n%s' "$path" "$HOWTO"
			return 0 ;;
	esac
	return 1
}

case "$tool" in
	Edit|Write|NotebookEdit)
		path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
		[ -n "$path" ] || exit 0
		reason=$(classify_path "$path") && deny "$reason"
		exit 0
		;;
	Bash)
		cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
		[ -n "$cmd" ] || exit 0
		# 规则 1/2 针对「受保护目录下的某个文件」，尾斜杠是刻意保留的：重定向与 sed -i 的目标
		# 总是文件，放宽成不带斜杠只会把 `cat .pi/compass/store.json > /tmp/a` 这类读命令误伤。
		guarded='(\.pi/compass/|compass-imports/)'
		# 规则 3（删除 / 截断 / 改权限）必须连「目录本身」一起认：`rm -rf .pi/compass` 比删单个
		# 文件更致命，却因为没有尾斜杠整个从规则 3 溜走（绝对路径、"$ROOT/.pi/compass"、
		# rmdir、chmod -R 000 同理）。尾部 ([^A-Za-z0-9_.-]|$) 要求目录名整体结束才算命中，
		# 于是 .pi/compass-backup / .pi/compass.bak / compass-imports-old 这些邻居不会误伤。
		guarded_dir='(\.pi/compass|compass-imports)([^A-Za-z0-9_.-]|$)'
		# 1) 重定向写入受保护路径   2) sed -i 就地改   3) 删除/截断类命令点名受保护目录或其下路径
		if printf '%s' "$cmd" | grep -qE ">>?[[:space:]]*[^[:space:]|;&]*${guarded}" \
			|| printf '%s' "$cmd" | grep -qE "sed[[:space:]][^;&|]*-i[^;&|]*${guarded}" \
			|| printf '%s' "$cmd" | grep -qE "(^|[;&|[:space:]])(rm|rmdir|truncate|shred|chmod|chown)([[:space:]]+-[^[:space:]]+)*[[:space:]][^;&|]*${guarded_dir}"; then
			deny "这条命令会写入或删除罗盘的经营数据（.pi/compass/ 或 compass-imports/，含整个目录本身），已拦下：
$cmd
$HOWTO"
		fi
		exit 0
		;;
esac
exit 0
