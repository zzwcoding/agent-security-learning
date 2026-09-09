# 34-m2-burn-registry-live: 焚毁表跨进程读口接通（G2-1，安全置顶）

**What to build:** verify-ticket.ts 生产装配的 used 读口从 MemoryBurnRegistry 换成 M2 真相：agent 生产路径接 case-backend /internal/used-tokens（票 03 已有 POST/GET），跨进程 ApprovalToken 重放第二次必 403 token_used（不再只靠 executed_at+TTL 兜底）；读口不可达 fail-closed（INV-1）；app.test 补跨实例重放断言。

**Blocked by:** 28

**Touches modules:** `m2`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 生产 verifyTicket 焚毁读口查 M2 真相，跨进程重放 403 token_used（源：遗留标记 11-1·INV-2）
- [x] 读口不可达 fail-closed 拒绝执行（源：INV-1）
- [x] 性能仍在验证预算内（票 07 ≤5ms 口径复核）（源：m9 卡测试计划）

---

## 实现记录（2026-09-09，编码窗口）

**形态裁决（票面"查 M2 真相 + fail-closed"口径）**：闸本体与 `BurnRegistry.has()`
同步读口**一字未动**（票 07 契约测试面 + `executeApproved` 同步段的 interrupt 同步抛出
契约都不破坏）；异步性全部放在**闸前装填**——`executeApproved` 拆成同步头
（awaitApproval/interrupt，票 11 契约原样）+ 异步尾段（决定已落、不再有 interrupt 时，
先 `await` 跨进程焚毁查询把真相并进一次性读口，再进同步闸）。worker 调用点全部是
async 节点 + `await ctx.executeApproved`（knowledge:213 / chat:330，票 17/23 形态），
承受异步查口无压力；两处 sync 布景节点（APPROVAL_DEMO_FLOW 的 execute_action、
approval-loop.test.ts 的 l2Flow）随之改 `async + await`——决定已决路径现在返回
Promise，不 await 会把 Promise 写进 checkpoint 并把闸拒异常漏成 unhandled rejection
（回归实测咬出，见下）。

**落点**：
- `token-ports.ts`：出站 seam 第三件 `UsedTokenReader`（`lookup(jti): Promise<boolean>`）
  + 生产 adapter `HttpUsedTokenReader` → GET `CASE_BACKEND_URL`（缺省
  `http://case-backend:3002`）`/internal/used-tokens/:jti`。200=已焚、404=未焚、
  **其余状态码/网络错一律抛**——「查不到真相」≠「真相是没有」，裁决权交给闸侧。
- `graph.ts`：`ExecuteOpts.usedReader` 注入位；`resolveUsed()` 把 M2 真相与本地
  `deps.used` 取**或**装进一次性 BurnRegistry（叠加不是替换，既有 MemoryBurnRegistry
  测试替身不被 M2 的 404 屏蔽）；查询键 = wire payload 的 jti（**未验签**，仅作查询键，
  伪造票在闸的验签步被拒、装填结果读不到）；查询失败 → 哑读口（`has()` 恒抛）→ 闸内
  异常归 fail-closed 桶 **signature_invalid** → DENIED 审计 + run 强杀（INV-1）。
- `app.ts`：buildApp 增 `usedReader?` 注入位（**不默认装**，沿 `used` 的「不传=不查」
  口径，全部既有测试零影响）；`index.ts` 生产装配
  `usedReader: new HttpUsedTokenReader()`——agent 生产路径就此查 M2 真相。

**验收口径重明确（票面第三条）**：预算两段分开量——
① **本地验票逻辑（verifyTicket 同步本体）≤5ms 不变**（票 07 口径，2000 次/路径
冻结时钟热循环复测）：task_ticket avg **0.0035ms**、approval_token avg **0.0042ms**
（预算余量约 1200 倍）；
② **含 M2 查询的完整验票**（读口 GET RTT + 闸本体 = 决定已决路径真实成本；本机
真 case-backend 子进程，200 次）：avg **0.184ms** / p95 **0.432ms** / max 0.822ms。
compose 内网 RTT 会略高但同量级；该段成本依赖 case-backend 可用性，读口不可达时
fail-closed 拒绝执行（可用性归 INV-1 语义管，不用性能预算兜）。

**TDD**：先红后绿。红 = token-ports.test.ts 读口 wire 形 6 测（200/404/5xx/网络错/
encodeURIComponent/env 目的地）+ app.test.ts「焚毁表跨进程读口」4 测（见下）全失败
（HttpUsedTokenReader 未实现）；绿后全过。跨实例重放测试形态 = 票 30「子进程起真
case-backend」× 票 11「两个全新 buildApp 实例」：实例 A（生产装配形态：burn=M2 登记、
usedReader=M2 读口、无本地表）批准执行后进程消失，实例 B（全新内存库：无本地焚毁
记录、无 executed 卡可兜底）经泄露票 + `decideApproval` 直塞（INV-9：闸只信票本身）
resume——**B 本地一切干净，唯一能拦它的是 M2 真相**，403 token_used → DENIED 审计 +
run failed + 动作未执行。另锁：读口不可达 fail-closed（signature_invalid 拒绝执行，
绝不放行）；未焚票放行不误伤；读口与本地表取或的合并语义（写反 = 本地真相被 404
屏蔽）。

**回归**：agent 328+2sk → **339+1sk 零删除**（本票 +10：wire 6 + 跨进程 4；skip 差
1 是 chroma 真容器冒烟的条件探测在本机容器可达时执行了，与本票无关，原有 330 个
测试一个不少）；全仓 `pnpm test` 绿（case-backend 52 / evals 93 / web 80 / ingest 31 /
mcp-audit 14）；`pnpm lint` / `pnpm typecheck` 全绿；`python3 tools/check_specs.py`
PASS（0 警告）；`pnpm check:boundary` PASS（0 越界，9/9 条禁令全有人查）。
TDD 红灯之外的第二口咬人：首版直接把 `executeApproved` 尾段异步化后，approval-loop
的「票过期强杀」测试红（sync 布景节点不 await → 闸拒异常变 unhandled rejection、run
误 completed）——按票 17/23 async 节点先例改布景节点后绿，教训进 lessons。

**范围边界**：写侧 fire-and-forget 烧票（HttpTokenBurner）不动——同进程「刚烧未落库」
的毫秒级窗口仍有卡的 executed_at 单次执行标记兜底（票 11 记录的第二层），跨进程读口
接通是本票全部战果；M2 读口超时 2s（照 HttpMintClient 先例）。
