// 票 27：换闸适配层契约测试——「包真值 → 闸判定」映射逐条钉死（设计文档 §5 验收第 3 条）。
// 与 verify-ticket.test.ts 分工：那边钉 soc 契约行为（断言零改动照跑），这边钉「闸真在用包」
// 与「包的语义缺口被适配层堵住」两件事：
//   ① 安全回归锁——包 verifyToken 审批分支不查 tool（包 token.ts:103-109），「错工具+对参数」
//      裸跑会 allow；闸的 p.tool 自查被删掉时本文件第一条断言立刻翻红（L0 安全注记）。
//   ② 包真函数被调用的证据——vi.mock 以真实现包装成 spy（行为不变、只记调用），
//      闸若退回本地实现，调用计数断言翻红（L0④「真调用包，依赖躺着不算数」）。
//   ③ §4.2 各不保真点负例钉死：形状先于 exp / 未登记 no_ticket / 焚毁桥接与炸表 / 双 hash 等价。
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import * as guard from "@agentjiaotu/agent-guard";
import { MemoryBurnRegistry, paramsHash, verifyTicket, type VerifyCtx } from "./verify-ticket.js";

// 证据 spy：包装包真函数（真实现原样执行），不替换任何行为——只留调用痕迹。
// 若适配层哪天不再 import 本包（退回本地六判据），下面 mock.calls 计数断言翻红。
vi.mock("@agentjiaotu/agent-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentjiaotu/agent-guard")>();
  return {
    ...actual,
    verifyToken: vi.fn(actual.verifyToken),
    verifyTokenSignature: vi.fn(actual.verifyTokenSignature),
    paramsHash: vi.fn(actual.paramsHash),
  };
});

const FIXTURES = new URL("../../../fixtures/tickets/", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("contract.json", FIXTURES), "utf8")) as {
  hmac_key: { value: string };
  cases: { fixture: string }[];
};
const KEY = contract.hmac_key.value;
const OPTS = { hmacKey: KEY };

interface Fixture {
  fixture: string;
  type: "task_ticket" | "approval_token";
  token: string;
  payload: Record<string, unknown>;
  verify_now: number;
  probe: { tool: string; params: unknown };
  expected: { allow: boolean; reason: string };
  burn?: { registry: string; jti: string; note: string };
}

function loadFixture(rel: string): Fixture {
  return JSON.parse(readFileSync(new URL(`${rel}.json`, FIXTURES), "utf8")) as Fixture;
}

/** 诚实运行时上下文（与 verify-ticket.test.ts 同法：案件/run 取自票自身，burn 节预登记）。 */
function ctxFor(fx: Fixture): VerifyCtx {
  const used = new MemoryBurnRegistry();
  if (fx.burn) used.burn(fx.burn.jti);
  return fx.type === "task_ticket"
    ? { ticket: fx.token, used, caseId: fx.payload.case_id as string, runId: fx.payload.run_id as string }
    : { approvalToken: fx.token, used, caseId: fx.payload.case_id as string };
}

// ---------- ①映射：9 张契约 fixture 逐张 = 包 verifyToken 裸跑 ≡ 闸判定 ----------

test("包真值→闸判定映射：九张 fixture 的包裸跑结果与闸 verdict 逐一相等（设计 §5 验收）", () => {
  const checked: string[] = [];
  for (const c of contract.cases) {
    const fx = loadFixture(c.fixture);
    // 包裸跑：票面六判据的消费口本尊（isBurned 同一焚毁表现场，params/tool 按票型二选一）
    const used = new MemoryBurnRegistry();
    if (fx.burn) used.burn(fx.burn.jti);
    const rawOpts =
      fx.type === "task_ticket"
        ? { tool: fx.probe.tool, now: fx.verify_now, isBurned: (jti: string) => used.has(jti) }
        : { params: fx.probe.params, now: fx.verify_now, isBurned: (jti: string) => used.has(jti) };
    const raw = guard.verifyToken(KEY, fx.token, rawOpts);
    const gated = verifyTicket(
      { name: fx.probe.tool, params: fx.probe.params },
      ctxFor(fx),
      fx.verify_now, // 冻结时钟：契约禁 wall clock
      OPTS,
    );
    expect([fx.fixture, raw.allow, raw.reason]).toEqual([fx.fixture, gated.allow, gated.reason]);
    expect([fx.fixture, gated.allow, gated.reason]).toEqual([fx.fixture, fx.expected.allow, fx.expected.reason]);
    checked.push(fx.fixture);
  }
  expect(checked).toHaveLength(9);
});

// ---------- ②安全回归锁（L0 安全注记）：包审批分支不查 tool，闸必须自查 ----------

describe("安全回归锁：审批票 tool 绑定是闸的自查判据，不是包送的", () => {
  test("错工具+对参数 → 403 scope_insufficient（包 verifyToken 同输入裸跑会 allow——自查删了就放行）", () => {
    const fx = loadFixture("approval-token/valid");
    const gated = verifyTicket(
      { name: "block_ip", params: { host: "web-01" } }, // 工具不是票铸给的那个（票铸给 isolate_host）
      { approvalToken: fx.token, used: new MemoryBurnRegistry(), caseId: fx.payload.case_id as string },
      fx.verify_now,
      OPTS,
    );
    expect(gated).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });

    // 对比证据：同票同参数裸跑包 verifyToken——其审批分支只比对 params_hash，今天放行。
    // 本行钉住「洞在包侧真实存在」；若 jiaotu 将来给该分支补 tool 判据，仅需复核此行，
    // 上面闸判定断言（真正的锁）任何情况下不许翻绿为 allow。
    const raw = guard.verifyToken(KEY, fx.token, { params: { host: "web-01" }, now: fx.verify_now });
    expect(raw.allow).toBe(true);
  });

  test("错参数+错工具 → 仍是 403（tool 自查先于 params_hash，soc 序不变）", () => {
    const fx = loadFixture("approval-token/valid");
    const gated = verifyTicket(
      { name: "block_ip", params: { host: "web-99" } },
      { approvalToken: fx.token, used: new MemoryBurnRegistry(), caseId: fx.payload.case_id as string },
      fx.verify_now,
      OPTS,
    );
    expect(gated).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
  });
});

// ---------- ③包真函数被调用的证据（L0④：真调用，依赖躺着不算数） ----------

test("闸真在调包：L1 路径走 verifyToken、L2 路径走 verifyTokenSignature+paramsHash（真实现 spy 计数）", () => {
  const tk = loadFixture("task-ticket/valid");
  const ap = loadFixture("approval-token/valid");

  const vBefore = vi.mocked(guard.verifyToken).mock.calls.length;
  verifyTicket({ name: tk.probe.tool, params: tk.probe.params }, ctxFor(tk), tk.verify_now, OPTS);
  expect(vi.mocked(guard.verifyToken).mock.calls.length).toBe(vBefore + 1);

  const sBefore = vi.mocked(guard.verifyTokenSignature).mock.calls.length;
  const hBefore = vi.mocked(guard.paramsHash).mock.calls.length;
  verifyTicket({ name: ap.probe.tool, params: ap.probe.params }, ctxFor(ap), ap.verify_now, OPTS);
  expect(vi.mocked(guard.verifyTokenSignature).mock.calls.length).toBe(sBefore + 1);
  expect(vi.mocked(guard.paramsHash).mock.calls.length).toBe(hBefore + 1);

  // spy 包装的是包本体真实现（非空壳）：py 锚点值原样吐出
  expect(guard.paramsHash({ host: "web-01" })).toBe(
    "sha256:b8dc6b29e602f0370245ed2449c48513e42291badd351f1aceaccf57707c3aa2",
  );
});

// ---------- ④§4.2 不保真点负例钉死 ----------

describe("适配层负例（设计 §4.2 逐点）", () => {
  test("形状闸时序（§4.2-1）：签名合法但缺 claim 且已过期 → signature_invalid（soc 形状先于 exp，非 token_expired）", () => {
    const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const b64p = b64u(JSON.stringify({ exp: 1000 })); // 已过期 + 缺 jti/sub/... 全部 claim
    const unsigned = `eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.${b64p}`;
    const sig = createHmac("sha256", Buffer.from(KEY, "utf8")).update(unsigned, "utf8").digest("hex");
    const token = `${unsigned}.${sig}`;
    const gated = verifyTicket({ name: "create_case", params: {} }, { ticket: token }, 1757000100, OPTS);
    expect(gated).toEqual({ allow: false, code: 403, reason: "signature_invalid" });
    // 对比：包裸跑的 exp 判据内嵌于验签，同输入给 token_expired——时序差被 soc 形状预闸抹平
    expect(guard.verifyTokenSignature(KEY, token, 1757000100)).toEqual({ ok: false, reason: "token_expired" });
  });

  test("未登记工具无票 → no_ticket（红线②：包闸「未收录→scope_insufficient」语义不被引入）", () => {
    const r = verifyTicket({ name: "definitely_not_registered_tool", params: {} }, {}, 1757000100, OPTS);
    expect(r).toEqual({ allow: false, code: 403, reason: "no_ticket" });
  });

  test("焚毁桥接（§4.2-3 反面）：BurnRegistry.has → 包 isBurned，已焚 jti 走包判据落 token_used（闸内零焚毁）", () => {
    const fx = loadFixture("task-ticket/valid");
    const used = new MemoryBurnRegistry();
    used.burn(fx.payload.jti as string);
    const r = verifyTicket(
      { name: fx.probe.tool, params: fx.probe.params },
      { ticket: fx.token, used, caseId: fx.payload.case_id as string, runId: fx.payload.run_id as string },
      fx.verify_now,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "token_used" });
  });

  test("焚毁表炸在包 isBurned 回调里 → INV-1 signature_invalid（依赖炸了绝不放行，异常穿包回闸收口）", () => {
    const fx = loadFixture("task-ticket/valid");
    const boom = { has: () => { throw new Error("m2 down"); } };
    const r = verifyTicket(
      { name: fx.probe.tool, params: fx.probe.params },
      { ticket: fx.token, used: boom, caseId: fx.payload.case_id as string, runId: fx.payload.run_id as string },
      fx.verify_now,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "signature_invalid" });
  });

  test("双 paramsHash 等价（§4.2-2）：闸内比对用包 hash 与 soc 导出面在 JSON 域逐字节一致（py 锚点同源）", () => {
    const samples: unknown[] = [
      { host: "web-01" },
      { host: "web-01", cfg: { z: 1, a: [1, 2, "中"] } },
      {},
      { b: 2, a: 1 },
      [3, 1, 2],
      "scalar-string",
    ];
    for (const s of samples) expect(guard.paramsHash(s)).toBe(paramsHash(s));
  });
});
