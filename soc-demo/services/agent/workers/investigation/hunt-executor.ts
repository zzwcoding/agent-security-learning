// m5 调查 worker · hunt_task 真执行体接线（票 79③''·L0 裁定①）。
//
// 78 的遗留尾巴收口：机制目录（src/orchestration/）零改动——task-flow 的 execute 节点
// 还是最小桩（canned 观察），真件在装配层经注册表缝注入：run-kinds.ts 的 hunt_task 图
// 工厂拿机制图（makeHuntTaskFlow 公开接口）后调本件 wireHuntTaskExecutor，把 execute
// 节点从桩换成真执行半边。注入什么（index.ts 装配）：
//   · m5 plan/decide 的执行半边——dispatch 交付的唯一任务即唯一取证步（签名契约 →
//     验票闸 → 执行 → 观察），plan 半边由机制 task-flow 的 plan 节点原样承担；
//   · 78 的 executeHuntTool 门（四狩猎维度查询，FixtureSiem 数据源 seam）；
//   · 79 的 weknora 三工具（剧本/图谱只读 + hypothesis_register L1 写）。
// 缺省（不注入）= 机制桩原样——73 的机制测试、INV-11 rig、预算/取消测试零回归。
//
// 安全语义（与 m5 调查循环同款，不靠 prompt 品格）：
//   · 每个工具调用先过签名契约（validateHuntToolCall/validateWeknoraToolCall）再过
//     验票闸（makeGatedCall 唯一入口；子票 = dispatch 铸的 narrow-scope 单工具票）。
//     契约违约不执行（fail-closed 上抛 = 子 run failed 可观察）；闸拒 = 审计 DENIED +
//     抛错强杀（INV-1 不吞错）。
//   · L2 物理不存在：真执行体只封 L0 查询与 L1 register（INV-3，票面语义见 L0 裁定②）。
//   · 节点包装层的取消检查（T10）在换件时原样保留——execute 节点的前置检查照
//     task-flow 包装层口径重放，父链取消后本步不开新取证工作量。
import { makeGatedCall } from "../../src/gated-call.js";
import { paramsHash } from "../../src/verify-ticket.js";
import { throwIfCancelled, type CancelBoard } from "../../src/orchestration/cancel.js";
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import type { AuditSink } from "../../src/audit.js";
import type { PlannedTask } from "../../src/orchestration/ports.js";
import {
  HUNT_QUERY_TOOLS,
  executeHuntTool,
  validateHuntToolCall,
} from "./hunt.js";
import type { HuntQueryBackend } from "./siem.js";
import {
  WEKNORA_TOOLS,
  executeWeknoraTool,
  validateWeknoraToolCall,
  type WeknoraGraphBackend,
  type WeknoraPlaybookBackend,
} from "./weknora.js";

const ACTOR = { type: "agent", id: "agent:hunt_task" } as const;

/** 真执行体的装配面（index.ts 供给；RunKindGraphDeps.huntExecutor 的形状）。 */
export interface HuntExecutorDeps {
  /** 78 四狩猎维度查询的数据源 seam（生产 = FixtureSiem，测试注入 fake）。 */
  siem: HuntQueryBackend;
  /** 79 weknora 剧本库 / 关系图 stub（票 83 换 HTTP 不换本件）。 */
  playbook: WeknoraPlaybookBackend;
  graph: WeknoraGraphBackend;
  audit: AuditSink;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
}

/** 工具执行分发（executeHuntTool/executeWeknoraTool 之上的唯一入口）：
 *  签名契约先行（违约不执行、不烧后端——fail-closed 上抛交 runner 强杀），面外工具
 *  直接炸响（unreachable，绝不静默吞）。 */
export async function executeHuntPackTool(
  deps: Pick<HuntExecutorDeps, "siem" | "playbook" | "graph">,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if ((HUNT_QUERY_TOOLS as readonly string[]).includes(tool)) {
    const sig = validateHuntToolCall(tool, params);
    if (!sig.ok) throw new Error(`hunt_tool_signature:${sig.error}`);
    return executeHuntTool(deps.siem, tool, params);
  }
  if ((WEKNORA_TOOLS as readonly string[]).includes(tool)) {
    const sig = validateWeknoraToolCall(tool, params);
    if (!sig.ok) throw new Error(`hunt_tool_signature:${sig.error}`);
    return executeWeknoraTool(deps.playbook, deps.graph, tool, params);
  }
  throw new Error(`unreachable_tool:${tool}`);
}

/** 观察摘要（judge 引用痕的可读面；确定性格式——fake judge 的 hit/miss 判据吃它）：
 *  查询类 = `${tool} total=N hits=M`；register = proposal 痕。 */
export function summarizeHuntObservation(tool: string, payload: unknown): string {
  if (tool === "hypothesis_register" && typeof payload === "object" && payload !== null) {
    const r = payload as { hypothesis_id?: unknown; status?: unknown };
    return `hypothesis_register proposal=${String(r.hypothesis_id ?? "")} status=${String(r.status ?? "proposed")}`;
  }
  if (typeof payload === "object" && payload !== null && "total" in (payload as Record<string, unknown>)) {
    const p = payload as { total?: unknown; hits?: unknown };
    const hits = Array.isArray(p.hits) ? p.hits.length : 0;
    return `${tool} total=${Number(p.total ?? 0)} hits=${hits}`;
  }
  return `${tool} ok`;
}

/** 计费（真用量：观察序列化体积的粗粒度 token 代理——stub 的 ctx.charge(8) 占位退役）。 */
function chargeFor(payload: unknown): number {
  const len = JSON.stringify(payload ?? null)?.length ?? 2;
  return Math.max(1, Math.ceil(len / 4));
}

export interface HuntExecutorWiring extends HuntExecutorDeps {
  runId: string;
  /** dispatch 铸的 narrow-scope 子票（makeGraph 的第二参——装配层唯一持票点，R11）。 */
  ticket: string;
  /** 机制取消信号板（T10：execute 节点前置检查，与 task-flow 包装层同口径）。 */
  cancelBoard?: CancelBoard;
}

/** 把机制 hunt_task 图的 execute 节点从桩换成真执行半边（装配层换件，机制目录零改动）。
 *  其余节点（intake/plan/report 及它们的取消包装）原样保留——observation/params_hash
 *  的交接态契约与 report 节点消费形状逐字节对齐（result_summary = summarizeHuntObservation）。 */
export function wireHuntTaskExecutor(nodes: FlowNode[], wiring: HuntExecutorWiring): FlowNode[] {
  const record = (entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  }): void => {
    wiring.audit.record({ ...entry, actor: ACTOR, requestId: `hunt_${wiring.runId}`, createdAt: Date.now() });
  };

  // 验票闸（票 43 共享闸体）：creds = 子 run 的 narrow-scope 票——闸拒 = 审计 DENIED +
  // 抛错（`${prefix}_gate_denied:${reason}`，runner 强杀路径收口，INV-1 不吞错）。
  const gated = makeGatedCall({
    prefix: "hunt_task",
    hmacKey: wiring.hmacKey,
    creds: () => ({ ticket: wiring.ticket, runId: wiring.runId }),
    deny: () => ({
      record,
      objectId: wiring.runId,
      objectType: "tool_call",
      extraDetails: { node: "execute" },
    }),
    emitToolCall: (ctx, { tool, paramsHash: hash }) =>
      ctx.emit("tool_call", { node: "execute", tool, params_hash: hash }),
    emitToolResult: (ctx, { tool }) => ctx.emit("tool_result", { node: "execute", tool, ok: true }),
  });

  return nodes.map((node) => {
    if (node.name !== "execute") return node;
    return {
      name: node.name,
      run: async (ctx: NodeCtx) => {
        // T10：节点前置取消检查（与机制包装层同口径——换件不丢停止链）
        throwIfCancelled(wiring.cancelBoard, typeof ctx.state.case_id === "string" ? ctx.state.case_id : "");
        const task = ctx.state.task as PlannedTask;
        const hash = paramsHash(task.params);
        const payload = await gated(ctx, task.tool, task.params, () =>
          executeHuntPackTool(wiring, task.tool, task.params),
        );
        ctx.charge(chargeFor(payload));
        const summary = summarizeHuntObservation(task.tool, payload);
        ctx.state.observation = { ok: true, summary, params_hash: hash };
        ctx.state.params_hash = hash;
      },
    };
  });
}
