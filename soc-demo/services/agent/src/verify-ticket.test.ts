// 票 07：m9 验票闸 verifyTicket 的测试——六条验收逐条落在这里。
// 数据只有一份：fixtures/tickets/ 契约（与 py 铸票侧同一组，m9 卡 Seam）。
// 时钟纪律（contract.json clock policy）：一律注入 fixture 的 verify_now，禁 wall clock；
// 测试密钥从 contract.json 的 hmac_key 机读源读，不在代码里复制字符串（README 约定）。
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import {
  MemoryBurnRegistry,
  paramsHash,
  verifyTicket,
  type VerifyCtx,
} from "./verify-ticket.js";

const FIXTURES = new URL("../../../fixtures/tickets/", import.meta.url); // src → soc-demo/fixtures/tickets
const contract = JSON.parse(readFileSync(new URL("contract.json", FIXTURES), "utf8")) as {
  hmac_key: { value: string };
  cases: { fixture: string }[];
};
const KEY = contract.hmac_key.value;
const OPTS = { hmacKey: KEY };

interface Fixture {
  fixture: string;
  type: "task_ticket" | "approval_token";
  class: string;
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

/** 按票面造「诚实运行时」上下文：当前案件/run 取自票自身（合法铸票时本就同源）、
 *  已焚毁 fixture 按 burn 节预先登记（重放现场）。 */
function ctxFor(fx: Fixture): VerifyCtx {
  const used = new MemoryBurnRegistry();
  if (fx.burn) used.burn(fx.burn.jti);
  return fx.type === "task_ticket"
    ? {
        ticket: fx.token,
        used,
        caseId: fx.payload.case_id as string,
        runId: fx.payload.run_id as string,
      }
    : { approvalToken: fx.token, used, caseId: fx.payload.case_id as string };
}

// ---------- 验收 4：TS 侧对 fixtures/tickets/ 契约测试全过（与 py 侧同一组） ----------

test("契约表九张 fixture 逐张跑，期望结果与 gateway py 侧同一组（m9 卡 Seam）", () => {
  const checked: string[] = [];
  for (const c of contract.cases) {
    const fx = loadFixture(c.fixture);
    const r = verifyTicket(
      { name: fx.probe.tool, params: fx.probe.params },
      ctxFor(fx),
      fx.verify_now, // 冻结时钟：契约禁 wall clock
      OPTS,
    );
    expect([fx.fixture, r.allow, r.reason]).toEqual([fx.fixture, fx.expected.allow, fx.expected.reason]);
    checked.push(fx.fixture);
  }
  expect(checked).toHaveLength(9);
});

test("params_hash 与 py 逐字节一致（跨语言锚点：嵌套键排序 + 非 ASCII + 空参）", () => {
  // 第一枚 = approval-token/valid 票内的 params_hash（py 铸票侧铸出的指纹）
  expect(paramsHash({ host: "web-01" })).toBe(
    "sha256:b8dc6b29e602f0370245ed2449c48513e42291badd351f1aceaccf57707c3aa2",
  );
  // 嵌套对象键序 + 数组保序 + 中文（ensure_ascii=False 对位）：期望值由 py
  // json.dumps(sort_keys=True, separators=(",",":")) 同参计算得出
  expect(paramsHash({ host: "web-01", cfg: { z: 1, a: [1, 2, "中"] } })).toBe(
    "sha256:83c8a311b0400d9440c4b06680bbbb9d039ed5366d898024ee65207fb3f8c4a0",
  );
  expect(paramsHash({})).toBe(
    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
});

// ---------- 验收 1：六种 403 reason 逐一可见（PRD FR-S2.2·m9 卡公开接口） ----------

describe("六种 403 reason（FR-S2.2 枚举）", () => {
  const cases: { reason: string; toolCall: { name: string; params: unknown }; ctx: VerifyCtx; now?: number }[] = [
    { reason: "no_ticket", toolCall: { name: "create_case", params: {} }, ctx: {} },
    {
      reason: "scope_insufficient", // L1 任务票永不含 L2 工具（INV-3）
      toolCall: { name: "isolate_host", params: {} },
      ctx: ctxFor(loadFixture("task-ticket/scope-insufficient")),
    },
    {
      reason: "token_expired",
      toolCall: { name: "create_case", params: {} },
      ctx: ctxFor(loadFixture("task-ticket/expired")),
      now: loadFixture("task-ticket/expired").verify_now,
    },
    {
      reason: "token_used",
      toolCall: { name: "create_case", params: {} },
      ctx: ctxFor(loadFixture("task-ticket/burned")),
      now: loadFixture("task-ticket/burned").verify_now,
    },
    {
      reason: "params_mismatch",
      toolCall: { name: "isolate_host", params: { host: "web-02" } },
      ctx: ctxFor(loadFixture("approval-token/params-tampered")),
      now: loadFixture("approval-token/params-tampered").verify_now,
    },
    { reason: "require_approval", toolCall: { name: "isolate_host", params: { host: "web-01" } }, ctx: {} },
  ];
  for (const c of cases) {
    test(`403 ${c.reason}`, () => {
      const fx = c.ctx.ticket ?? c.ctx.approvalToken;
      const now = c.now ?? (fx ? loadFixture("task-ticket/valid").verify_now : 1757000100);
      const r = verifyTicket(c.toolCall, c.ctx, now, OPTS);
      expect(r).toEqual({ allow: false, code: 403, reason: c.reason });
    });
  }

  test("L0 只读工具免验：无票直接放行（FR-S2.1 分级的另一面）", () => {
    const r = verifyTicket({ name: "siem_query", params: { q: "ssh" } }, {}, 1757000100, OPTS);
    expect(r.allow).toBe(true);
  });
});

// ---------- 验收 2：已焚 jti 重放第二次 403 token_used（m9 卡测试计划·INV-2） ----------

test("重放：第一次 allow → 执行后焚毁登记 → 第二次 403 token_used（INV-2 一次性）", () => {
  const fx = loadFixture("approval-token/valid");
  const used = new MemoryBurnRegistry();
  const ctx: VerifyCtx = { approvalToken: fx.token, used, caseId: fx.payload.case_id as string };
  const probe = { name: "isolate_host", params: { host: "web-01" } } as const;

  const first = verifyTicket(probe, ctx, fx.verify_now, OPTS);
  if (!first.allow || !first.payload) throw new Error(`首验应当放行，却得到 ${JSON.stringify(first)}`);
  expect(first.payload.jti).toBe(fx.payload.jti);

  used.burn(first.payload.jti); // 执行成功后登记焚毁（生产 = M2 used_tokens，票 03 接口）

  const second = verifyTicket(probe, ctx, fx.verify_now, OPTS);
  expect(second).toEqual({ allow: false, code: 403, reason: "token_used" });
});

// ---------- 验收 3：伪造审批文本（消息里「已批准」无 token）→ 403（m9 卡测试计划·INV-9） ----------

test("伪造审批文本：闸只认签名 ApprovalToken，不信任何文本（INV-9 验签不信文本）", () => {
  // verifyTicket 的入参里根本没有「消息历史」的位置——文本无处可递，唯一依据是 ctx.approvalToken
  const bare = verifyTicket(
    { name: "isolate_host", params: { host: "web-01" } },
    {}, // 就算历史里写着「值班长已批准」，闸看到的只是：L2 工具、没有审批铸票
    1757000060,
    OPTS,
  );
  expect(bare).toEqual({ allow: false, code: 403, reason: "require_approval" });

  // 手里攥着 L1 任务票 + 一句「已批准」也不行：闸只验票，任务票物理上不含 L2 工具（INV-3）
  const tk = loadFixture("task-ticket/valid");
  const withTicket = verifyTicket(
    { name: "isolate_host", params: { host: "web-01" } },
    { ticket: tk.token, caseId: tk.payload.case_id as string, runId: tk.payload.run_id as string },
    tk.verify_now,
    OPTS,
  );
  expect(withTicket).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
});

// ---------- FR-S2.2 的 case/run 绑定（票面 What-to-build 明列） ----------

describe("case/run 绑定：票不是万能通行证，只对本票的案件/run 生效", () => {
  const tk = loadFixture("task-ticket/valid");
  const ap = loadFixture("approval-token/valid");
  const probeTk = { name: "create_case", params: {} } as const;

  test("任务票 case_id 对不上当前案件 → 403 scope_insufficient", () => {
    const r = verifyTicket(
      probeTk,
      {
        ticket: tk.token,
        caseId: "case_000099", // 换了个案件
        runId: tk.payload.run_id as string,
      },
      tk.verify_now,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
  });

  test("任务票 run_id 对不上当前 run → 403 scope_insufficient", () => {
    const r = verifyTicket(
      probeTk,
      {
        ticket: tk.token,
        caseId: tk.payload.case_id as string,
        runId: "run_别的run", // 换了个 run
      },
      tk.verify_now,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
  });

  test("ApprovalToken case_id 对不上 → 403 scope_insufficient", () => {
    const r = verifyTicket(
      { name: "isolate_host", params: { host: "web-01" } },
      { approvalToken: ap.token, caseId: "case_000099" },
      ap.verify_now,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
  });

  test("对得上 → allow（同契约 valid 场景互证）", () => {
    const r = verifyTicket(
      probeTk,
      {
        ticket: tk.token,
        caseId: tk.payload.case_id as string,
        runId: tk.payload.run_id as string,
      },
      tk.verify_now,
      OPTS,
    );
    expect(r.allow).toBe(true);
  });
});

// ---------- 验收 5：验票延迟实测 ≤5ms（m9 卡测试计划） ----------

test("验票延迟实测 ≤5ms（任务票与 ApprovalToken 两条路径，冻结时钟热循环）", () => {
  const tk = loadFixture("task-ticket/valid");
  const ap = loadFixture("approval-token/valid");
  const tkCtx = ctxFor(tk);
  const apCtx = ctxFor(ap);
  const tkProbe = { name: "create_case", params: {} } as const;
  const apProbe = { name: "isolate_host", params: { host: "web-01" } } as const;

  for (let i = 0; i < 200; i++) {
    verifyTicket(tkProbe, tkCtx, tk.verify_now, OPTS); // 预热，排除首跑抖动
    verifyTicket(apProbe, apCtx, ap.verify_now, OPTS);
  }
  const N = 2000;
  const bench = (probe: { name: string; params: unknown }, ctx: VerifyCtx, now: number) => {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) verifyTicket(probe, ctx, now, OPTS);
    return (performance.now() - t0) / N;
  };
  const tkAvg = bench(tkProbe, tkCtx, tk.verify_now);
  const apAvg = bench(apProbe, apCtx, ap.verify_now);
  console.log(
    `验票闸延迟实测（${N} 次/路径）：task_ticket avg=${tkAvg.toFixed(4)}ms · approval_token avg=${apAvg.toFixed(4)}ms`,
  );
  expect(tkAvg).toBeLessThanOrEqual(5);
  expect(apAvg).toBeLessThanOrEqual(5);
});

// ---------- 验收 6：验票服务自身异常一律 403（INV-1 fail-closed） ----------

describe("fail-closed：闸自己病了也不放行（INV-1）", () => {
  test.each(["", "not-a-token", "a.b", "x.y.z", "###.###.###", ".."])(
    "坏票 %j → 403 signature_invalid（格式/解码/JSON 坏全部归第一关）",
    (token) => {
      const r = verifyTicket({ name: "create_case", params: {} }, { ticket: token }, 1757000100, OPTS);
      expect(r).toEqual({ allow: false, code: 403, reason: "signature_invalid" });
    },
  );

  test("签名合法但 payload 缺字段 → 403（TS 的 undefined 不会自己炸，闸显式把关）", () => {
    // 现场封一张「签名对、票体是空对象」的票（造新票面测试负向用例，非重签 fixture）
    const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const b64p = b64u(JSON.stringify({}));
    const unsigned = `eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.${b64p}`;
    const sig = createHmac("sha256", Buffer.from(KEY, "utf8")).update(unsigned, "utf8").digest("hex");
    const r = verifyTicket(
      { name: "create_case", params: {} },
      { ticket: `${unsigned}.${sig}` },
      1757000100,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "signature_invalid" });
  });

  test("焚毁表查询自身抛异常（M2 不可用）→ 403，依赖炸了绝不放行", () => {
    const fx = loadFixture("task-ticket/valid");
    const boom = { has: () => { throw new Error("m2 down"); } };
    const r = verifyTicket(
      { name: "create_case", params: {} },
      { ticket: fx.token, used: boom, caseId: fx.payload.case_id as string },
      fx.verify_now,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "signature_invalid" });
  });

  test("HMAC 密钥未配置 → 403（与 gateway 铸票缺密钥拒签同一口径）", () => {
    const saved = process.env.SOC_HMAC_KEY;
    delete process.env.SOC_HMAC_KEY;
    try {
      const fx = loadFixture("task-ticket/valid");
      const r = verifyTicket(
        { name: "create_case", params: {} },
        { ticket: fx.token },
        fx.verify_now,
      ); // 不传 opts.hmacKey，逼闸走 env 分支
      expect(r).toEqual({ allow: false, code: 403, reason: "signature_invalid" });
    } finally {
      if (saved !== undefined) process.env.SOC_HMAC_KEY = saved;
    }
  });

  test("参数无法规范化（循环引用）→ 403（ApprovalToken 路径的 hash 计算炸了也不放行）", () => {
    const ap = loadFixture("approval-token/valid");
    const evil: Record<string, unknown> = { host: "web-01" };
    evil.self = evil; // 循环引用：canonicalJson 必炸
    const r = verifyTicket(
      { name: "isolate_host", params: evil },
      { approvalToken: ap.token, caseId: ap.payload.case_id as string },
      ap.verify_now,
      OPTS,
    );
    expect(r).toEqual({ allow: false, code: 403, reason: "signature_invalid" });
  });
});
