import { describe, expect, test } from "vitest";
import { LlmUpstreamError, type LlmChatResult } from "../../src/llm-client.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { openDb } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { executeRun } from "../../src/graph.js";
import { eventsAfter, type RunEvent } from "../../src/events.js";
import { loadRunState } from "../../src/checkpointer.js";
import { HttpInvestigationM2 } from "../investigation/m2.js";
import { makeChatFlow, CHAT_READONLY_TOOLS } from "./flow.js";
import { RealChatLlm } from "./llm-real.js";
import type { ChatSeam } from "../triage/llm-real.js";
import { buildClassifyPrompt, type AnswerCall, type ClassifyCall, type ClassifyInput } from "./llm.js";
import { highRiskTools, visibleTools } from "./visible-tools.js";
import { fakeScan, KEY, makeTaskTicket } from "../triage/testkit.js";
import type { FgaChecker } from "./gate.js";

// 票 33（体检 结构-14 / D3 后半）：RealChatLlm 两条降级分支的行为锁——
//   ① classify 回包坏形 → unknown 低置信（消费端 flow.ts 拿 unknown/0 走「澄清反问」，绝不猜意图）；
//   ② 上游病（限流/不可达/超时/5xx）→ unknown 低置信，不裸抛（triage/llm-real 同款 fail-closed）。
// adapter 级先例：triage/llm-real.test.ts（确定性假 seam）；全链路先例：
// knowledge/flow.test.ts:336（真 adapter 包必抛 seam 跑真子图，看降级路径接管）。

/** 确定性假 chat seam：回固定 LlmChatResult（mock 上游的响应形态在这里定），记录收到的 prompt。 */
function seamOf(reply: (prompt: string) => Promise<LlmChatResult>): { seam: ChatSeam; prompts: string[] } {
  const prompts: string[] = [];
  const seam: ChatSeam = {
    chat: async (prompt: string) => {
      prompts.push(prompt);
      return reply(prompt);
    },
  };
  return { seam, prompts };
}

const classifyInput = (message: string): ClassifyInput => ({
  message,
  role: "soc1",
  caseContext: null,
  candidates: ["get_alert", "kb_lookup", "related_alerts", "siem_query", "isolate_host"],
  highRisk: highRiskTools(),
});

const classifyCall = (message: string): ClassifyCall => ({ prompt: "", input: classifyInput(message) });

const answerCall = (): AnswerCall => ({
  prompt: "",
  input: {
    message: "18.18.18.18 还出现在哪些告警里？",
    role: "soc1",
    caseContext: null,
    intent: { tool: "related_alerts", params: { scope: "entity", value: "18.18.18.18" } },
    result: { total: 3, alerts: [{ id: "al_1", title: "sshd 暴力破解" }] },
    execution: null,
  },
});

// ---------- 正常面：JSON 剥壳 + tokens 计费 ----------

describe("RealChatLlm · classify 正常面（剥壳后透传，schema 判定在 adapter，prompt 契约逐字出域）", () => {
  test("真网形态 <think> 推理段 + ```json 围栏 → 剥壳解析；tool/confidence 透传，tokens 照记", async () => {
    const { seam } = seamOf(async () => ({
      text: '<think>\n用户问日志，选 siem_query。\n</think>\n```json\n{"tool":"siem_query","confidence":0.85}\n```',
      tokens: 64,
    }));
    const out = await new RealChatLlm(seam).classify(classifyCall("查一下 18.18.18.18 的日志"));
    expect(out).toEqual({ tool: "siem_query", confidence: 0.85, tokens: 64 });
  });

  test("prompt 契约文本逐字进 seam（buildClassifyPrompt 产物原样出域，adapter 不改写不截断）", async () => {
    const { seam, prompts } = seamOf(async () => ({ text: '{"tool":"unknown","confidence":0}', tokens: 1 }));
    await new RealChatLlm(seam).classify(classifyCall("隔离 web-01"));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("用户消息：隔离 web-01");
    expect(prompts[0]).toContain("isolate_host"); // 可见工具清单进了 prompt
    expect(prompts[0]).toContain('"tool":"unknown"'); // 清单外 → unknown 的输出契约在 prompt 里
  });
});

// ---------- 票 65：classify prompt 契约（可见清单 + 高危动作族清单，候选外高危意图可命名） ----------

describe("票 65 · classify prompt 契约：可见清单 + 高危动作族清单（FR-M8.4 原语义：越权意图命名后交闸拒绝并解释）", () => {
  test("soc1 真实可见面（不含 isolate_host）→ prompt 仍列高危动作族清单且明确命名许可；两清单之外仍 unknown", () => {
    const candidates = visibleTools("soc1");
    expect(candidates).not.toContain("isolate_host"); // 前提：A.2 高危响应族该格「—」，可见清单不含
    const prompt = buildClassifyPrompt({
      message: "帮我把主机 centos7 隔离了",
      role: "soc1",
      caseContext: null,
      candidates,
      highRisk: highRiskTools(),
    });
    expect(prompt).toContain("本角色可见工具清单");
    expect(prompt).toContain("高危动作族清单");
    expect(prompt).toContain("isolate_host"); // 高危意图词汇表进 prompt（不在 candidates 也在）
    expect(prompt).toContain("意图闸"); // 命名许可与「可见性交闸裁决」的说明在场
    expect(prompt).toContain('"tool":"unknown"'); // 两清单之外 → unknown 的兜底契约保留
    expect(prompt).not.toContain("清单外一律"); // 旧硬约束文本退场（防回退：把命名许可又焊死回候选面）
  });
});

// ---------- 降级分支①：classify 回包坏形 → unknown 低置信（澄清反问，不猜；计费照记） ----------

describe("降级分支①：classify 回包坏形 → {tool:unknown, confidence:0}，绝不猜意图", () => {
  test("非 JSON / 缺字段 / 类型错 / 截断围栏 / 数组体 → unknown 低置信，tokens 照记不吞账", async () => {
    const badShapes = [
      "抱歉，我不太确定您的意思", // 模型没守 JSON 契约，回了人话
      '{"tool":"siem_query"}', // 缺 confidence
      '{"confidence":0.9}', // 缺 tool
      '{"tool":123,"confidence":0.9}', // tool 非字符串
      '{"tool":"siem_query","confidence":"高"}', // confidence 非数字
      "```json\n" + '{"tool":"siem_query","confidence":0.9'.slice(0, 10), // 截断围栏：剥壳后不是合法 JSON
      '["siem_query", 0.9]', // 数组不是对象
    ];
    for (const text of badShapes) {
      const { seam } = seamOf(async () => ({ text, tokens: 33 }));
      const out = await new RealChatLlm(seam).classify(classifyCall("帮我看下这个主机"));
      expect(out, `坏形样本: ${text}`).toEqual({ tool: "unknown", confidence: 0, tokens: 33 });
    }
  });
});

// ---------- 降级分支②：上游病 → unknown 低置信（fail-closed 不裸抛） ----------

describe("降级分支②：LlmUpstreamError → 不抛，unknown/0/tokens=0（没产出不记费）", () => {
  test("限流/不可达/超时/5xx/坏形回包 全码覆盖", async () => {
    for (const code of ["rate_limited", "unreachable", "timeout", "http_503", "bad_shape"]) {
      const { seam } = seamOf(async () => {
        throw new LlmUpstreamError(code);
      });
      const out = await new RealChatLlm(seam).classify(classifyCall("查关联告警"));
      expect(out, `上游错误码: ${code}`).toEqual({ tool: "unknown", confidence: 0, tokens: 0 });
    }
  });

  test("非上游错误 = 代码 bug，照常裸抛（INV-1 不吞错，由 runner 强杀）", async () => {
    const { seam } = seamOf(async () => {
      throw new RangeError("programmer error");
    });
    const err = await new RealChatLlm(seam).classify(classifyCall("hi")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
  });
});

// ---------- answer：直通面（分类有降级，回答没有——错误原样上抛由 runner 强杀） ----------

describe("answer 直通：文本+tokens 透传；上游病不降级、原样上抛", () => {
  test("正常回包 text/tokens 原样返回，buildAnswerPrompt 产物逐字出域", async () => {
    const { seam, prompts } = seamOf(async () => ({ text: "该 IP 共出现在 3 条告警中。", tokens: 120 }));
    const out = await new RealChatLlm(seam).answer(answerCall());
    expect(out).toEqual({ text: "该 IP 共出现在 3 条告警中。", tokens: 120 });
    expect(prompts[0]).toContain("用户消息：18.18.18.18 还出现在哪些告警里？");
    expect(prompts[0]).toContain("工具结果："); // 回答的数字来源（只读查询结果）进了 prompt
  });

  test("上游病 → LlmUpstreamError 原样上抛（回答错误不吞：runner 强杀 run，INV-1）", async () => {
    const { seam } = seamOf(async () => {
      throw new LlmUpstreamError("http_503");
    });
    const err = await new RealChatLlm(seam).answer(answerCall()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUpstreamError);
  });
});

// ---------- 全链路降级（knowledge/flow.test.ts:336 先例）：真 adapter 跑真 chat_flow 子图 ----------

const tokensOf = (events: RunEvent[]): string =>
  events.filter((e) => e.type === "token").map((e) => (e.payload as { delta: string }).delta).join("");

/** 最小 chat_flow 布景：全局追问（caseId=null）不走 M2/SIEM/KB/FGA；M2 指向死端口，
 *  万一被误触连接拒绝即红——比静默替身更能暴露真实触达。 */
async function runRealChat(llm: RealChatLlm, message: string): Promise<{
  status: string;
  events: RunEvent[];
  audit: MemoryAuditSink;
  state: Record<string, unknown>;
}> {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const run = createRun(db, { kind: "chat_flow", caseId: null }, { audit, requestId: "req-33-degrade" });
  const fga: FgaChecker = (user, tool) =>
    Promise.resolve(user === "user:soc1" && tool === "get_alert" ? { allowed: true } : { allowed: false, reason: "fga_denied" });
  const flow = makeChatFlow({
    runId: run.id,
    requestId: "req-33-degrade",
    caseId: null,
    ticket: makeTaskTicket(run.id, [...CHAT_READONLY_TOOLS]),
    hmacKey: KEY,
    m2: new HttpInvestigationM2("http://127.0.0.1:9"), // discard 端口：被触达即连接拒绝
    siem: { query: async () => ({ total: 0, hits: [] }) },
    kb: { lookup: async () => [] },
    llm,
    fga,
    scan: async (text, channel) => fakeScan(text, channel),
    audit,
  });
  const done = await executeRun(db, run.id, {
    nodes: flow,
    audit,
    requestId: "req-33-degrade",
    hmacKey: KEY,
    initialState: { kind: "chat_flow", case_id: null, message, role: "soc1" },
  });
  return { status: done.status, events: eventsAfter(db, run.id, 0), audit, state: loadRunState(db, run.id).state };
}

describe("全链路降级：RealChatLlm 接真 chat_flow 子图，上游病/坏形都落「澄清反问」，run 不裸抛", () => {
  test("上游病（必抛 seam）→ completed + 澄清反问 token + 零工具调用 + 审计留痕 unknown/0", async () => {
    const { seam } = seamOf(async () => {
      throw new LlmUpstreamError("http_503");
    });
    const out = await runRealChat(new RealChatLlm(seam), "帮我处理一下这个告警");

    // 降级路径接管：run 活着到达终态（宁澄清不猜，不裸抛——与 triage 同款 fail-closed）
    expect(out.status).toBe("completed");
    expect(out.events.some((e) => e.type === "error")).toBe(false);
    expect(tokensOf(out.events)).toContain("想确认");
    // 澄清反问即终点：没有工具调用、没有 denied（不是拒绝，是反问）
    expect(out.events.some((e) => e.type === "tool_call")).toBe(false);
    expect(out.events.some((e) => e.type === "denied")).toBe(false);
    // adapter 的 unknown/0 流进了 flow 的审计留痕（intent_classify 的 llm_call 细节）
    const llmCall = out.audit.entries.find((e) => e.action === "llm_call");
    expect(llmCall?.details).toMatchObject({ node: "intent_classify", tool: "unknown", confidence: 0 });
    // 消费端旗标：clarify 置位（intent_gate/execute/answer_llm 全部让路）
    expect((out.state.chat as { clarify?: boolean }).clarify).toBe(true);
  });

  test("回包坏形（模型说人话不守 JSON 契约）→ 同样落澄清反问，计费 tokens 照走 budget", async () => {
    const { seam } = seamOf(async () => ({ text: "这个嘛……我也说不清楚，你要干嘛来着？", tokens: 33 }));
    const out = await runRealChat(new RealChatLlm(seam), "把主机隔离掉算了");

    expect(out.status).toBe("completed");
    expect(tokensOf(out.events)).toContain("想确认");
    expect(out.events.some((e) => e.type === "tool_call")).toBe(false);
    const llmCall = out.audit.entries.find((e) => e.action === "llm_call");
    expect(llmCall?.details).toMatchObject({ tool: "unknown", confidence: 0 });
  });
});
