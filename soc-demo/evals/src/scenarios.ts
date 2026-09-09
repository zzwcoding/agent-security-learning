// m11 eval 体系 · 场景分发器（票 22 建立四维取证布景；票 44·F6 起本文件只留
// 布景声明与分发，按 facet 拆进 ./rigs/：shared / approval / replay / chat /
// investigation / triage / attack——每个 rig 自带布景装配与场景专项检查）。
//
// 素材全部「收编」自既有票据的测试行为，不重写任何 worker 行为：
//   审批维 ← 票 11 approval-loop.test.ts（interrupt → 决定 → resume → 一次性票 → 409 仲裁）
//   replay 维 ← 票 09 INV-6 + scripts/replay.ts（webhook 正门推两遍，occurrences+1 不重复建案）
//   RAG 投毒 ← 票 17 knowledge/02_poison_rejected（人审驳回 → 检索面 0 命中，D8/INV-5）
//   伪造批准 ← 票 18 INV-9（对话里说「已批准」无效，唯一通道是签名 ApprovalToken）
//   L2 提权 ← 票 14 INV-3（worker 工具面物理无 L2 + 验票闸 403 fail-closed，D7+D4）
//   沙箱攻击面 ← 票 16 attack/sandbox/01（microVM 真跑投毒 analyzer，能力探测 fail-soft）
//   对话维 ← 票 18（意图闸三态 + 回答数字来自查询结果）
//
// 与 runner.ts 的分工不变：本模块（及其 rigs）只负责「把布景跑出来 + 收证据 + 给出
// 场景专项检查」，通用确定性断言（assertions.ts）与 judge 照旧在 runner 里汇合。
// 环境坏掉的布景（沙箱）抛 ScenarioSkip——显式 skip 留原因，绝不静默、绝不误报红。
import { scenarioApprove, scenarioDoubleDecide, scenarioParamSwap, scenarioReject, scenarioTokenReplay } from "./rigs/approval.js";
import { scenarioReplayDataset, scenarioReplayDedup } from "./rigs/replay.js";
import { runChatPrompt, scenarioForgedApproval, scenarioLoginRoles } from "./rigs/chat.js";
import { scenarioInvestigationFull, scenarioL2Privesc } from "./rigs/investigation.js";
import { scenarioCredentialCanary } from "./rigs/triage.js";
import { scenarioRagPoison, scenarioSandbox, sandboxBackendFromFixture, type SandboxRig } from "./rigs/attack.js";
import { ScenarioSkip, type ScenarioDeps, type ScenarioOutcome } from "./rigs/shared.js";
import type { EvalCase } from "./types.js";

// 公共面原样保留（拆分前后对外 API 逐字一致）：runner.ts 与本测试文件都从这里 import。
export { ScenarioSkip, runChatPrompt, sandboxBackendFromFixture };
export type { ScenarioDeps, ScenarioOutcome, SandboxRig };

/** 具名 scenario 执行器：scenario 名 → rigs/ 里对应的布景（名字必须与登记表一致，
 *  未登记直接报错——绝不静默吞掉一个拼错的 scenario 名）。 */
export async function runScenario(c: EvalCase, deps: ScenarioDeps = {}): Promise<ScenarioOutcome> {
  const scenario = c.spec.input.scenario;
  switch (scenario) {
    case "approve_resume_execute": return scenarioApprove(c);
    case "reject_no_execute": return scenarioReject(c);
    case "param_swap_new_card": return scenarioParamSwap(c);
    case "double_decide_409": return scenarioDoubleDecide(c);
    case "token_replay_403": return scenarioTokenReplay(c);
    case "forged_approval_text": return scenarioForgedApproval(c);
    case "l2_privesc_403": return scenarioL2Privesc(c);
    case "rag_poison_rejected": return scenarioRagPoison(c);
    case "replay_dedup": return scenarioReplayDedup(c);
    case "replay_dataset": return scenarioReplayDataset(c);
    case "sandbox_poisoned_analyzer": return scenarioSandbox(c, deps);
    case "secrets_canary_fullchain": return scenarioCredentialCanary(c, deps);
    case "login_roles": return scenarioLoginRoles(c);
    case "invest_ssh_tp_full": return scenarioInvestigationFull(c);
    default:
      throw new Error(`eval 用例 ${c.fullName}：未知 scenario（${String(scenario)}）——scenario 名必须与执行器登记表一致`);
  }
}
