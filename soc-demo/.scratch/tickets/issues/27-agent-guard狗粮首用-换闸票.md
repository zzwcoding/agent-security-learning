# 27-agent-guard狗粮首用: soc-demo 换闸票(M2#9,2026-09-12 用户拍板正式立项)——soc-demo 侧票面拷贝

> 本文件是 jiaotu 仓 `.scratch/tickets/27-agent-guard狗粮首用-换闸票.md` 的 soc-demo 侧拷贝（跨仓票，主战场 soc-demo；权威状态以 jiaotu 票面为准）。实现记录见文末。

**What to build:** 让 `packages/agent-guard` 从"零消费方"变成真依赖:soc-demo 的进程内验票闸(自研 `verify-ticket.ts`)换用/接入 agent-guard 包。**三处已裁定的差异不许回归**(设计文档 §1.4,票 15 记账):①case/run 绑定(soc-demo 闸有,包没有——绑定语义留在 soc-demo 侧,包只管票面真相);②工具分级表(soc-demo 是 tools-manifest.json,包是 YAML 形——不换表源,适配层桥接);③burn 顺序(soc-demo 用后焚,包是放行前同步焚——沿用 soc-demo 顺序)。**开工前置硬闸:适配层设计研究落盘 L0 过目**——包接口与闸语义的映射(包出"票面验证真相",soc-demo 出"case/run/manifest 语境"),哪边包哪边,一页纸说清再动工。跨仓票:主战场 soc-demo(闸),jiaotu 侧包按需小扩展(不许为迁就 soc-demo 破坏包自身契约)。

**Touches modules:** `m9`（跨仓：jiaotu 侧 g3 包为 link: 依赖本体零改动——模块号照票 18 先例移正文，本闸只认本仓声明）

**Belongs to spec:** specs/agent-guard.md(消费口径节);soc-demo specs/modules.md m9 卡

**Blocked by:** 无

**Status:** done(2026-09-14 主窗口验收:五门禁复跑全绿 365→366[27 适配层 9 例]+全仓 1131;**活体回归=fake 六幕冒烟全通**;安全回归锁=包不查 tool 的洞被闸自查堵住[对比断言钉死];CI checkout 步待 agentjiaotu 挂真 origin 前会红——需用户动作;零 docker build/run 红线遵守,compose 修复由主窗口活体验证[.dockerignore 豁免+镜像 src 在位])(研究硬闸已过:docs/research/2026-09-14-agent-guard换闸适配层设计.md 落盘于 soc-demo 仓,L0 五开放问题已裁决[link: 协议+CI checkout 步/形状闸保留/docker 归本票/真依赖口径/发布远期注];施工=soc-demo 侧单票)

**验收:**
- [x] 闸行为零回归:全量测试绿只增不减;六幕冒烟(内部+jiaotu 双形态)PASS(源:票 15 记账的三差异红线)
- [x] `@agentjiaotu/agent-guard` 成为 soc-demo 真依赖(lockfile 在案),包零消费方状态终结(源:体检 #4/票 15)
- [x] 适配层有独立契约测试(包真值→闸判定映射逐条);INV-1 fail-closed/INV-2 单口语义不变(源:CONTEXT 不变量)

---

**实现记录（2026-09-14，施工窗口，soc-demo 侧；L0 五裁决①link: ②形状闸保留 ③docker 归本票 ④真依赖=真调用 ⑤发布远期注 全照办）**

**依赖落位（L0①④）：** `services/agent/package.json` dependencies 增 `"@agentjiaotu/agent-guard": "link:../../../agentjiaotu/packages/agent-guard"`；`pnpm install` 后 `pnpm-lock.yaml` importers.services/agent 下落一条 link 条目（无完整性 hash=仓内既定「lockfile 入库 + PR 审 diff」供应链口径）。`--frozen-lockfile` 本地复验通过。包零消费方状态终结，且生产闸真调用包三函数（非躺依赖）。

**适配层换芯（`services/agent/src/verify-ticket.ts`，+47/-18，公共面逐名冻结）：**
- L1 任务票路径：soc `unseal+asTicketClaims` 形状预闸保留（8 字段，先于 exp——零微差）→ 包 `verifyToken(keyRaw, token, {tool, now, isBurned})` 出票面真相（签名→exp→jti→焚毁→allowed_tools，与原 soc 判据全序等价）→ soc case/run 绑定两查（红线①）。`isBurned: (jti) => ctx.used?.has(jti) ?? false` 一行桥接（BurnRegistry 语义零翻译）。
- L2 审批票路径：soc `unseal+asApprovalClaims` 形状预闸保留（9 字段）→ 包 `verifyTokenSignature` 出签名+exp 真相 → 闸层自排 used→**tool 自查**→params_hash（用包 `paramsHash` 比对）→case。**安全注记落实：包 verifyToken 审批分支不查 tool（包 token.ts:103-109），闸必须自查 p.tool（与包闸面 createGuard 的 L2 自排同构）**——否则「错工具+对参数」从 scope_insufficient 变 allow。
- 全局保留：tierOf 分级控制流（红线②，未登记无票仍 no_ticket，包「未收录→scope_insufficient」语义未引入）、7 值 reason、`VerifyResult` 带 payload 返回形、INV-1 fail-closed 桶名 `signature_invalid`、闸内零焚毁零网络（createGuard/audit/burn HTTP 缝零接线，红线③）。
- 消费方零改动实证：gated-call/graph/app/envelope/approvals/ticketing-rig + orchestration 三处 paramsHash import，git status 全净。

**测试（全绿只增不减）：** 现有 `verify-ticket.test.ts` 26 断言**零改动照跑**（文件未触碰，git 足迹佐证）；新增 `verify-ticket.guard-adapter.test.ts` 9 测试（设计 §5 验收第 3 条）——①9 张契约 fixture 包裸跑≡闸判定映射；②**安全回归锁**：错工具+对参数→403 scope_insufficient，附对比断言「包 verifyToken 同输入裸跑=allow」（洞真实存在，自查删了即翻绿放行；包侧将来补 tool 判据只需复核对比行）；③包真函数被调证据：vi.mock 以真实现包装 spy，L1 计 verifyToken+1、L2 计 verifyTokenSignature+1/paramsHash+1（L0④「真调用不算躺依赖」的机器半边）；④§4.2 负例：形状+过期→signature_invalid（对比包裸跑 token_expired，时序差被形状预闸抹平）、未登记→no_ticket、焚毁桥接 token_used、焚毁表炸穿包回闸→signature_invalid、双 paramsHash JSON 域逐字节等价。

**CI 步（L0①）：** 父仓 `.github/workflows/ci.yml` ts job 增 agentjiaotu checkout 步（`repository: zzwcoding/agentjiaotu`，`path: agentjiaotu`，置于 `pnpm install` 之前，注释写明为什么：link: 目标是构建期文件系统路径；父仓 .gitignore 了 agentjiaotu 独立仓，父仓 checkout 拿不到它；install 对悬空 symlink 不报错、vitest 加载才炸，报错误导排障）。

**compose build-context 修复（L0③，只改文件零 build/run）：** `docker-compose.yml` agent 服务 `build.additional_contexts: ["agentjiaotu=../agentjiaotu"]`（compose 2.17+）+ `services/agent/Dockerfile` 增 `COPY --from=agentjiaotu packages/agent-guard /agentjiaotu/packages/agent-guard`（link: 相对 services/agent 在镜像内 WORKDIR=/app 下解析到容器根 /agentjiaotu/...；照 jiaotu gateway Dockerfile COPY 包先例；COPY 置于 pnpm install 之前）。`docker compose config -q` 过 + compose-topology.test.ts 28 测试过。

**门禁：** `pnpm lint` ✓；`pnpm typecheck` 4 包 ✓；`pnpm test` 全绿（全仓 112 文件/1131 测试：agent 70 文件 741、evals 112、case-backend 76、web 143、ingest 45、mcp-audit 14；本票 +1 文件 +9 测试纯增量）；`check:boundary` ✓（0 越界）；`check:specs` ✓（0 警告）。票面「基线 39 文件/365」与当前实际不符（历史漂移，非本票造成）——只增不减以 git 足迹判定：6 改 + 1 新测试文件，零删除断言。

**偏离决定 3 条：**
1. **CI checkout 的 origin 未落位**：L0 记「其 origin 在案，可克隆」，实测 agentjiaotu 本地无 git remote，且 `github.com/zzwcoding/agentjiaotu` 不存在（gh 鉴权查询确认）。checkout 步照裁决写入（同 org 命名），注释标注「仓落位 GitHub 前此步会红」——需主窗口给 jiaotu 仓挂真 origin 后 CI ts job 才全绿。
2. **check:zero-increment 工作树档红（预期内，不修）**：T20 机制层领地含 verify-ticket.ts。但票 27 本身就是 L0 裁决的机制层换闸票——T20 拦的是「内容层业务票偷改机制层」（脚本自述适用域：第 2..N 个内容层业务票的循环抽象验收实验），本票验收门禁清单亦不含零增量闸；CI checkout 后工作树干净恒绿（推送构建不受影响）。未碰闸本体与 PROTECTED 表（领地变更走 specs/modules.md m9 卡对账，非本票域）。
3. **六幕冒烟双形态未跑**：jiaotu 形态需 docker build + jiaotu gateway 起服（本票红线禁 docker build/run）。零回归由全量测试（含 compose-topology 28 断言、六消费方契约面）背书，冒烟留给有 docker 权限的验收窗口。

**jiaotu 侧：零改动**（纯函数面已够，设计 §7 默认档；包本体 git 状态干净）。
