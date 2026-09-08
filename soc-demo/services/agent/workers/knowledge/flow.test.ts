// 票 17 验收主战场：知识沉淀子图全链路。
// 打真 case-backend（kb/proposals REST + kbentry 状态机 + 审计全在环内）+ 生产
// HttpKnowledgeM2 / HttpTriageM2 + 确定性伪 LLM + MemoryVectorStore 替身（真容器冒烟
// 在 vector-store.test.ts 单独探测）。app.inject 走完整 REST 面：铸任务票 → 组图 →
// 审批卡 interrupt → 值班长裁决 → resume → kb_write 执行。
import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../../src/db.js";
import { buildApp } from "../../src/app.js";
import { MemoryAuditSink, type AuditSink } from "../../src/audit.js";
import { eventsAfter, type RunEvent } from "../../src/events.js";
import { LlmUpstreamError, type LlmChatResult } from "../../src/llm-client.js";
import type { MintClient } from "../../src/token-ports.js";
import { makeKnowledgeFlow } from "./flow.js";
import { FakeKnowledgeLlm } from "./llm.js";
import { RealKnowledgeLlm } from "./llm-real.js";
import { HttpKnowledgeM2 } from "./m2.js";
import { ChromaKb } from "./kb.js";
import { MemoryVectorStore } from "./vector-store.js";
import { makeTriageFlow } from "../triage/flow.js";
import { FakeTriageLlm } from "../triage/llm.js";
import { HttpTriageM2 } from "../triage/m2.js";
import { KNOWLEDGE_TOOLS } from "./prompt.js";
import {
  fakeScan, httpJson, KEY, makeTaskTicket, seedAlert, startCaseBackend, type CaseBackend,
} from "../triage/testkit.js";

const POISON = JSON.parse(
  readFileSync(new URL("../../../../fixtures/knowledge/02_poison_rejected/proposal.json", import.meta.url), "utf8"),
) as { submit: { kind: string; title: string; body: string; tags: string[]; source_case_id: string | null } };
const FIX = (f: string) => fileURLToPath(new URL(`../../../../fixtures/alerts/${f}`, import.meta.url));

interface Rig {
  cb: CaseBackend;
  db: DB;
  audit: MemoryAuditSink;
  face: MemoryVectorStore; // 检索面替身（生产 = RealChromaClient → chroma 容器）
  app: ReturnType<typeof buildApp>;
  minted: { sub: string; allowedTools: string[] }[];
  /** 值班长批准当前 pending 的 kb_write 卡 */
  approve: () => Promise<{ status: number; json: Record<string, unknown> }>;
  /** 值班长驳回当前 pending 的 kb_write 卡 */
  reject: () => Promise<{ status: number; json: Record<string, unknown> }>;
  proposals: () => Promise<Record<string, unknown>[]>;
}

async function rig(): Promise<Rig> {
  const cb = await startCaseBackend();
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const face = new MemoryVectorStore();
  const m2 = new HttpKnowledgeM2(cb.url);
  const minted: { sub: string; allowedTools: string[] }[] = [];
  const mint: MintClient = {
    async mintTaskTicket(req) {
      minted.push({ sub: req.sub, allowedTools: req.allowedTools });
      return {
        token: makeTaskTicket(req.runId, req.allowedTools, { caseId: req.caseId ?? undefined }),
        payload: {},
      };
    },
    async mintApprovalToken(req) {
      // 与 approval-loop.test 的假铸票同形：ApprovalToken wire（闸真验签依赖它）
      const { createHmac } = await import("node:crypto");
      const { paramsHash } = await import("../../src/verify-ticket.js");
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const iat = Math.floor(Date.now() / 1000);
      const payload = {
        jti: req.jti, approval_id: req.approvalId, approved_by: req.approvedBy,
        tool: req.tool, params_hash: paramsHash(req.params), case_id: req.caseId ?? "",
        iat, exp: iat + 300, used: false,
      };
      const b64p = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sig = createHmac("sha256", Buffer.from(KEY, "utf8")).update(`${header}.${b64p}`).digest("hex");
      return { token: `${header}.${b64p}.${sig}`, payload };
    },
  };
  const app = buildApp({
    db, audit, hmacKey: KEY, mint,
    makeNodes: (run, ticket) =>
      run.kind === "knowledge_flow"
        ? makeKnowledgeFlow({
            runId: run.id, requestId: `req-17-${run.id}`, ticket,
            caseId: run.caseId ?? "", hmacKey: KEY,
            m2, store: face, llm: new FakeKnowledgeLlm(), audit,
          })
        : makeTriageFlow({
            runId: run.id, requestId: `req-17-${run.id}`, ticket, hmacKey: KEY,
            m2: new HttpTriageM2(cb.url), kb: new ChromaKb(face),
            llm: new FakeTriageLlm(), scan: fakeScan, audit,
          }),
  });

  const pending = async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    return ((res.json() as { approvals: Record<string, unknown>[] }).approvals ?? [])[0];
  };
  return {
    cb, db, audit, face, app, minted,
    approve: async () => {
      const card = await pending();
      const res = await app.inject({ method: "POST", url: `/api/v1/approvals/${card?.id}/approve`, payload: { approver: "duty_lead" } });
      return { status: res.statusCode, json: res.json() as Record<string, unknown> };
    },
    reject: async () => {
      const card = await pending();
      const res = await app.inject({ method: "POST", url: `/api/v1/approvals/${card?.id}/reject`, payload: { approver: "duty_lead", reason: "卡上草稿含指令性内容" } });
      return { status: res.statusCode, json: res.json() as Record<string, unknown> };
    },
    // kb/proposals 面在 case-backend（m7 卡决策：REST 挂 M2）——helper 打对服务
    proposals: async () =>
      ((await httpJson(cb.url, "GET", "/api/v1/kb/proposals")).json as { proposals: Record<string, unknown>[] }).proposals,
  };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function track(r: Rig): Promise<Rig> {
  closers.push(() => r.cb.close());
  return r;
}

/** 建一个已关闭（带人工 verdict）的案件——knowledge_flow 的合法入口。
 *  案件挂 hostname observable（主机出网告警案的常态），提炼草稿才有 host 标签可检索。 */
async function closedCase(r: Rig, verdict: string, note: string): Promise<string> {
  const created = await httpJson(r.cb.url, "POST", "/api/v1/cases", { title: "[wazuh_alert] - centos7 - 2026-09-08" });
  const caseId = String(created.json.id);
  await httpJson(r.cb.url, "PATCH", `/api/v1/cases/${caseId}`, { status: "InProgress" });
  await httpJson(r.cb.url, "POST", `/api/v1/cases/${caseId}/observables`, { dataType: "hostname", data: "centos7" });
  await httpJson(r.cb.url, "POST", `/api/v1/cases/${caseId}/close`, { verdict, verdictNote: note });
  return caseId;
}

async function runKnowledge(r: Rig, caseId: string): Promise<{ runId: string; status: string }> {
  const res = await r.app.inject({ method: "POST", url: "/internal/runs", payload: { kind: "knowledge_flow", case_id: caseId } });
  expect(res.statusCode).toBe(202);
  const runId = res.json().run_id as string;
  const status = (await r.app.inject({ method: "GET", url: "/healthz" }), (r.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status);
  return { runId, status };
}

const toolCalls = (r: Rig, runId: string): RunEvent[] =>
  eventsAfter(r.db, runId, 0).filter((e) => e.type === "tool_call");

// ---------- 验收 1：提炼子图产出 KBEntry 草稿 proposed ----------

describe("提炼子图：案件关闭 → KBEntry 草稿 proposed（FR-M7.1·PRD §5.10）", () => {
  test("FP 案关闭 → 子图提炼 fp_pattern 草稿 → M2 建档 proposed + 审批卡挂起", async () => {
    const r = await track(await rig());
    const caseId = await closedCase(r, "false_positive", "WAF 已拦截的扫描噪声");
    const { runId, status } = await runKnowledge(r, caseId);

    // kb_write 开卡 interrupt：run 停在 awaiting_approval（人审闸，FR-M7.2）
    expect(status).toBe("awaiting_approval");
    // 任务票按 kind 铸：sub=agent:knowledge，票面只有 get_case/kb_propose——kb_write 不在票面（INV-3）
    expect(r.minted[0]).toMatchObject({ sub: "agent:knowledge", allowedTools: [...KNOWLEDGE_TOOLS] });

    const props = await r.proposals();
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      kind: "fp_pattern",
      status: "proposed",
      source_case_id: caseId,
      proposed_by: "agent:knowledge",
    });
    expect(String(props[0].title)).toContain("FP 模式");
    expect(String(props[0].body)).toContain("复核要点");
    expect(props[0].tags).toEqual(["centos7", "fp_pattern"]);

    // 审批卡：tool=kb_write，params 带提案与草稿全文（值班长在卡上看到要入库的东西）
    const res = await r.app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    const card = (res.json() as { approvals: Record<string, unknown>[] }).approvals[0];
    expect(card).toMatchObject({ tool: "kb_write", status: "pending", case_id: caseId });
    expect((card.params as Record<string, unknown>).title).toContain("FP 模式");

    // 草稿未审 → 检索面物理为空（INV-5：proposed 不进检索面）
    expect(await r.face.query("FP 模式 复核要点", 5)).toHaveLength(0);
    void runId;
  });

  test("ASP 门控：无人工 verdict 的案件跳过抽取（FR-M7.1）——run 完成且零提案", async () => {
    const r = await track(await rig());
    const created = await httpJson(r.cb.url, "POST", "/api/v1/cases", { title: "未关案件" });
    const caseId = String(created.json.id);

    const { status } = await runKnowledge(r, caseId);
    expect(status).toBe("completed");
    expect(await r.proposals()).toHaveLength(0);
    expect(r.audit.entries.some((e) => e.action === "knowledge_skip" && e.details.reason === "no_verdict")).toBe(true);
  });

  test("kind 校验：不认识的 run kind 拒收（fail-closed 口径不放松）", async () => {
    const r = await track(await rig());
    const res = await r.app.inject({ method: "POST", url: "/internal/runs", payload: { kind: "knowledge_flow" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "case_id_required" });
  });
});

// ---------- 验收 2：kb_write L2 人审闸——approve 进检索面 / 驳回永不检索 ----------

describe("kb_write 人审闸：approved 进 chroma 检索面；rejected 永不检索（FR-M7.2·INV-5）", () => {
  test("批准路径：ApprovalToken 验签 → M2 approve 留痕 → 检索面 upsert → run completed", async () => {
    const r = await track(await rig());
    const caseId = await closedCase(r, "false_positive", "WAF 已拦截的扫描噪声");
    await runKnowledge(r, caseId);

    const ok = await r.approve();
    expect(ok.status).toBe(200);

    // 账面：proposed → approved（reviewed_by 留痕 + M2 审计）
    const props = await r.proposals();
    expect(props[0]).toMatchObject({ status: "approved", reviewed_by: "duty_lead" });
    const audits = await httpJson(r.cb.url, "GET", `/api/v1/audit?objectId=${String(props[0].id)}`);
    expect((audits.json as unknown as { action: string }[]).map((a) => a.action)).toEqual(["create", "approve"]);

    // 检索面：草稿内容可检索（top 命中），id = 提案 id（账面 ↔ 检索面对得上）
    const hits = await r.face.query("FP 模式 WAF 扫描噪声", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: props[0].id, metadata: { kind: "fp_pattern", source_case_id: caseId } });

    // run 终态 completed + L2 执行审计（approve/execute）+ 卡已执行（一次性）
    const runRow = r.db.prepare("SELECT status FROM runs ORDER BY created_at DESC LIMIT 1").get() as { status: string };
    expect(runRow.status).toBe("completed");
    expect(r.audit.entries.some((e) => e.action === "execute" && e.result === "SUCCESS")).toBe(true);
  });

  test("驳回路径：卡 rejected → M2 reject 留痕 → 检索面确定性查不到 → 终态 409", async () => {
    const r = await track(await rig());
    const caseId = await closedCase(r, "false_positive", "WAF 已拦截的扫描噪声");
    await runKnowledge(r, caseId);

    const rej = await r.reject();
    expect(rej.status).toBe(200);

    const props = await r.proposals();
    expect(props[0]).toMatchObject({ status: "rejected" });
    expect(await r.face.query("FP 模式 WAF 扫描噪声", 5)).toHaveLength(0); // rejected 永不检索

    // 状态机锁死：表外/迟到的 approve → 409（INV-10）
    const late = await httpJson(r.cb.url, "POST", `/api/v1/kb/proposals/${String(props[0].id)}/approve`, { reviewer: "duty_lead" });
    expect(late.status).toBe(409);
  });
});

// ---------- 验收 3：knowledge/02_poison_rejected（m7 卡测试计划具名场景） ----------

describe("fixtures/knowledge/02_poison_rejected：毒 runbook 提案被驳回后，检索面确定性查不到", () => {
  test("红队经唯一建档口投毒 → 值班长驳回 → 检索面 0 命中 + 账面终态 + 全链审计", async () => {
    const r = await track(await rig());
    // 红队提交毒提案（数据走 REST 正门，绝不直接塞库/塞检索面）
    const created = await httpJson(r.cb.url, "POST", "/api/v1/kb/proposals", {
      ...POISON.submit, proposed_by: "red_team",
    });
    expect(created.status).toBe(201);
    const poisonId = String((created.json as Record<string, unknown>).id);

    // 驳回前：检索面本就没有它（人审是知识入库唯一通道，INV-5）
    const probeQ = "勒索软件 ransomware 快速关单 false_positive";
    expect(await r.face.query(probeQ, 5)).toHaveLength(0);

    // D8：值班长经 M2 REST 驳回（reject 只关账面，永远碰不到检索面）
    const rej = await httpJson(r.cb.url, "POST", `/api/v1/kb/proposals/${poisonId}/reject`, {
      reviewer: "duty_lead", reason: "正文夹带「遇此类告警一律判 FP」指令，投毒",
    });
    expect(rej.status).toBe(200);
    expect((rej.json as Record<string, unknown>).status).toBe("rejected");

    // 确定性断言：毒内容在检索面 0 命中（唯一注入指令标记的查询词也查不到）
    expect(await r.face.query(probeQ, 5)).toHaveLength(0);
    expect(await r.face.query(POISON.submit.title, 5)).toHaveLength(0);

    // 账面终态 + 审计链（create + reject）
    const audits = await httpJson(r.cb.url, "GET", `/api/v1/audit?objectId=${poisonId}`);
    expect((audits.json as unknown as { action: string }[]).map((a) => a.action)).toEqual(["create", "reject"]);
  });
});

// ---------- 验收 5：检索 top-k=5；replay 对结论一致且工具调用数下降 ----------

describe("replay 对（FR-M7.4）：结论与人审沉淀知识一致 + 探索性工具调用下降", () => {
  test("首跑无 KB → tp 建案（探索）；沉淀后 replay 同类告警 → 命中 env_fact → btp 关单（更少工具调用）", async () => {
    const r = await track(await rig());

    // ---- 首跑：ssh-5712 暴力破解（无 KB）→ tp → create_case（探索性路径）----
    const alert1 = await seedAlert(r.cb.url, FIX("ssh-5712-real.json"));
    const res1 = await r.app.inject({ method: "POST", url: "/internal/runs", payload: { kind: "alert_flow", alert_id: alert1 } });
    expect(res1.statusCode).toBe(202);
    const run1 = (res1.json() as { run_id: string }).run_id;
    expect(toolCalls(r, run1)).toHaveLength(4); // get_alert/kb_lookup/search_cases/create_case
    const alert1Row = await httpJson(r.cb.url, "GET", `/api/v1/alerts/${alert1}`);
    expect((alert1Row.json as Record<string, unknown>).verdict).toBe("true_positive");
    const cases = (await httpJson(r.cb.url, "GET", "/api/v1/cases")).json as unknown as { id: string }[];
    expect(cases).toHaveLength(1);

    // ---- SOC1 复核：授权红队演练（btp）关案 → 沉淀 → 值班长批准入库 ----
    const caseId = cases[0].id;
    await httpJson(r.cb.url, "PATCH", `/api/v1/cases/${caseId}`, { status: "InProgress" });
    await httpJson(r.cb.url, "POST", `/api/v1/cases/${caseId}/close`, {
      verdict: "benign_true_positive", verdictNote: "授权红队演练（登记号 DX-2026-09）",
    });
    const { status } = await runKnowledge(r, caseId);
    expect(status).toBe("awaiting_approval");
    await r.approve();
    const props = await r.proposals();
    expect(props[0]).toMatchObject({ kind: "env_fact", status: "approved" }); // 演练登记 = 内网环境事实
    const faceHits = await r.face.query("centos7 暴力破解 授权红队演练", 5);
    expect(faceHits).toHaveLength(1); // 技能已加载进检索面

    // ---- replay：同 fixture 换 sourceRef（新的同类告警）→ KB 命中 → 结论=知识一致 ----
    const raw = JSON.parse(readFileSync(FIX("ssh-5712-real.json"), "utf8")) as Record<string, unknown>;
    raw.id = "9999999999"; // 新 sourceRef：真实的第二次发生，不是同一条告警（INV-6 去重不背锅）
    const seed2 = await httpJson(r.cb.url, "POST", "/api/v1/alerts", (await import("../triage/testkit.js")).alertInputFromWazuh(raw));
    const alert2 = String((seed2.json as { alert: { id: string } }).alert.id);
    const res2 = await r.app.inject({ method: "POST", url: "/internal/runs", payload: { kind: "alert_flow", alert_id: alert2 } });
    const run2 = (res2.json() as { run_id: string }).run_id;

    // 工具调用数下降：4 → 3（不再 create_case）
    expect(toolCalls(r, run2)).toHaveLength(3);
    // 结论一致（FR-M7.4「结论仍正确」口径）：与人审沉淀的知识一致——btp + close
    const alert2Row = await httpJson(r.cb.url, "GET", `/api/v1/alerts/${alert2}`);
    const alert2Json = alert2Row.json as Record<string, unknown>;
    expect(alert2Json.verdict).toBe("benign_true_positive");
    expect((alert2Json.verdictAi as Record<string, unknown>).recommended_action).toBe("close");
    expect(String((alert2Json.verdictAi as Record<string, unknown>).rationale)).toContain("环境事实");
    // 全程零 L2（分诊物理无 L2 票）
    for (const e of [...toolCalls(r, run1), ...toolCalls(r, run2)]) {
      expect(e.payload).not.toHaveProperty("tool", "kb_write");
    }
  });
});

// ---------- RealKnowledgeLlm（票 27 同款 fail-closed：上游病了 → skip，不编造） ----------

describe("RealKnowledgeLlm：上游病了走 skip 降级（宁可不错提，不可编造）", () => {
  test("gateway 503 → 标记回包 → parseDraft 拒 → 重试 1 次 → knowledge_skip，run completed 零提案", async () => {
    const r = await track(await rig());
    const caseId = await closedCase(r, "false_positive", "噪声");
    // 直接手组 flow（不经 app 工厂）：RealKnowledgeLlm 包一个必抛的 chat seam
    const { createRun } = await import("../../src/runs.js");
    const { executeRun } = await import("../../src/graph.js");
    const run = createRun(r.db, { kind: "knowledge_flow", caseId }, { audit: r.audit, requestId: "req-17-degrade" });
    const flow = makeKnowledgeFlow({
      runId: run.id, requestId: "req-17-degrade",
      ticket: makeTaskTicket(run.id, [...KNOWLEDGE_TOOLS], { caseId }),
      caseId, hmacKey: KEY,
      m2: new HttpKnowledgeM2(r.cb.url),
      store: r.face,
      llm: new RealKnowledgeLlm({ chat: async () => { throw new LlmUpstreamError("http_503"); } }),
      audit: r.audit,
    });
    const done = await executeRun(r.db, run.id, { nodes: flow, audit: r.audit as AuditSink, requestId: "req-17-degrade", hmacKey: KEY });
    expect(done.status).toBe("completed");
    expect(await r.proposals()).toHaveLength(0);
    const skip = r.audit.entries.filter((e) => e.action === "knowledge_skip");
    expect(skip).toHaveLength(1);
    expect(String(skip[0].details.reason)).toContain("llm_upstream_http_503");
    void (0 as unknown as LlmChatResult); // LlmChatResult 仅作类型面引用锚（seam 回包形状）
  });
});
