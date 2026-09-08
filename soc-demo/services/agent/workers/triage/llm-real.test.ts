import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { executeRun } from "../../src/graph.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { eventsAfter, type RunEvent } from "../../src/events.js";
import { GatewayLlmClient, LlmUpstreamError, type LlmChatResult } from "../../src/llm-client.js";
import { makeTriageFlow } from "./flow.js";
import { MemoryKb } from "./kb.js";
import { RealTriageLlm } from "./llm-real.js";
import { HttpTriageM2 } from "./m2.js";
import { buildTriagePrompt, TRIAGE_TOOLS, type LlmCall, type TriageInput } from "./prompt.js";
import { parseVerdict } from "./schema.js";
import { fakeScan, httpJson, KEY, makeTaskTicket, seedAlert, startCaseBackend } from "./testkit.js";

// 票 27 验收②③④：RealTriageLlm（生产 adapter）的行为契约——seam 接口 TriageLlm 不变，
// mock 上游锁请求/响应形态；上游病了 → fail-closed 走 worker 既有「重试 1 次 →
// uncertain + human」降级路径（与 Fake 版一致），绝不裸抛。

const FIX = (f: string) => fileURLToPath(new URL(`../../../../fixtures/alerts/${f}`, import.meta.url));

/** 确定性假 chat：回固定 content（mock 上游的响应形态在这里定）。 */
function fakeChat(content: string, tokens = 64) {
  const calls: string[] = [];
  return {
    calls,
    chat: async (prompt: string): Promise<LlmChatResult> => {
      calls.push(prompt);
      return { text: content, tokens };
    },
  };
}

const GOOD_VERDICT = {
  verdict: "tp",
  confidence: 0.9,
  rationale: "多次失败登录后成功，暴力破解证据成立",
  self_audit: { open_cases_checked: 0, host_searched: "centos7", same_host_case_found: false },
  recommended_action: "create_case",
};

function sampleCall(): LlmCall {
  const input: TriageInput = {
    alert: { id: "al_1", title: "sshd: Attempt to login using a non-existent user", severity: 3, tags: [], host: "centos7" },
    untrusted: [{ field: "description", content: "Failed password for root" }],
    kbHits: [],
    merge: { host: "centos7", withinHours: 24, openCasesChecked: 0, sameHostCaseFound: false, candidateCaseId: null },
  };
  return { prompt: buildTriagePrompt(input), input };
}

describe("RealTriageLlm · seam 接口不变（TriageLlm.verdict：text 进 parseVerdict，tokens 进 charge）", () => {
  test("正常回包：text 原样交 parseVerdict（schema 把关仍在 worker），tokens 透传", async () => {
    const chat = fakeChat(JSON.stringify(GOOD_VERDICT), 77);
    const llm = new RealTriageLlm(chat);
    const reply = await llm.verdict(sampleCall());
    const parsed = parseVerdict(reply.text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.verdict.verdict).toBe("tp");
    expect(reply.tokens).toBe(77);
    // prompt 契约文本逐字出域（adapter 不改写 prompt）
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]).toContain("<<<UNTRUSTED field=\"description\">>>");
  });

  test("真模型套 markdown 围栏：剥壳后仍过 schema（prompt 契约要求的 JSON 只输出一次机会不浪费）", async () => {
    const chat = fakeChat("```json\n" + JSON.stringify(GOOD_VERDICT) + "\n```");
    const reply = await new RealTriageLlm(chat).verdict(sampleCall());
    expect(parseVerdict(reply.text).ok).toBe(true);
  });

  test("上游病了（限流/不可达/超时/5xx）→ 不抛：回不合 schema 的标记回包，reason 可读", async () => {
    for (const code of ["rate_limited", "unreachable", "timeout", "http_503"]) {
      const chat = {
        chat: async () => {
          throw new LlmUpstreamError(code);
        },
      };
      const reply = await new RealTriageLlm(chat).verdict(sampleCall());
      const parsed = parseVerdict(reply.text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toBe(`bad_verdict:llm_upstream_${code}`);
      expect(reply.tokens).toBe(0);
    }
  });
});

// ---------- 全链路（真 case-backend + 生产 HttpTriageM2 + mock 上游的 fetch seam） ----------

interface SeenReq { url: string; method: string; body: Record<string, unknown> }

function mockProxyFetch(reply: (body: Record<string, unknown>) => Response) {
  const seen: SeenReq[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return reply(seen[seen.length - 1].body);
  }) as typeof fetch;
  return { impl, seen };
}

describe("全链路 fail-closed（验收④）：上游病了走 worker 降级路径，run 不裸抛、verdict 置 uncertain + human", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  test("gateway 代理 503（fail-closed 口径）× 重试 1 次 → run completed + uncertain + human + llm_retry 审计", async () => {
    const caseBackend = await startCaseBackend();
    closers.push(() => caseBackend.close());
    const db: DB = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const alertId = await seedAlert(caseBackend.url, FIX("ssh-5712-real.json"));

    const { impl, seen } = mockProxyFetch(() => new Response(JSON.stringify({ error: "credential proxy not configured; refuse to forward (fail-closed)" }), { status: 503 }));
    const llm = new RealTriageLlm(new GatewayLlmClient({ baseUrl: "http://gateway-stub:8002/proxy/llm", fetchImpl: impl, requestId: "req-27-degrade", actor: "agent:triage" }));

    const run = createRun(db, { kind: "alert_flow", alertId }, { audit, requestId: "req-27-degrade" });
    const flow = makeTriageFlow({
      runId: run.id, requestId: "req-27-degrade",
      ticket: makeTaskTicket(run.id, [...TRIAGE_TOOLS]),
      hmacKey: KEY, m2: new HttpTriageM2(caseBackend.url), kb: new MemoryKb(), llm, scan: fakeScan, audit,
    });
    const done = await executeRun(db, run.id, { nodes: flow, audit, requestId: "req-27-degrade", hmacKey: KEY });

    // run 活着到达终态：降级路径接管，不裸抛（INV-1 的 deny 语义 = 宁可升级人工不可猜）
    expect(done.status).toBe("completed");
    // 出站确实经 gateway /proxy/llm/* 代理路径（验收①的生产 URL 形态）
    expect(seen.length).toBe(2); // 恰好重试 1 次
    for (const req of seen) {
      expect(req.url).toBe("http://gateway-stub:8002/proxy/llm/v1/chat/completions");
      expect(req.method).toBe("POST");
    }
    // 写回 M2：uncertain + 人工待办；降级理由可读（llm_upstream 标记进了 rationale）
    const alert = await httpJson(caseBackend.url, "GET", `/api/v1/alerts/${alertId}`);
    expect(alert.json.verdict).toBe("uncertain");
    expect(alert.json.status).toBe("InProgress");
    const verdictAi = alert.json.verdictAi as Record<string, unknown>;
    expect(verdictAi.recommended_action).toBe("human");
    expect(String(verdictAi.rationale)).toContain("llm_upstream_http_503");
    // worker 既有审计留痕：重试 1 次 + self_audit checkpoint 照常
    expect(audit.entries.filter((e) => e.action === "llm_retry")).toHaveLength(1);
    expect(audit.entries.some((e) => e.action === "self_audit_checkpoint" && e.result === "SUCCESS")).toBe(true);

    const events: RunEvent[] = eventsAfter(db, run.id, 0);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
