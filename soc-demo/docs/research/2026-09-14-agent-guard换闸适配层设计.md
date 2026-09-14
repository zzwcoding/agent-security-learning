# agent-guard 换闸适配层设计（票 27 研究期产物，2026-09-14）

> 定位：票 27 的开工前置硬闸——包接口与闸语义的映射，哪边包哪边，一页纸说清再动工（jiaotu 票 27 What-to-build）。
> 范围：**只研究不施工**。生产代码/测试零改动，docker 零触碰。
> 路径约定：`soc-demo/` = 本仓根；`jiaotu/` = 包真源仓根 `../agentjiaotu/`（只读）。
> 包真源：`jiaotu/packages/agent-guard/src/{guard,token,manifest,index}.ts`；闸现状：`soc-demo/services/agent/src/verify-ticket.ts`。

## 0. 结论 TL;DR（先说拍板建议）

1. **换闸不用 `createGuard`（包的整闸），用包的纯函数面** `verifyToken` / `verifyTokenSignature` / `paramsHash`（`jiaotu/packages/agent-guard/src/index.ts:24-30`）。理由：`createGuard` 的 L2 是**放行前同步焚毁**（`guard.ts:282-296`），与红线③「soc-demo 用后焚」直接冲突；且它强制 `gatewayUrl + auditApiKey`（`guard.ts:115-126`），要求 `/internal/tickets/:jti/burned|burn` 与 `/internal/audit/events` 三个 HTTP 缝——soc-demo 的焚毁真相在 case-backend `used_tokens`（`services/agent/src/token-ports.ts:102-125`），这三个端点不存在。
2. **适配层形状**：soc-demo 保留 L0/L1/L2 控制流（`tierOf`，红线②）、case/run 绑定（红线①）、用后焚顺序（红线③）、7 值 reason 家族、`VerifyResult` 带 payload 的返回形、形状把关（`asTicketClaims`/`asApprovalClaims`）；包出**票面裁决真相**（签名/exp/jti/焚毁/allowed_tools/params_hash 六项判据）。公共面（`verifyTicket`/`VerifyCtx`/`VerifyResult`/`paramsHash`/`BurnRegistry` 等）逐名冻结——六个消费方（`gated-call.ts:15`、`graph.ts:34`、`app.ts:21`、`envelope.ts:14`、`approvals.ts:12`、`ticketing-rig.ts:14`）零改动。
3. **依赖落位推荐 `link:` 协议**：`services/agent/package.json` 加 `"@agentjiaotu/agent-guard": "link:../../../agentjiaotu/packages/agent-guard"`。包是 TS 源直出（`main: src/index.ts`，`jiaotu/packages/agent-guard/package.json:6`），`link:` 符号链接让 vitest/vite 把包当源码转译（file: 的硬链快照会被 vite 当 node_modules 依赖外置，`.ts` 主入口有加载风险）；改动即时生效（狗粮共演期刚需）；lockfile 在案（验收第 2 条字面达成）。
4. **现有 `verify-ticket.test.ts` 在推荐形状下零改动照跑**（逐 test 核对见 §5）。已知微差只有一处且推荐形状下为零（§5 表）。

---

## 1. 接口对照表：包 verifyTicket vs soc-demo verifyTicket

### 1.1 入口签名

| 维度 | soc-demo（闸现状） | 包（agent-guard） | 适配方案 |
|---|---|---|---|
| 入口 | `verifyTicket(toolCall, ctx?, nowSec?, opts?)` 同步函数（`verify-ticket.ts:182-187`） | `createGuard(config) → Guard`；`guard.verifyTicket(toolCall, ctx)` **async**（`guard.ts:91-96,194`） | 不用 createGuard；包纯函数 `verifyToken/verifyTokenSignature` 均同步（`token.ts:50,91`），适配层保持同步签名，gated-call 零 churn（`gated-call.ts:74-79` 现为同步调用） |
| toolCall | `{name, params?}`（`verify-ticket.ts:183`） | `{name, params}`（`ToolCall`，`guard.ts:35-38`） | 同形；params 可选→必填对调用方无感（闸内 `paramsHash(undefined)` 两边都容忍） |
| ctx.ticket/approvalToken | `VerifyCtx.ticket?/approvalToken?`（`verify-ticket.ts:44-47`） | `VerifyContext.ticket?/approvalToken?/requestId?`（`guard.ts:40-47`） | 同名同义；`requestId` 是包审计回传专用，适配层不接（见 §4-4） |
| ctx.caseId/runId | **soc-demo 独有**（`verify-ticket.ts:47-49`） | **包没有**（红线①的根源） | 留在适配层：allow 前比对 `p.case_id/p.run_id`，不符 → `scope_insufficient`（照抄 `verify-ticket.ts:221-222,239`） |
| ctx.used | `BurnRegistry { has(jti) }` 同步读口（`verify-ticket.ts:27-29`） | 包纯函数面有 `isBurned: (jti) => boolean` 回调缝（`token.ts:23`）；包闸面则走 HTTP 查询（`guard.ts:262-281`） | `isBurned: (jti) => ctx.used?.has(jti) ?? false` 一行桥接——**BurnRegistry 语义零翻译直通** |
| 时钟 | `nowSec` 注入秒，缺省 wall clock（`verify-ticket.ts:180-185`） | 纯函数 `opts.now`/第二参（秒，`token.ts:19-21,56,96`）；createGuard 是 `now: () => number` 配置（`guard.ts:84-85`） | 适配层透传 `nowSec` → 包 `now`；契约 clock policy（禁 wall clock）两边同文 |
| HMAC 密钥 | `opts.hmacKey ?? env SOC_HMAC_KEY`，缺 → `signature_invalid`（`verify-ticket.ts:192-194`） | 纯函数收 `hmacPublicKey: string`，空/缺 → `signature_invalid`（`token.ts:57`）；createGuard 构造期 GuardConfigError fail-fast（`guard.ts:118-120`） | env 兜底留适配层；空钥传给包函数同样落 `signature_invalid`（双保险同因） |
| 焚毁（写侧） | **闸不焚**。执行成功后执行方 fire-and-forget POST case-backend（`token-ports.ts:127-152`）——红线③ | 包闸 **allow 前同步焚毁**，`first_time:false` 输家 `token_used`（`guard.ts:285-296`） | **不采用**。适配层闸内零焚毁；包的 burn HTTP 缝不接线 |
| 返回形 | `{allow:true, reason:"allow", payload: claims}` \| `{allow:false, code:403, reason}`（`verify-ticket.ts:21-23`） | `{allow:true}`（**无 payload**）\| 同形 deny（`Verdict`，`guard.ts:32-33`） | 适配层保持 soc 返回形（payload 必须保留：重放测试断言 `first.payload.jti`，`verify-ticket.test.ts:143`；审批执行方从 verdict 取 jti，`gated-call.ts:59-60`） |
| reason 家族 | 7 值（`DenyReason`，`verify-ticket.ts:12-19`） | 9 值（`GuardDenyReason`，`guard.ts:21-30`）——多 `agent_revoked`（网关侧预留，spec 行为约定 8）、`guard_unavailable`（包网络 fail-closed 桶） | 适配层只产 7 值；包纯函数面的 5 个票面 reason（`token.ts:9`）⊂ soc 7 值，无需映射 |
| fail-closed 桶名 | 一切异常 → `signature_invalid`（`verify-ticket.ts:205-207`） | 一切异常 → `guard_unavailable`（`guard.ts:298-303`） | **保留 soc 桶名** `signature_invalid`（INV-1 的名字是契约：`verify-ticket.test.ts:289-299` 焚毁表炸了断言 `signature_invalid`） |
| 分级表 | `tierOf()` 读 `fixtures/tools.manifest.json`，未登记默认 L1（`tools-manifest.ts:68-72`；`fixtures/tools.manifest.json:3-6` policy 声明） | `ToolManifest {tools:{name:{level,scope?}}}`，YAML 严格子集（`manifest.ts:148-213`）；**未收录 → `scope_insufficient`**（`guard.ts:197-201`） | 红线②：不换表源。适配层继续用 soc `tierOf`——未登记无票 → `no_ticket`（`verify-ticket.ts:204`，manifest README 明文口径）；若误用包语义未登记会翻成 `scope_insufficient`，这是一条必须避开的回归 |

### 1.2 逐判据裁决顺序对照（票面路径）

任务票（L1）——soc `verifyTaskTicket`（`verify-ticket.ts:211-224`） vs 包 `verifyToken`（`token.ts:91-116`）：

| 步 | soc 现状 | 包 verifyToken | 判定 |
|---|---|---|---|
| 签名 | `unseal`：三段格式→恒时 HMAC→JSON 解析（`verify-ticket.ts:123-131`） | `verifyTokenSignature` 同序同法（`token.ts:50-77`）；**wire 格式逐字节同**：`<b64h>.<b64p>.<hex sig>`、HMAC-SHA256 over `b64h.b64p`、UTF-8 原始字节密钥、hex 摘要（`token.ts:2-3` 注释 + `verify-ticket.ts:125-129`） | ✓ 同一契约（两仓 `fixtures/tickets/contract.json` diff 为空，机器核对 2026-09-14） |
| 时效 | `nowSec >= p.exp → token_expired`（`:218`） | `at >= exp → token_expired`，缺 exp 同罪（`token.ts:78-80`） | ✓ 全等（JWT 严格早于语义同文） |
| 全量形状 | `asTicketClaims` 8 字段显式验型（`:151-162`） | **不查**（只查 jti 非空，`token.ts:100-101`） | ⚠ 形状闸留 soc（详见 §5 微差①） |
| 焚毁 | `ctx.used?.has(jti) → token_used`（`:219`） | `opts.isBurned?.(jti) → token_used`（`token.ts:102`） | ✓ 同序同位（都在 exp 后、scope 前） |
| allowed_tools | `!includes(tool) → scope_insufficient`（`:220`） | 同（`token.ts:110-114`） | ✓ 全等 |
| case/run 绑定 | `scope_insufficient`（`:221-222`） | **无** | 红线①：留适配层 |

审批票（L2）——soc `verifyApproval`（`verify-ticket.ts:227-241`） vs 包：包闸面 L2 用 `verifyTokenSignature` + 闸层自查（`guard.ts:236-259`），包纯函数 `verifyToken` 的 params_hash 分支（`token.ts:103-109`）：

| 步 | soc 现状 | 包 | 适配 |
|---|---|---|---|
| 签名+时效 | 同上（`:233-234`） | `verifyTokenSignature`（`token.ts:50-82`） | ✓ 用包 |
| 形状 | `asApprovalClaims` 9 字段（`:164-178`） | 包闸查 jti/tool/params_hash 三件（`guard.ts:245-249`）；`verifyToken` 只查 params_hash 类型（`token.ts:105`） | 形状闸留 soc（保 9 字段严格性） |
| 焚毁 | `used.has → token_used`（`:235`） | 包闸：HTTP burned 查询（`guard.ts:262-281`）；`verifyToken`：`isBurned`（`token.ts:102`） | 适配层自调 `ctx.used.has`（保持 soc「used 先于 tool」的顺序，见下） |
| **tool 绑定** | `p.tool !== toolCall.name → scope_insufficient`（`:236`） | 包闸有（`guard.ts:251-254`）；**`verifyToken` 的 params_hash 分支没有**（`token.ts:103-109`） | ⚠ 适配层必须自查——若天真信任 `verifyToken(params)`，「错工具+对参数」会从 `scope_insufficient` 变 **allow**（安全回归，非仅 reason 翻转） |
| params_hash | `paramsHash(params) !== p.params_hash → params_mismatch`（`:237-238`） | 包闸同（`guard.ts:256-259`，另加形状正则） | 用包 `paramsHash`（JSON 域逐字节同，见 §5-2） |
| case 绑定 | `scope_insufficient`（`:239`） | 无 | 红线①：留适配层 |
| **焚毁（写）** | 无（闸不焚，红线③） | 包闸：放行前 `POST burn` + `first_time:false → token_used`（`guard.ts:285-296`） | **不采用** |

### 1.3 包内双面辨析（为什么包自己也是「纯函数 + 闸层组装」）

包闸面对 L2 **不用** `verifyToken`，而是 `verifyTokenSignature` + 手排 tool/params/焚毁（`guard.ts:236-259`）；对 L1 才用 `verifyToken`（`guard.ts:216`）。soc-demo 适配层照这个分工即可与包自身用法同构——这正是「包出票面真相、soc-demo 出语境」的包侧原意。

---

## 2. 三差异红线逐条适配方案

| 红线（jiaotu 票 27 What-to-build） | 适配方案 | 证据 |
|---|---|---|
| ① case/run 绑定留 soc-demo | 适配层在包 verify allow 之后、返回之前比对 `caseId/runId`（任务票两查、审批票一查），不符 → `scope_insufficient`；`VerifyCtx.caseId/runId` 原样保留 | `verify-ticket.ts:221-222,239` 照抄；包 `VerifyContext` 无此二字段（`guard.ts:40-47`） |
| ② 分级表 tools-manifest.json 不换源 | 适配层继续 `tierOf()`（JSON 登记表 + 未登记默认 L1）；不接包 `toolManifest/toolManifestUrl`（不用 createGuard 即自然不接） | `tools-manifest.ts:68-72`；`guard.ts:197-201` 的「未收录→scope_insufficient」语义**不被引入** |
| ③ burn 顺序用后焚不改 | 适配层闸内零焚毁零网络；`BurnRegistry.has` → 包 `isBurned` 只读桥接；写侧仍由执行方调 `HttpTokenBurner`（执行成功后） | 包焚毁逻辑全部留在不接线的 createGuard 内（`guard.ts:152-162,262-296`） |

---

## 3. 依赖落位方案：跨仓 npm 依赖怎么落

### 3.1 现状事实

- 包声明：`{name: "@agentjiaotu/agent-guard", version: "0.0.0", private: true, main: "src/index.ts"}`——**TS 源直出、无 build、不可发布**（`jiaotu/packages/agent-guard/package.json`）。
- **包在 jiaotu 仓内也是零真依赖消费方**：gateway 的 e2e 测试走相对路径 import（`jiaotu/services/gateway/src/demo-script.e2e.test.ts:13` `import { createGuard } from "../../../packages/agent-guard/src/index.js"`），不经过 package.json 依赖；`jiaotu/pnpm-lock.yaml:39` 只有 `packages/agent-guard: {}` 一行 importer 记录。「狗粮首用」名副其实——soc-demo 将是第一个通过**依赖机制**消费包的方。
- 两仓均为独立 pnpm workspace（`jiaotu/pnpm-workspace.yaml`、`soc-demo/pnpm-workspace.yaml:1-4`），互不嵌套；soc-demo 钉 `pnpm@10.34.3`（`soc-demo/package.json:6`）。
- 两仓在本机是**兄弟目录**（`安全评估agent/soc-demo` 与 `安全评估agent/agentjiaotu`）。

### 3.2 候选机制对比

| 方案 | 机制 | lockfile | vitest/tsx 对 .ts 主入口 | 判定 |
|---|---|---|---|---|
| **`link:` 协议（推荐）** | `"@agentjiaotu/agent-guard": "link:../../../agentjiaotu/packages/agent-guard"`——pnpm 原生符号链接，node_modules 里是指回源目录的 symlink | 记录为 `link:../...` 条目，在案 | vite/vitest 对 symlink 解析 real path 后落在 node_modules **外** → 当源码转译，`.ts` main 无障碍 | ✓ 共演期最优：改包源即时生效、零重装 |
| `file:` 协议 | `"file:../../../agentjiaotu/packages/agent-guard"`——pnpm 硬链快照进 `.pnpm` 虚拟 store | 记录 `file:` 条目，在案 | real path 在 node_modules **内** → 默认外置，Node 直载 `.ts` main 有风险；兜底 vitest `server.deps.inline: [/agent-guard/]` | 备选：包**新增/删除文件**后需重装才可见，共演期摩擦 |
| 跨仓并入 workspace | soc-demo `pnpm-workspace.yaml` 加 `../agentjiaotu/packages/*` | 混写两仓包 | ✓ | ✗ 否：劫持 jiaotu 的 workspace 成员资格，两仓 lockfile 互相污染 |
| tarball（`pnpm pack` + `file:...tgz`） | 需要打包步骤 + 版本纪律 | 记录 + 完整性 |tgz 内可带 build 产物 | 可行但重；包还无 build/版本策略，属发布前置工程 |
| npm 发布（私有 registry） | 需去掉 private:true、定版本、解决 TS 源发布形态（build 产物或 types+source） | 标准 | 标准 | ✗ 本票不做：包自身契约与发布策略是 jiaotu 侧独立议题（远期开放问题） |
| git 依赖 | `git+file://` 或远端 | 记录 commit | 需提交才生效 | ✗ 共演期 DX 最差 |

### 3.3 推荐方案的影响面（施工期核对清单，本次零施工）

1. **lockfile**：`soc-demo/pnpm-lock.yaml` 新增 `services/agent` importer 下的 `@agentjiaotu/agent-guard: link:../../../agentjiaotu/packages/agent-guard`。link 依赖无完整性 hash——供应链控制即仓内既定口径「lockfile 入库 + PR 审 diff」（`soc-demo/pnpm-workspace.yaml:6-9`）。
2. **CI**：任何跑 soc-demo 测试的 CI 必须先把 agentjiaotu **checkout 到兄弟路径**再 `pnpm install --frozen-lockfile`。soc-demo 仓内无 `.github/workflows`（查证 2026-09-14）；仓内边界闸自述「CI 挂父仓库 ci.yml 的 ts job」（`soc-demo/tools/check_boundary.py:11`）——父仓库 ci.yml 不在两仓内，**L0 需指认其位置并确认能加兄弟 checkout 步骤**（开放问题 §8-1）。
3. **Docker（只flag不动作）**：agent 镜像构建上下文是 soc-demo 仓根（`soc-demo/services/agent/Dockerfile:1` 「构建上下文是仓库根」；`docker-compose.yml:44` `context: .`），`link:` 目标在上下文外 → `pnpm install --frozen-lockfile` 在镜像内会断。jiaotu 侧已有先例：gateway 镜像把包目录 COPY 进上下文（`jiaotu/services/gateway/Dockerfile:16`）。soc-demo 侧需 compose `additional_context:`（compose 2.17+）或 context 上移——**涉 docker，27 施工票内决定，本研究不碰**。
4. **typecheck**：`tsconfig.base.json` `noEmit + NodeNext + skipLibCheck`（`soc-demo/tsconfig.base.json`），包 main 指向 `.ts`，tsc 经 symlink 解析无 rootDir 冲突（无 emit）。
5. **边界闸**：`tools/check_boundary.py` 的 import 规则表管的是 workspace 包**之间**的相对 import 与方向（`check_boundary.py:16-33`）；裸包名 `@agentjiaotu/agent-guard` 不落任何 R 规则，预计绿灯（施工时跑 `pnpm check:boundary` 确认）。
6. **验收对表**：票 27 验收第 2 条「`@agentjiaotu/agent-guard` 成为 soc-demo 真依赖（lockfile 在案）」——link: 依赖 + lockfile 条目即字面达成；包的三个网络缝（burned/burn/audit-events）与 `reportExecution` 在 soc-demo **零接线**，属狗粮后续票，不挡本验收（开放问题 §8-4 请 L0 确认口径）。

---

## 4. 换闸语义保真：能逐字节保持吗

### 4.1 推荐形状下的保真结论

**现有 `verify-ticket.test.ts` 全部断言零改动照跑**（逐组核对）：

| 测试组（verify-ticket.test.ts） | 依赖的闸行为 | 推荐形状下 |
|---|---|---|
| 9 张契约 fixture 逐张（`:57-71`） | wire 验签+全判据序 | ✓ 包 `verifyToken` 本就是该契约的消费口（`jiaotu/specs/agent-guard.md:70`；`guard.test.ts:612-640` 已用同一份 contract.json 验过包） |
| paramsHash 与 py 逐字节（`:73-86`） | `paramsHash` 导出不变 | ✓ 公共面冻结，实现照旧（包内同名函数仅 JSON 域等价，见 §5-2） |
| 六种 403 reason（`:90-125`） | 7 值枚举与触发条件 | ✓ 每一 reason 的产生点在适配层保留原位 |
| L0 无票放行（`:127-130`） | `tierOf===0 → allow` | ✓ 留适配层（`verify-ticket.ts:202` 照抄） |
| 重放两段式（`:135-149`） | allow 带 payload.jti；used 命中 → token_used | ✓ payload 保留；`isBurned` 桥接 `used.has` |
| 伪造审批文本（`:153-172`） | 无文本入参位置；L1 票不升 L2 | ✓ 适配层签名不变，`verifyTicket` 入参本就无消息历史 |
| case/run 绑定 4 例（`:176-232`） | 绑定判定与 reason | ✓ 红线①留适配层 |
| 延迟 ≤5ms（`:236-261`） | 纯本地同步 | ✓（推荐形状下形状闸+包 re-verify 双次 HMAC，µs 级，无感） |
| fail-closed 五例（`:265-329`） | 坏票/缺字段/焚毁表炸/缺密钥/循环引用 → 全部 `signature_invalid` | ✓ 桶名保留 soc catch-all（`verify-ticket.ts:205-207`）；包函数对空钥/坏格式也产 `signature_invalid`（`token.ts:57-59`），同因同词 |

**SSE / 审计帧 / 错误串**：`makeGatedCall` 的闸拒审计骨架（`action:"deny"/result:"DENIED"/details{tool,reason,params_hash}`，`gated-call.ts:80-88`）与错误拼法 `` `${prefix}_gate_denied:${reason}` ``（`gated-call.ts:89`，investigation flow 靠这个子串识别「闸拒不吞」）都只吃 `verdict.reason`——reason 枚举不变则**逐字节不变**；`tool_call/tool_result` 广播（`gated-call.ts:92-94`）在放行后，不受换闸影响。六幕冒烟（`scripts/jiaotu-smoke-11.sh`、`scripts/web-smoke-21.sh`）断言的 403+DENIED 面同理保真。

### 4.2 不保真点清单（全部已规避或定界）

| # | 点 | 若天真换装会发生什么 | 推荐形状下的处置 |
|---|---|---|---|
| 1 | **形状闸时序**：soc 是「形状验型先于 exp」（`unseal→asClaims` 在 `:217`，exp 在 `:218`）；包是 exp 内嵌于验签（`token.ts:80`）。若丢掉 soc 形状闸，**签名合法但缺 claim 且已过期**的票从 `signature_invalid` 翻 `token_expired`（两者皆 403；无 fixture 覆盖；现实不可达——缺 claim 需 HMAC 已破） | reason 微差 | **零差**：soc `unseal+asClaims` 作为形状预闸原样保留（成本：解析器留 soc 侧，裁决权仍全在包）。若 L0 要去重复解析换微差归零的反面，改走 §8-2 变体并钉进契约测试 |
| 2 | **paramsHash 双实现边域**：包对 `undefined/函数/BigInt` 退化为带引号字符串（`token.ts:46`），soc canonicalJson 归 `null`（`verify-ticket.ts:109`）。**JSON 域两实现逐字节一致**（双仓各自有 py 锚点契约测试：`verify-ticket.test.ts:73-86`、`jiaotu/packages/agent-guard/src/token.ts:29-33`） | 仅 JS 原生脏值可达 | 无动作：闸审计帧的 params_hash 仍由 soc 侧 `gated-call.ts:73` 产出；适配层比对用包 hash——工具参数恒为 JSON 域（LLM 输出经 JSON 解析），两 hash 恒等 |
| 3 | **包 `verifyToken` 审批分支不查 tool**（`token.ts:103-109`） | 「错工具+对参数」→ allow（**安全回归**，非仅 reason 翻转） | 适配层审批路径用 `verifyTokenSignature` + 自查 tool（这正是包闸面自己的用法，`guard.ts:236,251-254`——与包同构即安全） |
| 4 | **包的网络行为不随包进来**：createGuard 的 DENIED 事件回传/焚毁查询/同步焚毁/reportExecution（`guard.ts:152-192,262-296,306-323`） | 若接 createGuard：审计双写（包 POST /internal/audit/events + soc 自家 audit）、焚毁顺序翻红线、gate 需要 gatewayUrl 配置 | 不接线，纯函数面零网络——soc-demo 审计仍单口走自家 `audit.ts`/`gated-call`，字节不变 |
| 5 | **未登记工具 reason**：包闸 `scope_insufficient`（`guard.ts:197-201`） vs soc `no_ticket`（默认 L1 无票，`verify-ticket.ts:204`） | reason 翻转（403 皆拒，但 `tools.manifest.json` policy 的 README 明文承诺 no_ticket 口径，`fixtures/tools.manifest.json:5`） | 分级留 soc `tierOf`（红线②），语义不引入 |

---

## 5. 适配层形状（施工蓝图，一页纸版）

```
verifyTicket(toolCall, ctx, nowSec, opts)          ← 公共面冻结（签名/类型/导出名全部照旧）
│ try {
│  ├ key = opts.hmacKey ?? env SOC_HMAC_KEY        ← 照抄 verify-ticket.ts:192-194
│  ├ approvalToken ∈ ctx? ──→ L2 路径              ← 照抄 :196-198 的分派
│  │    p = asApprovalClaims(unseal(key, t))       ← 形状闸留 soc（§4.2-1，9 字段）
│  │    v = verifyTokenSignature(key, t, nowSec)   ← 包出真相：签名+exp（token.ts:50-82）
│  │    v 不 ok → deny(v.reason)                   ← signature_invalid | token_expired
│  │    ctx.used?.has(p.jti) → token_used          ← 照抄 :235（used 先于 tool，保 soc 序）
│  │    p.tool !== tool → scope_insufficient       ← 照抄 :236（安全判据，§4.2-3）
│  │    paramsHash(pkg)(params) !== p.params_hash → params_mismatch   ← 包 hash（token.ts:31）
│  │    ctx.caseId && p.case_id !== ctx.caseId → scope_insufficient   ← 红线①（照抄 :239）
│  ├ ticket ∈ ctx? ──→ L1 路径
│  │    p = asTicketClaims(unseal(key, t))         ← 形状闸留 soc（8 字段）
│  │    v = verifyToken(key, t, {tool, now, isBurned: jti => ctx.used?.has(jti) ?? false})
│  │                                               ← 包出真相：签名→exp→jti→焚毁→allowed_tools（token.ts:91-116，与 soc :218-220 全序等价）
│  │    v 不 ok → deny(v.reason)
│  │    case/run 绑定两查 → scope_insufficient     ← 红线①（照抄 :221-222）
│  └ 无票 ──→ tierOf 控制流                        ← 红线②（照抄 :200-204：L0 allow / L2 require_approval / L1 no_ticket）
│ } catch { return deny("signature_invalid") }     ← INV-1 桶名保 soc（:205-207）
```

- 不用：`createGuard`、`parseToolManifestYaml`、`AUDIT_ACTIONS`、`reportExecution`、`GuardAuditEvent`（全部不接线；`agent_revoked`/`guard_unavailable` 不进适配层词表）。
- 用：`verifyTokenSignature`（`index.ts:27`）、`verifyToken`（`index.ts:27`）、`paramsHash`（`index.ts:25`）。
- `MemoryBurnRegistry`/`BurnRegistry`/`TicketClaims`/`ApprovalClaims`/`VerifyOpts` 原样保留（测试与 rig 直接 import，`verify-ticket.test.ts:9-14`、`ticketing-rig.ts:14`）。
- 独立契约测试（验收第 3 条）：新文件（建议 `verify-ticket.guard-adapter.test.ts`）逐条钉「包真值 → 闸判定」映射：9 fixture 逐张 = 包 `verifyToken` 裸跑结果 ≡ 适配层 verdict；§4.2 各点负例钉死（错工具+对参数、形状+过期、未登记无票、焚毁表炸）。

---

## 6. 不做清单（三红线复述确认）

1. **不做 burn 顺序改动**：闸内不焚、不放行前焚；`HttpTokenBurner` 用后焚链路（`token-ports.ts:136-152`）与 graph 装填读口（`token-ports.ts:96-100`）一字不动。包的同步焚毁（`guard.ts:282-296`）留在不接线的 createGuard 里。
2. **不做分级表换 YAML**：`fixtures/tools.manifest.json` 仍是分级唯一来源，`tierOf` 不动；包的 YAML 解析器（`manifest.ts`）不引入。表源统一属 ADR 0004-2 裁决域，不在本票。
3. **不做 case/run 绑定进包**：`VerifyCtx.caseId/runId` 与三处绑定判定留 soc-demo；不为迁就反向给包加 case/run 参数（jiaotu 票 27「不许为迁就 soc-demo 破坏包自身契约」）。
4. 附：不改 7 值 `DenyReason`、不改 `VerifyResult` 形、不改 `verify-ticket.test.ts` 现有断言（只增适配层契约测试）、不动 docker（本研究连 compose 文件都没碰）。

---

## 7. 工作量与施工拆票建议

| 项 | 内容 | 估量 |
|---|---|---|
| 27 主施工（soc-demo 侧，单票可吞） | ① `services/agent/package.json` 加 link: 依赖 + `pnpm install` 生成 lockfile 条目；② `verify-ticket.ts` 按 §5 蓝图内部换装（公共面冻结，六个消费方零改动）；③ 新增适配层契约测试；④ 全量测试绿只增不减 + typecheck + lint + `pnpm check:boundary` | 0.5–1 人日 |
| docker build-context 修复 | agent 镜像能让 pnpm install 解析 link: 目标（`additional_context` 或 context 上移 + Dockerfile COPY，jiaotu 先例 `jiaotu/services/gateway/Dockerfile:16`）；六幕冒烟双形态要跑就必须修 | ≤0.5 人日；**涉 docker**——并入 27 施工票或拆 27b，L0 定（§8-3） |
| jiaotu 侧 | 默认**零改动**（纯函数面已够）。仅当 L0 选 §8-2 变体 B'（要求包出严格全形状验票导出）才有微票：`token.ts` 加导出，不动既有签名，≤0.5 人日 | 0（默认） |
| 回归面 | 六幕冒烟内部+jiaotu 双形态（后者需 docker + jiaotu gateway 起服）、`tools-manifest.test.ts`、`gated-call.test.ts`、`sse-contract.test.ts`、`guards-contract.test.ts` 全绿 | 含在 27 验收 |

拆票建议：**一票施工（27 本票）+ 可选 27b（docker/context）**。不建议把适配层契约测试拆出去——映射表和换装必须同票落地才可验（分票会出现「旧闸+新测试」的假绿窗口）。

---

## 8. 开放问题（留 L0 拍板）

1. **link: vs file: 拍板 + CI 落点**：推荐 link:（§3.2）。前置：确认父仓库 ci.yml（`check_boundary.py:11` 自述，文件不在两仓内）能否为 soc-demo job 加 agentjiaotu 兄弟 checkout；若 CI 无法保证兄弟路径，link:/file: 都断，需回退到 tarball 方案。
2. **形状闸去留**：推荐保留 soc `unseal+asClaims` 预闸（零微差，§4.2-1）。若嫌双重验签冗余，接受「形状坏+已过期 → token_expired」微差并钉进契约测试——安全上无差（皆 403 fail-closed），只是 reason 词面。
3. **docker build-context 归属**：修在 27 本票内还是拆 27b？六幕冒烟双形态依赖它，验收第 1 条隐含需要。
4. **「真依赖」口径**：验收第 2 条按「package.json 依赖 + lockfile 在案」字面达成（推荐）；包的网络缝（burned/burn/audit-events）与 `reportExecution` 是否要在狗粮后续票接线，属 jiaotu 狗粮路线图，不在 27。
5. **包发布远期路线**：`private:true + version 0.0.0 + main:src/index.ts` 的包将来真发布需要 build/版本策略——jiaotu 侧独立议题，不挡 27；届时 soc-demo 从 link: 切版本号依赖即可，适配层零改动。


---

## L0 裁决记录（2026-09-14，主窗口过目拍板）

- **①依赖机制：link: 协议采纳**——CI 影响的对处置：根仓 `.github/workflows/ci.yml` 增一步 agentjiaotu checkout（其 origin 在案，可克隆；步序在 soc-demo 测试之前），随本票施工一并落。
- **②soc 形状闸：保留**（照推荐，零微差）。
- **③docker build-context 修复：归本票**（compose agent 构建上下文需含 link: 目标，照 jiaotu gateway Dockerfile COPY 先例最小修）。
- **④"真依赖"验收口径：lockfile 在案 + 生产闸真调用包 verifyToken/verifyTokenSignature/paramsHash**（依赖躺着不算数）。
- **⑤包发布远期路线：仅记注**（private:true 现状；真发布是 M3+ 议题）。
- **安全注记**：包 verifyToken 审批分支不查 tool——适配层必须自查 tool（否则「错工具+对参数」从 scope_insufficient 变 allow），写进施工验收断言。
