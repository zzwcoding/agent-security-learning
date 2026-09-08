# 11-01 · 票 11：审批回路——interrupt 挂起、审批卡 REST 与一次性 ApprovalToken

## 三问

**位置感**：数据地基（m2）、安全基座（m9 五件套）、正门（m1）、编排骨架（m3 薄径）都齐了，
现在装上这个系统灵魂的那根线——「危险动作永远等人点头」：

```
票03 m2 ✅ → 票04-08 m9安全基座 ✅ → 票09 m1正门 ✅ → 票10 编排薄径 ✅
→ 票11 审批回路 ✅你在这里 → 票13+ 各 worker 子图 → 前端/评测
```

- **这一步是干嘛的？** 给 agent 服务装上「暂停键 + 签字盖章台」：图跑到 L2 高危动作
  （比如隔离主机）时，不执行，而是开一张「审批卡」挂在 `awaiting_approval` 状态等人；
  值班长在审批卡 REST 上批准 → 系统去 gateway 铸一枚**一次性签名票**
  （ApprovalToken）→ run 从中断点原地复活，拿着票过验票闸执行；驳回 → 什么都不执行，
  审计留痕，run 跳过动作走完。
- **什么需求逼我们这么设计？** PRD 的铁律 INV-3：任何 agent 的票都**物理上不含** L2
  工具——想干危险动作，唯一的门是「人批准 → 铸一次性票」。麻烦有三个：① agent 跑到
  一半要停下等人，可能等几分钟甚至**进程都被杀了重启**，回来还得知道「我刚才干到哪、
  在等谁的决定」（Tracecat 持久性语义）；② 「对话里说已批准」不算数，只有盖了 HMAC
  钢印的票才算数（INV-9 验签不信文本）；③ 两个值班长同时点按钮怎么办？——后到者 409。
- **解决什么麻烦？** 挂起现场全部落 SQLite（审批卡一行 + 信封链 + run 状态机），所以
  「杀进程重启」不丢任何东西；决定用 `(run_id, tool, params_hash)` 三个字段钉死在某次
  tool_call 上——换参数、换 run 都套不上旧决定；一次性靠「执行后即焚毁登记 + 卡打
  executed 标记」双保险，重放必 403。

## 全链路一览

```
[L2 节点] ctx.executeApproved("isolate_host", {host}, …)          graph.ts（执行器内的唯一正门）
   │ ① 查卡：该 (run, tool, params_hash) 有没有还没执行完的卡？
   │    没有 → 开卡（一个事务三件事）approvals.ts::openApprovalCard：
   │      插 approvals 一行(pending) → 广播 approval_required → run 转 awaiting_approval
   │ ② 抛 ApprovalInterrupt 中断控制流 → runner 原地收手（挂起≠失败）
   ▼
GET /api/v1/approvals?status=pending        ← Web 审批页从这里看「等谁点头」
POST /api/v1/approvals/:id/approve          ← 值班长盖章（duty_lead）
   │ ③ 铸票：POST gateway /internal/mint（票 06 的 py 件真签 HMAC）token-ports.ts
   │ ④ 裁决：decideApproval（审批状态机仲裁：pending 之外一律 409）
   │      卡记 token → 审计 approve → 广播 approval_decided
   │ ⑤ resume：graph.ts::resumeRun——验信封链 → run awaiting_approval→running
   │      → 从信封链末态重跑中断节点 → 这次查到 approved 卡，拿到 token
   │ ⑥ 验票闸 verifyTicket（票 07）：验签/时效/焚毁/工具/参数指纹/案件绑定
   │      allow → 执行 mock 动作 → 焚毁登记(INV-2) → 卡打 executed 标记
   │      deny  → 审计 DENIED → 强杀 run（fail-closed，绝不带病执行）
   ▼
run completed；SSE 全程可看：approval_required → approval_decided → tool_call → tool_result
（驳回支线：reject 不铸票不执行，节点拿到 rejected 决定跳过动作，run 照常 completed）
```

## 跟着数据走：run_223563e4 的审批一日（真跑出来的）

1. **开 run**：`POST /internal/runs {"kind":"alert_flow","alert_id":"al-5712"}`
   （`AGENT_FLOW=approval_demo` 布景图）→ 202。跑到 `execute_action` 节点碰上 L2 动作：
   落盘现场是 `runs.status='awaiting_approval'`、`approvals` 多一行
   `(apr_f8a0540e…, pending, isolate_host, params_hash=sha256:50ec4b75…)`，事件流停在
   5 号 `approval_required`。
2. **捣乱实验·杀进程**：这时候 `kill -9` 把 agent 进干掉。重启后连的还是同一份
   SQLite——pending 卡原样躺在盘上，`GET /api/v1/approvals?status=pending` 还是那一张，
   `run_id` 一字不差。挂起现场不靠进程记忆，靠落盘。
3. **值班长批准**：`POST .../approve {"approver":"duty_lead"}` → agent 拿着卡的
   tool+params 去 **gateway 的 py 件**换回一枚真签名的票（`eyJhbGciOiAiSFMyNTYi…`，
   里面 `params_hash` 与卡一致）→ 卡转 `approved` → run 复活：从信封链末态重跑
   `execute_action`，这次查到卡是 approved，拿着票过闸——TS 闸验 py 签的票，通过 →
   mock EDR 隔离 centos7 → 票的 jti 焚毁登记、卡打上 executed → run `completed`。
   事件流 6-12 号一气呵成：`approval_decided → audit → node_enter → tool_call →
   tool_result → node_exit → audit`。
4. **第二个值班长手慢了**：再 POST 一次 approve → 409 `InvalidTransition`。审批卡是
   单决媒体：裁决走的是和 run 状态机同源的仲裁（pending 之外没有去处）。
5. **换参数的捣乱者**：批准前把节点要的参数从 `{host:"centos7"}` 改成
   `{host:"web-99"}`——旧决定**套不上**：按 `(run, tool, params_hash)` 查卡查不到
   web-99 的，只能开新卡重新等审批。这就是「决定绑定 (run, tool_call)」的落实。
6. **驳回支线**：新 run → `POST .../reject {"reason":"证据不足"}` → 不铸票、mock 动作
   没跑，run 末态里留着 `{executed:false, outcome:"rejected"}`，审计有 `reject`
   （actor=duty_lead）没有 `execute`。

## 新技术点四要素：两阶段恢复（interrupt/resume）与控制流异常

- **名字**：interrupt/resume 两阶段执行（LangGraph `interrupt()` / Tracecat 审批中断的
  同构实现）。本项目没有引 LangGraph，用**控制流异常**（control-flow exception）实现。
- **作用**：解决「节点执行到一半要等一个**人的异步输入**」——图执行是同步循环，
  人的批准可能几分钟后来，甚至进程都换了。和「轮询等审批」的区别：轮询要占住执行流，
  interrupt 是**把现场拍平落盘、把执行流整个交还**，回来时从盘上重建。和普通异常的
  区别：普通异常=出错要杀 run，`ApprovalInterrupt`=正常业务分支，runner 捕获后**不杀**
  、原样返回挂起中的 run。
- **参数（本项目的形态）**：`NodeCtx.executeApproved(tool, params, opts, action)` 是
  节点唯一该用的正门——它内部先 `awaitApproval`（查卡→开卡→抛中断），resume 重跑时
  同一位置拿到决定再过闸执行。关键约定：**resume = 从信封链末态重跑中断的那个节点**，
  所以节点要写成可重入的（本项目节点都是确定性的，重跑无副作用）。
- **用法**（services/agent/src/graph.ts）：
  ```ts
  // 节点里（这就是全部用法——闸、焚毁、审计都在 executeApproved 里）：
  const out = ctx.executeApproved("isolate_host", { host: "centos7" },
    { reason: "调查报告建议遏制" },
    (p) => ({ mock_edr: "isolated", host: (p as { host: string }).host }));
  ctx.state.execution = out;   // {executed:true,…} | {executed:false, outcome:"rejected"}
  ```
  resume 入口在 `graph.ts::resumeRun`（先 `restoreCheckpoint` 验链，再把 budget 的
  steps/tokens 从 run 行接续回来——资源兜底口径跨重启不清零）。

## 关键顿悟

- **「挂起」是落盘数据，不是进程状态**。awaiting_approval 的全部现场 = 一行审批卡 +
  信封链 + run 状态，全在 SQLite。所以杀进程重启对它无感——这是「Tracecat 持久性
  语义」能落地的唯一方式：凡是等人的东西，一律不许活在内存里。
- **决定绑定靠「指纹」不靠「位置」**。`(run_id, tool, params_hash)` 是这次 tool_call
  的指纹，决定、票、执行三方都对这枚指纹——resume 时节点重跑、代码路径完全一样，
  靠查指纹而不是靠「记得上次中断在哪」。改一个字节的参数，指纹就对不上，旧决定作废。
- **审批卡和 run 一样是状态机动物**（INV-10 同源仲裁）。pending 是唯一可裁决态，
  裁决是终局——「并发审批后到者 409」不需要锁、不需要队列，一张迁移表就仲裁完了。
- **铸票和裁决的顺序有讲究**：先铸票、后（事务内）裁决。铸票失败 → 卡还 pending，
  批准人可以重试，永远不会出现「卡显示已批准但没票可执行」的悬置态；反过来若先裁决
  后铸票，gateway 一抖就造出僵尸批准。并发双批最多白铸一枚，随 409 作废（300s 自焚）。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 0) 全绿基线
(cd services/agent && npx vitest run)   # 应看到 Tests  113 passed（本票新增 26）
python3 tools/check_specs.py            # 应看到 spec gate: PASS（5 警告）

# 1) 起 gateway（py 铸票件，:8002）+ agent（:3003，审批演示图），自己的终端跑
KEY=soc-demo-test-hmac-key-do-not-use-in-prod
(cd services/gateway && SOC_HMAC_KEY=$KEY ../../.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8002)
(cd services/agent && SOC_HMAC_KEY=$KEY GATEWAY_URL=http://127.0.0.1:8002 \
    AGENT_FLOW=approval_demo AGENT_DB_PATH=/tmp/agent-11.sqlite npx tsx src/index.ts)
```
```bash
# 2) 开 run → 202；此刻 run 已停在 awaiting_approval（L2 动作等人）
curl -s -X POST http://127.0.0.1:3003/internal/runs -H 'content-type: application/json' \
  -d '{"kind":"alert_flow","alert_id":"al-5712"}'
curl -s "http://127.0.0.1:3003/api/v1/approvals?status=pending"
# 应看到 1 张卡：tool=isolate_host、params={host:centos7}、status=pending、executed=false

# 3) 看 SSE 里的 approval_required（2 秒会自己断开，run 非终态时流是挂着的——正常）
curl -s -m 2 "http://127.0.0.1:3003/api/v1/events/stream?run_id=<上一步的run_id>" | grep approval_required

# 4) 捣乱实验·杀进程重启（验收 4 的现场版）：kill agent 再照第 1 步重启它，
#    再查 pending——同一张卡还在，run_id 一字不差

# 5) 值班长批准 → 200，返回 approval_token（py 真签）与 run_status=completed
curl -s -X POST "http://127.0.0.1:3003/api/v1/approvals/<卡片id>/approve" \
  -H 'content-type: application/json' -d '{"approver":"duty_lead"}'

# 6) 后到者 409（同一张卡再批/再驳都一样）
curl -s -w ' [%{http_code}]\n' -X POST "http://127.0.0.1:3003/api/v1/approvals/<卡片id>/approve" \
  -H 'content-type: application/json' -d '{"approver":"admin"}'
# 应看到 {"error":"InvalidTransition"} [409]

# 7) 驳回支线：再开一个 run，这次 reject → run_status=completed 但动作没执行
curl -s -X POST "http://127.0.0.1:3003/api/v1/approvals/<新卡id>/reject" \
  -H 'content-type: application/json' -d '{"approver":"duty_lead","reason":"证据不足"}'
python3 -c "
import sqlite3; db=sqlite3.connect('/tmp/agent-11.sqlite')
for r in db.execute('SELECT id,status,approver,executed_at IS NOT NULL FROM approvals'): print(r)"
# 应看到：批准卡 (approved, duty_lead, 1)；驳回卡 (rejected, duty_lead, 0)

# 8) 终局核对：事件流编号连续、decided 在 required 之后、有 tool_call/tool_result
python3 -c "
import sqlite3; db=sqlite3.connect('/tmp/agent-11.sqlite')
for r in db.execute('SELECT id,type FROM run_events ORDER BY id'): print(r)"
```
玩完 `lsof -ti:8002,3003 | xargs kill -9` 关服务；`rm -f /tmp/agent-11.sqlite*` 重置布景。
（M2 没起时 agent 日志可能出现 used_tokens 登记失败告警——焚毁登记是 best-effort
POST 到 case-backend，compose 全栈下自动落到 M2 used_tokens 表。）
```
