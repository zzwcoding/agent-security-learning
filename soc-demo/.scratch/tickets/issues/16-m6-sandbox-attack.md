# 16: m6 沙箱真跑 + 第四攻击面

**What to build:** microsandbox 接入：至少一个 analyzer 在一次性 microVM 里真跑；投毒 analyzer 攻击 fixture（外联 C2 / 读宿主 env）被拦 + DENIED 审计。路线 2 攻击验收迁移至此。

**Blocked by:** 15

**Touches modules:** `m6`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 至少一个 analyzer 在一次性 microVM 真跑（源：m6 卡依赖·PRD v1.1 变更 3）
- [x] attack/sandbox/01_poisoned_analyzer：外联 C2 被 egress 拦截（源：m6 卡测试计划）
- [x] 读宿主 env：VM 内凭证不可见（源：m6 卡测试计划·路线 2 迁移）
- [x] VM 一次性：跑完即毁无状态残留（源：modules.md §2 microsandbox 条目）

## 实现记录（2026-09-09）

落点：`services/agent/workers/enrichment/sandbox.ts`（MsbAnalyzerBackend——AnalyzerBackend seam 的 microsandbox 真跑侧，票 15 的 FixtureAnalyzerTable 仍是默认，演示攻击面经 `EnrichmentDeps.analyzers` 换实现即切，flow 零改动）、`vm-analyzers/vt_lookup.py`（Cortex 形态可执行 analyzer，真跑件）、`fixtures/attack/sandbox/01_poisoned_analyzer/{analyzer.py,scenario.json}`（第四攻击面实体载荷 + 场景清单）。

- 真跑形状（验收 1）：每次 lookup `msb run python:3.12` 拉一台一次性 microVM（本机 libkrun，非常驻服务），analyzer 脚本 `--copy` 成 VM 内 /srv/analyzer.py、情报表 `--copy-dir` 只读挂成 /srv/ti，脚本真执行、真吐 Cortex 返回契约（marker 行 `<<ANALYZER_RESULT>>{result,attempts}`）；EICAR hash 真跑结果与 fixture 情报表同源（malicious 5/70 + artifacts）。
- egress 拦截（验收 2）：`--no-net`（宿主侧网络栈双向 deny），投毒 analyzer 的 C2（198.51.100.23:4444）connect_ex 立即 errno=111；审计 `sandbox_egress_blocked`（DENIED）。测试另派我方探针进同策略 VM 独立复测——断言不依赖投毒脚本自白，`blocked:false` 记 `sandbox_egress_breach`（FAILURE）而非拦截（审计不说谎）。
- env 不可见（验收 3）：microVM 不继承宿主 env——金丝雀挂 msb 宿主进程 env 上，VM 内 grep 不到（INV-4 同款）；投毒件全量 env 键名回传 + 直读 /root/.aws/credentials 均无获；审计 `sandbox_env_denied`（DENIED）。
- 一次性（验收 4）：`msb run` 跑完会留 stopped 沙箱——backend 在 finally 里 `msb remove -f`，失败路径也拆，remove 失败记 `sandbox_remove_failed`（FAILURE）；真跑断言 list 无沙箱 + 新 VM 看不到上一台的 /tmp/pwned。
- fail-closed（INV-1）：VM 崩溃 / 无 marker / 非 JSON / 形状不符 / 脚本缺失（ip_reputation 未提供真跑件）一律 success:false + `sandbox_run_failed` FAILURE 审计，且照常 remove 不留残留。
- 测试分层（`sandbox.test.ts`，14 条）：mock 侧 11 条（buildMsbArgs 拓扑断言——`--no-net` 在场、无 `-e/--env`、具名+超时+标签；fake runner 注入的 fail-closed/DENIED 行为面；攻击 fixture 完整性）CI 全绿；真跑侧 3 条走能力探测（msbProbe：CLI 不在或 microVM 冒烟失败 → describe.skipIf + 打印原因，绝不静默）。CI（无 KVM）：11 passed | 3 skipped；本地真跑冒烟全过（msb 0.6.16 local backend，单台 VM 拉起约 0.3-0.5s）。

### 出入与偏差记录（不改 spec 本体）

1. **msb 用户态网络栈假握手**：无 `--no-net` 的 VM 里对不可路由地址 connect_ex 会**立即 errno=0**（连接「成功」，真实外联并未发生）——演示/断言一律用「被拦方向」（errno≠0）作证据，并用对照实验（去掉旗标 errno 变 0）证明拦截真来自 `--no-net` 旗标而非目标不可达。modules.md §2 microsandbox 条目不受影响，属运行时行为新知。
2. **「一次性」不是自动即毁**：`msb run` 跑完留 stopped 沙箱（可再 start）；「跑完即毁」由 backend finally 显式 `msb remove -f` 实现——modules.md §2「按需拉起一次性 microVM」的语义落在 adapter 的生命周期管理上。
3. **情报源以只读挂载进 VM 而非 HTTP**：真跑 = analyzer 脚本真执行；fixtures/ti 以 `--copy-dir` 只读挂成 /srv/ti。egress 全关是攻击面的前提，正常 analyzer 也据此设计成无需外联（「能干活」与「能外联」在沙箱里是两件事）。PRD v1.1 变更 3 的「按 Cortex 真实架构以可执行脚本形态存在」已满足，数据面取挂载形态。
4. **ip_reputation 无真跑件**：票面下限「至少一个」，vt_lookup 真跑；ip_reputation 走 fail-closed（script_missing 拒绝 + FAILURE 审计），不静默降级成 mock。
5. **具名场景落位**：`attack/sandbox/01_poisoned_analyzer` 按 injection fixtures 惯例落 `fixtures/attack/sandbox/01_poisoned_analyzer/`（载荷 + scenario.json 清单）；evals/ 具名 fixture 属 m11。
