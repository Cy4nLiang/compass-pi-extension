---
name: secure-store-write
description: 罗盘 Compass 写路径的并发与持久化硬约束。当改动涉及写事务（mutateStore / repo.update / withFileMutationQueue / store.json.lock）、Web 写端点或 WRITE_PATHS、pi hook 里的落盘、给 CompassStore 或 MarketSnapshot 加字段、动 assertStore 校验、改派生待办 id 拼法或 todoResolutions 状态机时使用。这些坑的共同特征是「本地绿、CI 绿，线上静默丢数据或永久挂死」。
---

# 罗盘写路径：生成时必须满足的硬约束

下面每一条的失败模式都**不是报错**，而是静默丢数据、永久挂死，或把排障引向完全错误的方向。所以它们要在写代码的当下守住，不能指望 review 或测试兜底——现有测试恰恰抓不到其中大半。

## 0. 先定位改动落在哪一层

| 改动 | 看第几条 | 提交前必须验证 |
| --- | --- | --- |
| 新增/修改写事务、在 mutator 里再写一次 | §1 | `npm test`（锁相关用例必须真跑完，不能靠加超时让它过） |
| 动 `store.json.lock` 抢锁自旋、加 `unref()` | §2 | `npm test` |
| 新增 Web 写端点 / 改 `server.ts` 路由 | §3 | `npm test`，并人工确认新路径进了 `WRITE_PATHS` |
| 在 pi hook 里落盘、加计量 | §4 | `npm test`，人工确认没在热路径开事务 |
| 给 `MarketSnapshot` / `CompassStore` 加字段 | §5 §6 | `npm run check` + `npm test`，并用**存量** store 跑一次 load→save |
| 给 `assertStore` 加校验 | §6 | 同上，存量兼容是硬要求 |
| 拼输入/输出路径 | §7 | `npm test` |
| 改派生待办 id、kind 取值、`todoResolutions` | §8 | `npm test`（`tests/todo-resolution.test.ts`） |

## 1. 写事务禁止嵌套

`mutateStore`（`index.ts`，内层是宿主 `withFileMutationQueue`）、Web 的 `writeChain`、`store.json.lock` 三层串行**都没有重入检测**。在 mutator 回调内再开一次写事务：

- 队列侧自等待，**永久挂死且无超时**；
- 文件锁侧因为「自己的 pid 存活 ⇒ 永不判 stale」空转满 10 秒，然后抛出**误导性**的「罗盘数据文件被其他进程锁定超过 10 秒」，把人引向根本不存在的跨进程冲突。

**正确形状**：读文件、查重、CSV 解析、归档等准备工作一律放在事务外，事务内只做纯内存的 store 变更。`importer.ts` 就是这个形状（路径解析→查重→解析→归档在外，只有最后的写走 `deps.mutate`）。需要在一次操作里改两处 store，就在**同一个 mutator 内**改两处，不要开第二次事务。

不要用这些方式"解决"：加超时、加重试、换锁实现、把 mutator 改成 async 再 await 另一个事务。

## 2. 抢锁自旋的 `await delay(50)` 必须保持默认 ref

`store.ts` 的 `withStoreLock` 里那个 `delay(50)` **绝不能 unref**。调用方正在 await 这次写入，unref 会让 event loop 一空就退出、pending 的写**静默丢失**。node:test 报 `Promise resolution is still pending but the event loop has already resolved` 就是此病——不要加大超时、不要重跑 CI、不要改测试。

代价是进程退出最多被在途写拖 10 秒（抢锁 deadline 兜底），这是刻意接受的正确语义。要缩短宿主关停等待只能在**关停侧**做：`web/server.ts` 的 `close()` 用 unref 的 3 秒定时器 race 写队列，**放弃等待但不打断写**。

## 3. Web 写入：`enqueueWrite` 串行队列 + `WRITE_PATHS` 双登记

新增 Web 写端点必须同时做两件事，缺一件都是静默失效：

1. **走 `enqueueWrite` / `webMutate`，不得直接调 `repo.update`。** 文件锁只跨进程互斥；同进程并发写只会互相抢锁重试。逻辑上"只读"的市场报告落盘也算写，也要进队列。
2. **把新路径登记进 `server.ts` 的 `WRITE_PATHS`。** 本服务无鉴权，「POST-only 判定」+「Content-Type 必须 application/json + Origin 限回环」这道跨站防线**只挂在该白名单命中的那个分支上**。在只读分支旁另起 `if (pathname === "…")` 自己读 body 写事务，功能完全正常，但写侧防护全丢——而且现有测试只硬编码了已有路径，抓不到漏登记。

关停顺序固定：先 `server.close()` 停 accept，再排空写队列（3 秒兜底），不得掐断在途写事务。

另外：验证（`verify`）只在 pi 会话由 agent 执行，**Web 端不得新增 verify 端点**（无 LLM 通道）。当前 Web 写端点共 7 条：`pool/move`、`pool/decide`、`import`、`report`、`todos/submit`、`todos/complete`、`todos/reopen`。

## 4. hook 落盘：只有两个生命周期 hook 能写

热路径 hook——`before_agent_start` / `tool_call` / `tool_result` / `session_before_compact`——**只做只读计算、展示增强、上下文注入与调用拦截，绝不开写事务**。

只有 `session_start`（`ensureDefaults` 回填）与 `session_shutdown`（兜底落账）例外，且写入必须包在 `withFileMutationQueue` 内串行落盘。

MCP 计量遵守同一约束：`tool_result` 只做**内存 pending 自增**（O(1)、零 I/O），落账仅在安全点事务内完成（`mutateStore` 顺带 / 查看面 flush / `session_shutdown` 尽力）。想"落一次少一次丢失"就在热路径写库，是这条规则要挡的具体错误。

展示预算：历史速览 ≤12 行，工具历史尾注 ≤8 行，压缩台账 ≤20 行。

## 5. 加字段：先过白名单

- **`MarketSnapshot` 加字段必须同步登记进 `store.ts` 的 `emptySnapshotPayload`**，否则每次 save 都会静默抹掉它。这个函数是逐字段显式拷贝的白名单，不是 spread。
- 快照明细（`listings` / `keywords`）不进 `store.json`，导入时一次性写进 `.pi/compass/snapshots/<id>.json` sidecar。**要改已导入快照的明细必须新建 snapshot id**——`persistSnapshotPayload` 见文件已存在即跳过写入。
- sidecar 内容 load 时只做整体 `as` 强转、`assertStore` 不逐条校验。消费侧在 sort / slice / `toFixed` 之前**必须自行 `Number.isFinite` / `typeof` 过滤**：坏 rank 会按原位挤占 top-N 席位，字符串数值会让前端抛错。
- `CompassStore` 新增顶层集合一律走「可选数组 + `ensureDefaults` 回填 + `load()` 迁移检测与回写」（`outcomeChecks` / `lessons` / `todoResolutions` 是先例），`schemaVersion` 保持 1。

## 6. `assertStore`：向前向后两个方向都要兼容

给 `assertStore` 加新硬校验前，**必须先确认存量 store 能通过**。load 与 save 跑的是同一份 `assertStore`：一条不合规的老记录会让 store **既读不出也写不进**、扩展直接砖化；失败被包成 `StoreIoError` 后只显示「读取罗盘数据失败」，看着像文件损坏，而不是自己刚加的校验太严。

所以：新增字段一律**可选** + `ensureDefaults` 回填/规范化；要收紧脏数据请在**写入侧或迁移时**做，不要在 load 也会跑的校验里做。

反方向同时要守：旧版扩展回滚后忽略新字段即可打开。具体地，`decisionLog.type` 在旧版 `assertStore` 里是严格白名单，**新增取值会让回滚后的 store 打不开**——所以待办处理动作不写 `decisionLog`，审计链由记录自身承载（actor / 时间 / 说明），`history.ts` 在读侧合并成时间线。

## 7. 路径不要自己拼

一切输入输出路径走 `resolveInputPath` / `resolveOutputPath`，它们把路径限制在宿主项目内（canonical 化 + 符号链接解环 + `pathWithin` 检查），报告还硬性要求 `.md` 扩展名并限定在 `.pi/compass/reports/` 内。不要绕过它们直接 `resolve()` 拼路径。

报告落盘产物**只有 `.md`**：浏览器端把 Markdown 渲染成 HTML 只是阅读方式，不要为了好看再生成一份 HTML 文件。

`store.json` 与报告都走「临时文件 + rename 原子替换」，目录 0700、文件 0600；裸 `writeFile` 的"先截断后写"会让并发读方读到截断内容、失败时毁掉上一份好数据。

## 8. 派生待办 id 是持久化数据格式

派生待办 id（`todo_<kind>_<市场/候选/来源>` 拼接）是条目与 `store.todoResolutions.todoId` 之间**唯一**的关联键。`assertStore` 只校验它全局唯一，悬空记录一律静默忽略——所以这个字符串本身已经是持久化数据格式的一部分。

改闭环四类（`metric_divergence` / `budget_warning` / `budget_fused` / `deep_missing_data`）的 id 拼法、kind 取值或实体 id 来源，**必须连带迁移存量记录**，否则已勾选的条目重新浮出、已处理分区留下永久孤儿，且全程无报错。

配套不变式：条目本体永远由 `todo.ts` 派生（唯一所有者，不实体化、不双真相源）；状态机（提交→验证→勾选→重开）只能经 `service.ts` 的四个函数迁移；抑制必须带失效水位（预算=月份、偏差=快照集合指纹、深研=本次进入 deep_research 的周期），派生层只读判定、绝不改写记录。错位的最坏情况必须是「多提醒一次」，绝不能是漏提醒。

## 收尾自检

改完写路径，逐条回答（有一条答不上就别提交）：

1. 有没有在某个 mutator 回调里直接或间接又开了一次写事务？
2. 新加的 Web 写端点，`WRITE_PATHS` 登记了吗？走 `enqueueWrite` 了吗？
3. 新加的落盘发生在哪个 hook？是不是只在 `session_start` / `session_shutdown`？
4. 新加的 `MarketSnapshot` 字段进 `emptySnapshotPayload` 了吗？
5. 新加的 `assertStore` 校验，拿一份**存量** store 跑过 load→save 吗？
6. `npm run check && npm test` 全绿了吗？（提交前的 hook 会再拦一次）
