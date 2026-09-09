# 43-m3-shared-outbound: 安全件与重复收敛（F1+F3+F5+F4+F7）

**What to build:** ① gated() 验票包装六处收敛为共享 makeGatedCall（安全语义集中一处，F1）；② guards/llm/fga 三客户端抽共享 outbound 件（超时+错误分类+ProbeResult，F3，顺带修 reason 标签口径漂移）；③ ChatSeam 上提 llm-client、token-ports 抽 postMint、McpTool 收敛（F5）；④ openfga 钉 digest、msb 版本记录（F4）；⑤ tsx 挪 devDep、web/dist 入 gitignore（F7）。行为零变化，测试全绿。

**Blocked by:** 33, 35

**Touches modules:** `m3`, `m4`, `m8`, `m9`, `m12`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] gated() 单处定义（源：结构-6）
- [x] 共享 outbound 件且 reason 口径统一（源：结构-8）
- [x] 微重复收敛 + 依赖卫生（源：结构-9/11/12·对账一-2/3/7）
- [x] 全仓测试零删除零放松（源：体检口径）

## 实现记录（2026-09-09）

**基线 vs 重构后（行为零变化的证据，数字只增不减）**：agent 417 passed+4 skipped → **431+4**（新增 gated-call.test.ts 6 条 + outbound.test.ts 8 条，既有 417 条零删除零改动）；case-backend 60→60、evals 99→99、ingest 41+1sk→41+1sk、web 100→100、mcp-audit 14→14 全部持平。`pnpm lint` / `pnpm typecheck` / `python3 tools/check_specs.py`（PASS 0 警告）/ `pnpm check:boundary`（PASS 0 越界，self-test 17/17）全过。

- **F1**：新共享件 `services/agent/src/gated-call.ts`——`makeGatedCall` 收敛七处（票面点名的 5 flow + graph executeApproved 变体，外加 close.ts 的同款第 7 份）。「闸拒审计长什么样」（action=deny / result=DENIED / details{tool,reason,params_hash,…}）与错误拼法 `${prefix}_gate_denied:${reason}` 全仓唯此一处；三处微漂移参数化：① deny 前缀（prefix）③ 凭据（creds 回调：任务票有无 caseId / 审批票 approvalToken+used）② 放行广播（emitToolCall/emitToolResult 钩子，chat 的 tier 在声明里拼）。审批变体只并「验票+闸拒」段，放行后焚毁/执行标记/带 result 的 tool_result 事件顺序是票 11 契约留在原处（事件顺序一动即行为变化）；其 tool_call 在验票前自发、tool_result 带执行结果，共享件不传 emit 钩子即保持此序。投石问路已验：investigation flow 靠 `msg.includes("_gate_denied:")` 识别闸拒不吞（INV-1）——拼法未动，消费方无感。
- **F3**：新共享件 `services/agent/src/outbound.ts`——`timeoutSignal`（出站 signal 唯一造口）/`isOutboundTimeout`/`outboundTimeoutReason`/`smokeHttpProbe`/`ProbeResult`。**reason 口径漂移修正**：guards 判超时原只认 `TimeoutError`，统一为 `TimeoutError||AbortError`（与 llm/fga 同款）并在件内写明（guards_timeout/guards_unreachable 标签不变，closed-port 用例照绿）；llm 的稳定 code `timeout`/`unreachable` 是契约测试锁定面，只复用判定不动标签。四客户端接线：guards-client / llm-client / fga-client / vector-store（chroma）；llm 探针不判 HTTP 状态的行为保持（smokeHttpProbe 不传 onHttpStatus 即是此口径）。
- **F5**：`ChatSeam` 三份手抄（triage/investigation/knowledge 的 KnowledgeChatSeam 同形）上提 `src/llm-client.ts`，triage 处再出口兼容 chat 侧既有引用；`HttpMintClient` 两个 mint 方法抽私有 `postMint`（wire 形留在各方法可读）；mcp-audit `McpTool` 两处声明收敛到 `transports.ts`（wire 形归传输层），`tier.ts` 再出口保持 index.ts 库出口不变。
- **F4**：compose openfga `v1.19.0` → `@sha256:78d1fa601d42340ecb131305d80d3767d0f254f9b1bc3646f9a557e11b24c63a`（多 arch index digest；registry API 实查 + 本机 arm64 daemon pull 实证与 tag 同一镜像，票 37 口径：Docker Hub index digest 可 pull、升级跟踪以 index 前进为准）；msb 版本记录落在 `sandbox.ts` msbProbe 旁：实测 `msb --version` = **0.6.16**（2026-09-09）。
- **F7**：mcp-audit `tsx` dependencies → devDependencies（lockfile 同步；bin 壳 `import "tsx"` 形态保留——demo 级无构建方案改纯 JS 壳不可行，包 private 不外发、CLI 只从仓内跑，bin/脚本/测试实测不坏）；web/dist 核实：`dist/` 已在 soc-demo/.gitignore 且 `git ls-files` 零 dist 入库——对账一-7 的该半项在库内已成立，无需动作。
- 测试文件零改动、零删除（重构票铁律）；新共享件单测锁「闸拒审计逐字段形状 / 前缀参数化 / 凭据进闸 / onAllow 取 jti / AbortError 算超时 / 探针三态」。教学文档：`lessons/43-01-安全件收敛-gated闸一处定义与出站共享件.md`。
