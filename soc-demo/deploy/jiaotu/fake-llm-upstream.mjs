// 狗粮票 59 · jiaotu 形态的确定性 fake LLM 上游（upstream-stub 容器挂的本件）。
//
// 为什么不是椒图仓的 upstream-stub.mjs：那是个「一律回固定文案」的假身，够 bench 的
// 负样本走通（上游 200 即放行），但 soc-demo 的六个判定点需要**结构化输出**——分诊
// verdict 要过 parseVerdict、调查 decide 要产合法工具调用、对话 classify 要认出意图。
// 本件 = services/agent/workers/{triage,investigation,chat}/llm.ts 三个 fixture 伪 LLM
// 的 HTTP 移植：只读 prompt 契约文本（不偷看 fixture 名，规则与伪 LLM 逐条同源），
// 对同一段 prompt 给出与 AGENT_LLM=fake 逐字段一致的决策——外部形态栈的行为因此与
// 内部模式 fake 演示可对照（幕 6 eval 数字同基线的前提）。
//
// 形态：zero-dep node:http，OpenAI 兼容 chat/completions 回包（椒图 g2 原样转发 body，
// 只认 choices[0].message.content 与 usage.total_tokens）。挂载与用法见
// docker-compose.jiaotu.yml 的 upstream-stub 服务。
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 9990);
const TOKENS = 64;

// ── 与 workers/triage/llm.ts FakeTriageLlm 同源的一组信号 ─────────────────────
const ATTACK_TITLE = /brute force|malicious file|rootkit|anomaly detection/i;
const ATTACK_LOG = /rootkit|illegal user|failed password/i;
const ATTACK_URL = /(union\s+select|<script|whoami\.cgi|\/etc\/passwd)/i;
const WEAK_TITLE = /non-existent user/i;
const NOISE_TITLE = /error code|file added/i;
const decode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

// ── 与 workers/chat/llm.ts FakeChatLlm 同源的意图规则 ─────────────────────────
function classifyOf(message) {
  if (/隔离|isolate/i.test(message)) return { tool: "isolate_host", confidence: 0.9 };
  if (/封(禁|掉)?\s*(ip|IP)?|block/i.test(message) && /ip|IP|\d{1,3}\.\d{1,3}\.\d{1,3}/.test(message)) {
    return { tool: "block_ip", confidence: 0.9 };
  }
  if (/入库|写进知识库|写知识库|kb_write/i.test(message)) return { tool: "kb_write", confidence: 0.9 };
  if (/还出现在|出现过|关联.*告警|哪些告警|related/i.test(message)) return { tool: "related_alerts", confidence: 0.9 };
  if (/siem|日志|full_log|检索日志/i.test(message)) return { tool: "siem_query", confidence: 0.85 };
  if (/知识库|知识条目|kb\b/i.test(message)) return { tool: "kb_lookup", confidence: 0.85 };
  return { tool: "unknown", confidence: 0.2 };
}

// ── prompt 文本切片小件 ───────────────────────────────────────────────────────
const between = (text, startMark, endMark) => {
  const i = text.indexOf(startMark);
  if (i < 0) return "";
  const rest = text.slice(i + startMark.length);
  const j = endMark ? rest.indexOf(endMark) : -1;
  return j >= 0 ? rest.slice(0, j) : rest;
};
const untrustedBlocks = (text) =>
  [...text.matchAll(/<<<UNTRUSTED field="([^"]+)">>>\n[\s\S]*?\n([\s\S]*?)\n<<<END UNTRUSTED>>>/g)]
    .map((m) => ({ field: m[1], content: m[2] }));

/** 分诊 verdict（FakeTriageLlm.decide 的 prompt 版）：从契约文本还原 input 五件再走同一条规则链。 */
function triageVerdict(prompt) {
  const trusted = between(prompt, "## 告警（可信字段）", "\n## ");
  const title = trusted.match(/^title: (.*)$/m)?.[1] ?? "";
  const severity = Number(trusted.match(/^severity: (\d+)$/m)?.[1] ?? 0);
  const untrusted = untrustedBlocks(between(prompt, "## 告警不可信段", "\n## "));
  const mergeLine = prompt.match(/host=(\S*) 窗口=(\d+)h 命中数=(\d+)(?: 可并案=(\S+))?/);
  const merge = {
    host: mergeLine?.[1] ?? "",
    openCasesChecked: Number(mergeLine?.[3] ?? 0),
    candidateCaseId: mergeLine?.[4] ?? null,
  };
  const self_audit = {
    open_cases_checked: merge.openCasesChecked,
    host_searched: merge.host,
    same_host_case_found: merge.openCasesChecked > 0, // toMergeCheck：cases.length > 0
  };
  const kbSection = between(prompt, "## KB 检索命中", "\n## ");
  const knownChange = /\[known_change\]|\[env_fact\]/.test(kbSection);
  const urlish = untrusted.filter((f) => f.field.startsWith("observable:url")).map((f) => decode(f.content)).join("\n");
  const logish = untrusted.map((f) => f.content).join("\n");

  let out;
  if (knownChange) {
    out = { verdict: "btp", confidence: 0.9, rationale: "KB 已知变更命中（fake 上游同源规则）", recommended_action: "close" };
  } else if (severity >= 3 || ATTACK_TITLE.test(title) || ATTACK_LOG.test(logish) || ATTACK_URL.test(urlish)) {
    out = {
      verdict: "tp",
      confidence: 0.85,
      rationale: `攻击证据成立（title=${title} severity=${severity}）`,
      recommended_action: merge.same_host_case_found && merge.candidateCaseId ? `merge:${merge.candidateCaseId}` : "create_case",
    };
  } else if (WEAK_TITLE.test(title)) {
    out = { verdict: "uncertain", confidence: 0.4, rationale: "孤立的无效用户登录试探，无法排除口令笔误或低强度探测", recommended_action: "human" };
  } else if (NOISE_TITLE.test(title)) {
    out = { verdict: "fp", confidence: 0.75, rationale: "Web/文件事件无攻击特征，按运维噪声处理", recommended_action: "close" };
  } else {
    out = { verdict: "uncertain", confidence: 0.3, rationale: "无匹配决策点，默认升级人工", recommended_action: "human" };
  }
  return JSON.stringify({ ...out, self_audit });
}

// ── 调查子图（FakeInvestigationLlm 的 prompt 版）──────────────────────────────
const DAY_MS = 24 * 3_600_000;
function parseCase(prompt) {
  const entityLine = prompt.match(/实体：ip=(\[.*?\]) user=(\[.*?\]) host=(\[.*?\])/);
  const json = (s) => { try { return JSON.parse(s); } catch { return []; } };
  const dateLine = prompt.match(/primary alert 日期：(.*?)（/);
  const sevLine = prompt.match(/（severity (\d+)，/);
  const titleLine = prompt.match(/案件 (case_\d+)：(.*)（severity/);
  return {
    caseId: titleLine?.[1] ?? "",
    title: titleLine?.[2] ?? "",
    severity: Number(sevLine?.[1] ?? 0),
    ips: json(entityLine?.[1] ?? "[]"),
    users: json(entityLine?.[2] ?? "[]"),
    hosts: json(entityLine?.[3] ?? "[]"),
    primaryAlertDate: dateLine ? Date.parse(dateLine[1]) : Date.now(),
  };
}
function parseObservations(prompt) {
  const section = between(prompt, "已执行工具与观察", "\n\n") || between(prompt, "已执行工具与观察（findings", "\n\n");
  const obs = [];
  for (const m of section.matchAll(/step(\d+) (\w+)\((\{.*?\})\) → (.*)/g)) {
    let params = {};
    try { params = JSON.parse(m[3]); } catch { /* 观察参数解析失败按空处理 */ }
    const isError = m[4].startsWith("错误：");
    let payload = null;
    if (!isError) { try { payload = JSON.parse(m[4]); } catch { payload = null; } }
    obs.push({ step: Number(m[1]), tool: m[2], params, ok: !isError, payload, error: isError ? m[4] : null });
  }
  return obs;
}
function windowAround(anchorMs) {
  return { from: new Date(anchorMs - DAY_MS).toISOString(), to: new Date(anchorMs + DAY_MS).toISOString() };
}
/** 下一步（FakeInvestigationLlm.decide 同一条 pivot 顺序：siem ip→user→host → related → kb_verify → finish） */
function decideNext(prompt) {
  const kase = parseCase(prompt);
  const done = new Set(parseObservations(prompt).filter((o) => o.ok).map((o) => o.tool));
  const win = windowAround(kase.primaryAlertDate);
  if (!done.has("siem_query")) {
    if (kase.ips[0]) return { action: "tool", tool: "siem_query", params: { entity_type: "ip", entity: kase.ips[0], time_window: win } };
    if (kase.users[0]) return { action: "tool", tool: "siem_query", params: { entity_type: "user", entity: kase.users[0], time_window: win } };
    if (kase.hosts[0]) return { action: "tool", tool: "siem_query", params: { entity_type: "host", entity: kase.hosts[0], time_window: win } };
  }
  if (!done.has("related_alerts") && kase.hosts[0]) {
    return { action: "tool", tool: "related_alerts", params: { scope: "host", value: kase.hosts[0], time_window: win } };
  }
  if (!done.has("kb_verify") && (kase.hosts[0] || kase.users[0])) {
    return { action: "tool", tool: "kb_verify", params: { host: kase.hosts[0] ?? "", user: kase.users[0] ?? "" } };
  }
  return { action: "finish" };
}
/** 调查报告（FakeInvestigationLlm.report 同源：findings 只从真实观察长出来，0 命中如实写） */
function investigationReport(prompt) {
  const kase = parseCase(prompt);
  const obs = parseObservations(prompt);
  const siem = obs.find((o) => o.tool === "siem_query" && o.ok);
  const rel = obs.find((o) => o.tool === "related_alerts" && o.ok);
  const kb = obs.find((o) => o.tool === "kb_verify" && o.ok);
  const totalOf = (o) => (typeof o?.payload?.total === "number" ? o.payload.total : 0);
  const findings = [];
  if (siem && totalOf(siem) > 0) {
    findings.push({
      entity: String(siem.params.entity),
      evidence: siem.payload.hits?.[0]?.full_log ?? siem.payload.summary ?? siem.payload.hits_ref ?? "",
      source_tool: "siem_query",
    });
  }
  if (rel && totalOf(rel) > 0) {
    findings.push({ entity: String(rel.params.value), evidence: rel.payload.alerts[0].id, source_tool: "related_alerts" });
  }
  const counts = [
    `siem_query 命中 ${siem ? totalOf(siem) : 0} 条`,
    `related_alerts 命中 ${rel ? totalOf(rel) : 0} 条`,
    `kb_verify 命中 ${kb ? kb.payload?.hits?.length ?? 0 : 0} 条`,
  ].join("，");
  const noHit = !siem || totalOf(siem) === 0;
  const kbRefs = kb ? (kb.payload?.hits ?? []).map((h) => `kb:${h.kind}:${h.title}`) : [];
  return JSON.stringify({
    summary: `${kase.title}：${counts}。${noHit ? "SIEM 无关联事件（如实记录，未编造）。" : ""}`.trim(),
    severity_assessment: kase.severity,
    confidence: 0.8,
    findings,
    affected_assets: [...kase.hosts],
    recommended_actions:
      kase.severity >= 3 && kase.hosts[0]
        ? [{ tool: "isolate_host", params: { host: kase.hosts[0] }, justification: "调查认定严重度 ≥3，建议隔离主机（只建议：worker 无 L2 票，执行须人审铸票）" }]
        : [],
    kb_refs: kbRefs,
  });
}

// ── 分发：按 prompt 契约的判别标记选节点（标记都来自各 prompt/adapter 的固定文本）──
function respond(promptText) {
  if (promptText.includes("你是 SOC 分诊分析师")) return triageVerdict(promptText); // TRIAGE_OUTPUT_CONTRACT
  if (promptText.includes("意图分类器")) {
    const message = promptText.match(/用户消息：([\s\S]*?)$/)?.[1]?.trim() ?? "";
    return JSON.stringify(classifyOf(message));
  }
  if (promptText.includes("你是 SOC 对话助手。用大白话回答用户")) {
    const execution = promptText.match(/审批动作执行结果：已执行（(\w+)）/);
    if (execution) return `已执行 ${execution[1]}（经值班长审批、ApprovalToken 验签通过）。结果见案件时间线。`;
    if (/审批动作执行结果：/.test(promptText)) {
      const tool = promptText.match(/审批动作执行结果：动作 (\w+) 未执行/)?.[1] ?? "";
      return `动作 ${tool} 未执行：审批被驳回，工单已留痕。`;
    }
    return "已按案件上下文完成查询，结论以工具结果为准（fake 上游确定性回答）。";
  }
  if (promptText.includes('{"tasks"')) return JSON.stringify({ tasks: ["siem_query pivot 查询（强制时间窗）", "related_alerts 聚合同主机历史告警", "kb_verify 内部事实核验"] });
  if (promptText.includes('{"action":"tool"')) return JSON.stringify(decideNext(promptText));
  if (promptText.includes("把下面的工具输出压缩成一段摘要")) {
    const body = promptText.split("输出：\n")[1] ?? "";
    return `${body.slice(0, 120).replace(/\s+/g, " ")}…[llm_summarize: 原文 ${body.length} 字符已摘要]`;
  }
  if (promptText.includes("基于已执行工具的观察做关联调查")) return investigationReport(promptText);
  // 未识别的 prompt：返回必不合 schema 的标记（worker 的降级/强杀路径原样接管，绝不编数据）
  return JSON.stringify({ error: "unknown_prompt_fake_upstream" });
}

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let content = "";
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      content = (body.messages ?? []).map((m) => m?.content ?? "").join("\n");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: respond(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: TOKENS },
    }));
  });
}).listen(PORT, () => {
  console.log(`[fake-llm-upstream] 确定性伪 LLM 上游就绪（票 59，伪 adapter 的 HTTP 移植）:http://0.0.0.0:${PORT}`);
});
