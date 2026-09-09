// m5 调查 worker · 关联调查子图（票 14）。
//
// PRD §6-M5 子图：plan(任务清单) → loop{tool_call → observe → 上下文治理}
// → report_llm → write_timeline。作为 FlowNode[] 挂进 m3 的 runner（graph.ts），
// 盖章/审计/信封链由 runner 管，这里只管「调查这件事本身」。子图输入
// {case_id, ticket}（m5 卡公开接口）= 本工厂的 deps.caseId / deps.ticket。
//
// 三条缰绳（都在本文件落地，与 m3 runner 的三闸互补）：
//   1. max_steps=20（决策 #5）：管的是**工具循环步数**（HolmesGPT ToolCallingLLM.call()
//      范式——每次「LLM 裁决 + 可能的工具执行」算一步），不是图节点数。用尽 → 循环
//      截断 → 照常出报告并标注「调查不完整」（PRD 异常与边界），不是 run 强杀。
//      m3 runner 的 budget.step() 继续管节点级兜底，token 由 ctx.charge 管——双保险。
//   2. 防打转：同参数重复调用（paramsHash 指纹相同）直接返回错误观察，不再执行
//      （HolmesGPT prevent_overly_repeated_tool_call）。
//   3. 上下文治理（FR-M5.5）：工具输出 >10000 字符 → llm_summarize 小模型摘要；
//      >50000 字符 → 落盘 workspace/spill/ 只给引用；查询类工具强制 time_window
//      （在 prompt.ts 契约里，从源头不给「查全库」的选项）。
//
// 安全语义（照票 13 的结构，不靠 prompt 品格）：
//   - 每个工具调用先过 validateToolCall（签名契约）再过 verifyTicket（gated 唯一
//     入口，票面 scope 无 L2，INV-1/INV-3）；闸拒 = 审计 DENIED + 抛错强杀。
//   - 工具输出进上下文前过 guards tool_output 通道（票 36 接通 G2-6；票 04 策略 =
//     flag 打标不拦），打标进观察元数据 + 审计。
//   - worker 没有 awaitApproval/executeApproved——调查报告的 recommended_actions
//     只是建议，「只提建议不动手」落在结构上：isolate_host 永远到不了执行层。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import { paramsHash } from "../../src/verify-ticket.js";
import { makeGatedCall } from "../../src/gated-call.js";
import type { AuditSink } from "../../src/audit.js";
import type { ScanChannel, ScanDecision } from "../../src/guards-client.js";
import { buildDecidePrompt, buildPlanPrompt, buildReportPrompt, validateToolCall, type CaseView, type ObsEntry, type PlanCall, type ReportCall, type SummarizeCall } from "./prompt.js";
import { parseReport, renderReportMarkdown } from "./schema.js";
import type { InvestigationLlm } from "./llm.js";
import { relatedAlerts, type InvestigationM2 } from "./m2.js";
import type { SiemBackend } from "./siem.js";
import type { KbHit } from "../triage/prompt.js";
import type { KbLookupParams, TriageKb } from "../triage/kb.js";

/** 决策记录 #5：M5 max_steps = 20。env MAX_STEPS 可覆盖（与 m3 budget 同一口径）。 */
export const LOOP_MAX_STEPS = 20;

// 上下文治理阈值（PRD §6-M5 / 环境变量表：LLM_SUMMARIZE_THRESHOLD_CHARS=10000、
// SPILL_THRESHOLD_CHARS=50000）
const DEFAULT_SUMMARIZE_THRESHOLD = 10_000;
const DEFAULT_SPILL_THRESHOLD = 50_000;

const ACTOR = { type: "agent", id: "agent:investigation" } as const;

const numEnv = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : undefined;
};

export interface InvestigationDeps {
  runId: string;
  requestId: string;
  /** 子图输入：案件 id（m5 卡公开接口 {case_id, ticket}）。 */
  caseId: string;
  /** L1 任务票 wire 串（m3 拉起 worker 时经 gateway 铸出，allowed_tools=INVESTIGATION_TOOLS）。 */
  ticket: string;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
  m2: InvestigationM2;
  siem: SiemBackend;
  /** m7 检索面（kb_lookup 共用件，票 13 的 MemoryKb / 票 17 chroma）。 */
  kb: TriageKb;
  llm: InvestigationLlm;
  /** guards 扫描口（票 36·G2-6：工具输出的 tool_output 通道扫描；票 04 策略 = flag
   *  打标不拦。生产 = scanInjection，测试 = fakeScan——enrichment 同款必填 seam）。 */
  scan: (text: string, channel: ScanChannel) => Promise<ScanDecision>;
  audit: AuditSink;
  /** spill 落盘根目录（默认 workspace/spill，PRD §6-M5；测试注入 tmpdir）。 */
  spillDir?: string;
  /** 缰绳口径覆写（缺省读 env / 默认 20，见各默认值）。 */
  maxSteps?: number;
  summarizeThresholdChars?: number;
  spillThresholdChars?: number;
}

interface LoopState {
  stepsUsed: number;
  maxSteps: number;
  finished: boolean;
  incomplete: boolean;
  executed: string[];
  observations: ObsEntry[];
}

interface ReportState {
  body: string;
  structured: Record<string, unknown> | null;
  degraded: boolean;
  incomplete: boolean;
}

export function makeInvestigationFlow(deps: InvestigationDeps): FlowNode[] {
  const record = (entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  }): void => {
    deps.audit.record({ ...entry, actor: ACTOR, requestId: deps.requestId, createdAt: Date.now() });
  };

  /** 工具调用唯一入口：广播 tool_call → verifyTicket（L1 任务票）→ 放行执行 →
   *  tool_result。闸拒 = 审计 DENIED + 抛错（runner 强杀 run；INV-1 不吞错）。
   *  票 43：闸体收进共享 makeGatedCall（差异点只有前缀/凭据/审计落点三个声明）。 */
  const cursor = { node: "" };
  const gated = makeGatedCall({
    prefix: "investigation",
    hmacKey: deps.hmacKey,
    creds: () => ({ ticket: deps.ticket, runId: deps.runId }),
    deny: () => ({
      record,
      objectId: deps.runId,
      objectType: "tool_call",
      extraDetails: { node: cursor.node },
    }),
    emitToolCall: (ctx, { tool, paramsHash: hash }) =>
      ctx.emit("tool_call", { node: cursor.node, tool, params_hash: hash }),
    emitToolResult: (ctx, { tool }) => ctx.emit("tool_result", { node: cursor.node, tool, ok: true }),
  });

  // ---- 案件视图（load_case 的产出，plan/decide/report 的共同输入） ----

  const caseViewOf = (detail: {
    id: string; title: string; severity: number; status: string;
    observables?: { dataType: string; data: string }[];
  }, primaryAlertDate: number): CaseView => {
    const obs = detail.observables ?? [];
    const byType = (t: string): string[] => obs.filter((o) => o.dataType === t).map((o) => o.data);
    return {
      caseId: detail.id,
      title: detail.title,
      severity: detail.severity,
      status: detail.status,
      entities: {
        ips: byType("ip"),
        users: byType("other"), // seed 映射口径：srcuser → dataType "other"
        hosts: byType("hostname"),
        files: byType("filename"),
      },
      primaryAlertDate,
    };
  };

  // ---- 工具执行体（签名与闸都过了才轮到这里） ----

  async function execTool(tool: string, params: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case "get_alert":
        return deps.m2.getAlert(String(params.alert_id));
      case "siem_query":
        return deps.siem.query({
          entity_type: params.entity_type as "ip" | "user" | "host",
          entity: String(params.entity),
          time_window: params.time_window as { from: string; to: string },
          max_results: typeof params.max_results === "number" ? params.max_results : undefined,
        });
      case "related_alerts":
        return relatedAlerts(deps.m2, {
          scope: params.scope as "entity" | "rule" | "host",
          value: String(params.value),
          time_window: params.time_window as { from: string; to: string },
          max_results: typeof params.max_results === "number" ? params.max_results : undefined,
        });
      case "kb_verify": {
        const lookup: KbLookupParams = {
          host: typeof params.host === "string" && params.host ? params.host : undefined,
          path: typeof params.path === "string" && params.path ? params.path : undefined,
          user: typeof params.user === "string" && params.user ? params.user : undefined,
        };
        const hits: KbHit[] = await deps.kb.lookup(lookup);
        return { hits };
      }
      case "add_timeline_entry":
        return deps.m2.addTimelineEntry(String(params.case_id), {
          kind: String(params.kind),
          author: ACTOR.id,
          body: String(params.body),
          structured: params.structured,
        });
      case "add_task_log":
        // 票 36 收口（G2-5）：M2 tasks 写口就绪（FR-M2.5 Task log 写口）——声明面与
        // 执行面一致。任务不存在/挂错案按工具报错走「证据缺口并继续」路径。
        return deps.m2.addTaskLog(String(params.case_id), String(params.task_id), {
          author: ACTOR.id,
          body: String(params.body),
        });
      default:
        throw new Error(`unreachable_tool:${tool}`);
    }
  }

  // ---- 上下文治理（缰绳三，FR-M5.5）：原始输出 → 进循环上下文的形态 ----

  let spillSeq = 0;
  const totalOf = (payload: unknown): number | undefined => {
    if (typeof payload === "object" && payload !== null && "total" in (payload as Record<string, unknown>)) {
      const t = (payload as { total: unknown }).total;
      if (typeof t === "number") return t;
    }
    if (typeof payload === "object" && payload !== null && "hits" in (payload as Record<string, unknown>)) {
      const h = (payload as { hits: unknown }).hits;
      if (Array.isArray(h)) return h.length;
    }
    return undefined;
  };

  async function observe(
    ctx: NodeCtx,
    tool: string,
    payload: unknown,
  ): Promise<{ payload: unknown; flagged: boolean }> {
    const text = JSON.stringify(payload) ?? "";
    const spillThreshold = deps.spillThresholdChars ?? numEnv(process.env.SPILL_THRESHOLD_CHARS) ?? DEFAULT_SPILL_THRESHOLD;
    const summarizeThreshold =
      deps.summarizeThresholdChars ?? numEnv(process.env.LLM_SUMMARIZE_THRESHOLD_CHARS) ?? DEFAULT_SUMMARIZE_THRESHOLD;

    // guards 扫描（票 36·G2-6）：工具输出属 tool_output 通道（票 04 策略 = flag）。
    // SIEM/KB/关联告警都是可被污染的数据源——命中注入特征的输出照常进上下文（证据
    // 一个字节不丢），但打标 + 审计留痕待人复核。不拦 ≠ 没看见：flag 在观察元数据和
    // 审计两处同时可查。位置在治理阈值之前——超大/摘要路径的输出同样要被打标。
    let flagged = false;
    const decision = await deps.scan(text, "tool_output");
    if (decision.action === "flag") {
      flagged = true;
      record({
        action: "tool_output_flagged",
        objectId: deps.runId,
        objectType: "tool_output",
        details: { tool, channel: "tool_output", score: decision.score },
        result: "SUCCESS",
      });
      ctx.emit("audit", { action: "tool_output_flagged", tool, channel: "tool_output", score: decision.score });
    }

    if (text.length > spillThreshold) {
      // 超大结果落盘，上下文只留引用（PRD §6-M5 返回形状：{total, truncated, hits_ref}）
      spillSeq += 1;
      const relRef = `spill/${deps.runId}/q${spillSeq}.json`;
      const abs = join(deps.spillDir ?? join(process.cwd(), "workspace", "spill"), deps.runId, `q${spillSeq}.json`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, "utf8");
      record({
        action: "context_spill",
        objectId: deps.runId,
        objectType: "tool_output",
        details: { tool, chars: text.length, hits_ref: relRef },
        result: "SUCCESS",
      });
      ctx.emit("audit", { action: "context_spill", tool, mode: "spill", chars: text.length, hits_ref: relRef });
      return { payload: { total: totalOf(payload), truncated: true, hits_ref: relRef }, flagged };
    }
    if (text.length > summarizeThreshold) {
      // 超阈值 → llm_summarize 小模型摘要（只压上下文，不做决策）
      const call: SummarizeCall = { text, tool };
      const startedAt = Date.now();
      const s = await deps.llm.summarize(call);
      ctx.charge(s.tokens);
      ctx.checkLlm(startedAt, Date.now());
      record({
        action: "context_summarize",
        objectId: deps.runId,
        objectType: "tool_output",
        details: { tool, chars: text.length },
        result: "SUCCESS",
      });
      ctx.emit("audit", { action: "context_summarize", tool, mode: "summarize", chars: text.length });
      return { payload: { total: totalOf(payload), truncated: false, summary: s.summary }, flagged };
    }
    return { payload, flagged };
  }

  // ---- 子图节点（PRD §6-M5）----

  const nodes: FlowNode[] = [
    {
      name: "load_case",
      run: async (ctx) => {
        cursor.node = "load_case";
        // run 主体的装配读（case_id 来自 run 交接态，不经 LLM）——与票 13 的
        // claimVerdict/patchOutcome 同类：M2 直连 adapter 读，不占 LLM 工具面。
        const detail = await deps.m2.getCaseDetail(deps.caseId);
        if (!detail) throw new Error(`case_not_found:${deps.caseId}`);
        // primary alert 日期 = 查询窗锚点（get_alert 在 A.1 里属分诊/调查共用 L0，过闸）
        const primaryId = detail.linkedAlerts[0];
        let primaryAlertDate = detail.startDate;
        if (primaryId) {
          const alert = await gated(ctx, "get_alert", { alert_id: primaryId }, () => deps.m2.getAlert(primaryId));
          if (alert && typeof alert.date === "number") primaryAlertDate = alert.date;
        }
        ctx.state.case = caseViewOf(detail, primaryAlertDate);
      },
    },
    {
      name: "plan",
      run: async (ctx) => {
        cursor.node = "plan";
        const input: PlanCall = { prompt: buildPlanPrompt((ctx.state.case as CaseView)), input: { case: ctx.state.case as CaseView } };
        const startedAt = Date.now();
        const plan = await deps.llm.plan(input);
        ctx.charge(plan.tokens);
        ctx.checkLlm(startedAt, Date.now());
        ctx.state.plan = plan.tasks;
        ctx.emit("audit", { action: "plan", tasks: plan.tasks });
      },
    },
    {
      name: "tool_loop",
      run: async (ctx) => {
        cursor.node = "tool_loop";
        const kase = ctx.state.case as CaseView;
        const tasks = (ctx.state.plan as string[]) ?? [];
        const maxSteps = deps.maxSteps ?? numEnv(process.env.MAX_STEPS) ?? LOOP_MAX_STEPS;
        const observations: ObsEntry[] = [];
        const executed = new Set<string>();
        const seen = new Set<string>(); // 防打转指纹：tool + paramsHash
        let stepsUsed = 0;
        let finished = false;

        while (stepsUsed < maxSteps) {
          stepsUsed += 1;
          // 缰绳一：每步都可能是最后一步；用尽后循环截断 → incomplete（不抛不杀）
          const call = { case: kase, tasks, observations: [...observations] };
          const startedAt = Date.now();
          const d = await deps.llm.decide({ prompt: buildDecidePrompt(call), input: call });
          ctx.charge(d.tokens);
          ctx.checkLlm(startedAt, Date.now());
          if (d.kind === "finish") {
            finished = true;
            break;
          }

          // 缰绳二：防打转——同参数重复调用直接返回错误（指纹 = 规范化参数 hash）
          const fingerprint = `${d.tool}:${paramsHash(d.params)}`;
          if (seen.has(fingerprint)) {
            record({
              action: "repeat_tool_call",
              objectId: deps.runId,
              objectType: "tool_call",
              details: { tool: d.tool, params_hash: paramsHash(d.params), step: stepsUsed },
              result: "FAILURE",
            });
            observations.push({ step: stepsUsed, tool: d.tool, params: d.params, ok: false, error: "repeated_tool_call" });
            continue;
          }
          seen.add(fingerprint);

          // 工具签名契约（m5 卡公开接口）：违约不执行、不烧后端，错误回给 LLM
          const sig = validateToolCall(d.tool, d.params);
          if (!sig.ok) {
            record({
              action: "tool_signature_rejected",
              objectId: deps.runId,
              objectType: "tool_call",
              details: { tool: d.tool, error: sig.error, step: stepsUsed },
              result: "FAILURE",
            });
            observations.push({ step: stepsUsed, tool: d.tool, params: d.params, ok: false, error: sig.error });
            continue;
          }

          // 闸 → 执行 → 观察（工具报错 = 证据缺口，审计后继续；闸拒在 gated 内抛强杀）
          try {
            const payload = await gated(ctx, d.tool, d.params, () => execTool(d.tool, d.params));
            executed.add(d.tool);
            const govn = await observe(ctx, d.tool, payload);
            observations.push({
              step: stepsUsed,
              tool: d.tool,
              params: d.params,
              ok: true,
              payload: govn.payload,
              ...(govn.flagged ? { flagged: true } : {}),
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("_gate_denied:")) throw e; // INV-1：闸拒不吞，fail-closed 上抛
            record({
              action: "tool_error",
              objectId: deps.runId,
              objectType: "tool_call",
              details: { tool: d.tool, message: msg, step: stepsUsed },
              result: "FAILURE",
            });
            observations.push({ step: stepsUsed, tool: d.tool, params: d.params, ok: false, error: `tool_error:${msg}` });
          }
        }

        const loop: LoopState = {
          stepsUsed,
          maxSteps,
          finished,
          incomplete: !finished,
          executed: [...executed],
          observations,
        };
        ctx.state.loop = loop;
        if (loop.incomplete) {
          record({
            action: "investigation_truncated",
            objectId: deps.runId,
            objectType: "investigation",
            details: { maxSteps, stepsUsed },
            result: "FAILURE",
          });
        }
      },
    },
    {
      name: "report_llm",
      run: async (ctx) => {
        cursor.node = "report_llm";
        const kase = ctx.state.case as CaseView;
        const loop = ctx.state.loop as LoopState;
        const tasks = (ctx.state.plan as string[]) ?? [];
        const input: ReportCall["input"] = {
          case: kase,
          tasks,
          observations: loop.observations,
          incomplete: loop.incomplete,
          stepsUsed: loop.stepsUsed,
        };
        const attempt = async (): Promise<{ text: string; evidenceOk: boolean; error: string | null }> => {
          const call: ReportCall = { prompt: buildReportPrompt(input), input };
          const startedAt = Date.now();
          const reply = await deps.llm.report(call);
          ctx.charge(reply.tokens);
          ctx.checkLlm(startedAt, Date.now());
          const parsed = parseReport(reply.text);
          if (!parsed.ok) return { text: reply.text, evidenceOk: false, error: parsed.error };
          // findings 引用真实工具输出的确定性半边：source_tool 必须真被调用过
          const evidenceOk = parsed.report.findings.every((f) => loop.executed.includes(f.source_tool));
          return { text: reply.text, evidenceOk, error: evidenceOk ? null : "finding_source_tool_not_executed" };
        };

        let result = await attempt();
        if (result.error !== null) {
          // PRD 异常与边界：schema 校验失败重试 1 次，仍失败降级自由文本 + 标记
          record({
            action: "llm_retry",
            objectId: deps.runId,
            objectType: "investigation_report",
            details: { error: result.error },
            result: "FAILURE",
          });
          result = await attempt();
        }

        if (result.error === null) {
          const parsed = parseReport(result.text);
          // attempt 通过 = parse 必 ok；这里再解一次拿强类型的 report
          if (!parsed.ok) throw new Error(`unreachable: ${parsed.error}`);
          const incomplete = loop.incomplete || parsed.report.incomplete === true;
          const structured = { ...parsed.report, incomplete };
          ctx.state.report = {
            body: renderReportMarkdown(parsed.report, { caseId: kase.caseId, title: kase.title }),
            structured,
            degraded: false,
            incomplete,
          } satisfies ReportState;
        } else {
          record({
            action: "report_degraded",
            objectId: deps.runId,
            objectType: "investigation_report",
            details: { error: result.error },
            result: "FAILURE",
          });
          ctx.state.report = {
            body: `<!-- report_degraded: 调查报告 schema/引用校验未过，以下为自由文本 -->\n${result.text}`,
            structured: null,
            degraded: true,
            incomplete: loop.incomplete,
          } satisfies ReportState;
        }
      },
    },
    {
      name: "write_timeline",
      run: async (ctx) => {
        cursor.node = "write_timeline";
        const rep = ctx.state.report as ReportState;
        const params: Record<string, unknown> = {
          case_id: deps.caseId,
          kind: "investigation_report",
          body: rep.body,
        };
        if (rep.structured !== null) params.structured = rep.structured;
        await gated(ctx, "add_timeline_entry", params, () =>
          deps.m2.addTimelineEntry(deps.caseId, {
            kind: "investigation_report",
            author: ACTOR.id,
            body: rep.body,
            structured: rep.structured ?? undefined,
          }),
        );
        ctx.state.outcome = { timeline_written: true, degraded: rep.degraded, incomplete: rep.incomplete };
      },
    },
  ];
  return nodes;
}
