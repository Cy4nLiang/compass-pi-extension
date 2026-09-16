# Agent guidelines

本仓库是 **GitHub 公开仓库**。经营数据、凭据、宿主工作区内部路径、钥匙串、`.claude/` 过程文档不得进入提交或 PR。

## Git 隔离

- 改文件前执行 `git branch --show-current`。若是 `main` 或 `release/*`，停下来，开 `feat/` / `fix/` / `chore/` worktree。禁止在 `main` 上编辑或 commit。
- 一个会话只操作一个 worktree，不要 `git -C` 去另一个检出。
- 禁止 `git stash`（用 WIP commit）。禁止 `git push --force`（功能分支允许 `--force-with-lease`）。禁止 `git push --tags`。
- 进 `origin/main` 必须走 PR：`gh pr create --base main`。不要直接 `git push origin main`。
- 允许合入的分支前缀：`feat/` `fix/` `chore/` `docs/` `refactor/` `test/` `perf/` `ci/`。不要用 `spike/*` 或 `worktree-*` 开 PR。
- 发版用 annotated tag：候选 `vX.Y.Z-beta.N`，正式 `vX.Y.Z` 必须打在某个已存在 beta 的**同一 commit**。不要把前缀改成 `-rc.`。一次只推一个 tag。

Worktree 建在 clone 外面，不要建在父项目的 `.claude/worktrees/` 里。对父仓库做 `git worktree add` 隔离不到本仓库；必须对本仓库自己 `worktree add`。
