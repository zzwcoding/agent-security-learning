import { afterAll, afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MemoryAuditSink } from "../../src/audit.js";
import type { AnalyzerCall } from "./analyzers.js";
import { MsbAnalyzerBackend, RESULT_MARKER, buildMsbArgs, msbProbe, type MsbRunner } from "./sandbox.js";

// 票 16 主战场：m6 卡 Seam ① 的另一半——analyzer 执行 adapter 的「microsandbox 真跑」侧。
// 默认仍是 FixtureAnalyzerTable（票 15），演示攻击面切到这里。四条验收：
//   ① vt_lookup 在一次性 microVM 里真跑（m6 卡依赖·PRD v1.1 变更 3）
//   ② attack/sandbox/01_poisoned_analyzer：外联 C2 被 egress 拦截（--no-net，宿主侧策略拒绝）
//   ③ 读宿主 env：VM 内凭证不可见（microVM 不继承宿主 env；金丝雀值全链路 grep 不到，INV-4 同款）
//   ④ VM 一次性：跑完即毁无状态残留（msb run 留 stopped 沙箱 → backend finally 显式 remove）
//
// 分层（CI 大概率没有 KVM）：
//   - mock 侧（CI 全绿）：buildMsbArgs 拓扑断言 + 注入 fake runner 的 fail-closed/DENIED 审计
//     行为面 + 攻击 fixture 完整性——测试打在 AnalyzerBackend seam 处，不依赖真 VM。
//   - 真跑侧（本地冒烟）：能力探测（msbProbe）失败 → describe 整体 skip 并打印原因，绝不静默。

const VM_ANALYZERS = fileURLToPath(new URL("./vm-analyzers/", import.meta.url));
const TI = fileURLToPath(new URL("../../../../fixtures/ti/", import.meta.url));
const ATTACK_DIR = fileURLToPath(
  new URL("../../../../fixtures/attack/sandbox/01_poisoned_analyzer/", import.meta.url),
);

const EICAR_SHA256 = "c05640e21ec2b1b4b4101c1a67a1a3c8af7c7ae9b6b98f8b1b1f0e9a2d3c4b5a";
const CALL: AnalyzerCall = { data: EICAR_SHA256, dataType: "hash", tlp: 2, pap: 2 };
const MSB = process.env.MSB_BIN ?? "msb";

/** 真 stdout 里抠 marker 行的解析器与 backend 同源——fake runner 的输出都走它。 */
function vmOut(result: unknown, attempts: unknown[] = []): string {
  return `${RESULT_MARKER}${JSON.stringify({ result, attempts })}\n`;
}

const lastLine = (stdout: string): string => stdout.trim().split("\n").at(-1) ?? "";

describe("buildMsbArgs 拓扑断言（mock 侧：拦截机制长在命令行上，CI 可断言）", () => {
  const args = buildMsbArgs({
    image: "python:3.12",
    name: "enrich-vt_lookup-abc",
    scriptPath: "/abs/vm-analyzers/vt_lookup.py",
    tiDir: TI,
    call: CALL,
    timeoutSecs: 90,
  });

  test("egress 全关：--no-net 在场（外联 C2 的拦截机制，宿主侧策略拒绝，双向 deny）", () => {
    expect(args).toContain("--no-net");
  });

  test("宿主 env 不进 VM：args 里没有任何 -e/--env（凭证不可见的机制面）", () => {
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
  });

  test("一次性：具名沙箱 + 短超时 + 归属标签（remove 由 backend finally 负责，见 fail-closed 组）", () => {
    expect(args).toContain("enrich-vt_lookup-abc");
    const t = args.indexOf("--timeout");
    expect(t).toBeGreaterThan(-1);
    expect(args[t + 1]).toMatch(/^\d+s$/);
    expect(args).toContain("soc-demo=ticket16"); // 清扫用的归属标签
  });

  test("analyzer 脚本与情报表只读挂载进 VM，命令形如 python /srv/analyzer.py '<call>'", () => {
    expect(args).toContain("--copy");
    expect(args).toContain("/abs/vm-analyzers/vt_lookup.py:/srv/analyzer.py");
    expect(args).toContain("--copy-dir");
    expect(args.some((a) => a.startsWith(TI) && a.endsWith(":/srv/ti"))).toBe(true);
    const dd = args.indexOf("--");
    expect(args.slice(dd + 1, dd + 3)).toEqual(["python", "/srv/analyzer.py"]);
    expect(JSON.parse(args[dd + 3])).toEqual(CALL); // 调用四元组原样进 VM
  });
});

describe("fail-closed 与 DENIED 审计（mock 侧：注入 fake runner，INV-1 行为面）", () => {
  const okEnvelope = vmOut({
    success: true,
    summary: { taxonomies: [{ namespace: "VT", predicate: "reputation", value: "5/70", level: "malicious" }] },
    artifacts: [],
  });

  function fakeRunner(responses: Record<string, string>, calls: string[][] = []): MsbRunner {
    return async (args) => {
      calls.push(args);
      if (args[0] === "remove") return { stdout: "" };
      const key = args.find((a) => a.startsWith("/srv/")); // 命令行里的脚本路径区分不同 analyzer
      return { stdout: responses[key ?? "*"] ?? "" };
    };
  }

  afterEach(() => delete process.env.SOC_CANARY_SECRET);

  test("真跑成功路：脚本 stdout 的 marker 包络解析成 AnalyzerResult；跑完 remove -f（跑完即毁）", async () => {
    const audit = new MemoryAuditSink();
    const calls: string[][] = [];
    const backend = new MsbAnalyzerBackend({
      audit,
      requestId: "req-sbx",
      run: fakeRunner({ "/srv/analyzer.py": okEnvelope }, calls),
    });
    const r = await backend.lookup("vt_lookup", CALL);

    expect(r.success).toBe(true);
    expect(r.summary.taxonomies[0]).toMatchObject({ level: "malicious" });
    // 跑完即毁（验收 4 的机制面）：run 之后必跟 remove -f <同一个名字>
    expect(calls.at(-1)?.slice(0, 4)).toEqual(["remove", "-f", calls[0][calls[0].indexOf("--name") + 1], "-q"]);
    expect(audit.entries.filter((e) => e.result === "DENIED")).toHaveLength(0);
  });

  test("VM 崩溃 / 无 marker / 非 JSON → 一律 success:false + FAILURE 审计，且照常 remove（不吞错）", async () => {
    for (const [name, stdout] of [
      ["vm_crash", ""],
      ["no_marker", "all your base are belong to us"],
      ["bad_json", `${RESULT_MARKER}{"result": truncated`],
    ] as const) {
      const audit = new MemoryAuditSink();
      const calls: string[][] = [];
      const backend = new MsbAnalyzerBackend({
        audit,
        requestId: `req-${name}`,
        run: fakeRunner({ "/srv/analyzer.py": stdout }, calls),
      });
      const r = await backend.lookup("vt_lookup", CALL);

      expect(r.success, name).toBe(false);
      expect(r.errorMessage, name).toMatch(/^sandbox_run_failed:/);
      const failure = audit.entries.find((e) => e.result === "FAILURE");
      expect(failure, name).toBeDefined();
      expect(failure).toMatchObject({ action: "sandbox_run_failed", objectType: "analyzer_run" });
      expect(calls.at(-1)?.[0], name).toBe("remove"); // 失败也毁 VM，不留残留
    }
  });

  test("投毒包络：egress 被拦 + env 探测无获 → 两条 DENIED 审计（五要素）；假握手走 breach 分支", async () => {
    const audit = new MemoryAuditSink();
    process.env.SOC_CANARY_SECRET = "canary-16x-never-visible"; // 金丝雀只挂在宿主进程 env 上
    const backend = new MsbAnalyzerBackend({
      audit,
      requestId: "req-attack",
      run: fakeRunner({
        "/srv/analyzer.py": vmOut(
          { success: true, summary: { taxonomies: [] } },
          [
            { kind: "egress", target: "198.51.100.23:4444", blocked: true, errno: 111 },
            { kind: "env_probe", env_keys: ["PATH", "HOME", "LANG"], credential_paths_missing: ["/root/.aws/credentials"] },
          ],
        ),
      }),
    });
    await backend.lookup("vt_lookup", CALL);

    const denied = audit.entries.filter((e) => e.result === "DENIED");
    expect(denied.map((e) => e.action)).toEqual(["sandbox_egress_blocked", "sandbox_env_denied"]);
    for (const e of denied) {
      expect(e.actor).toEqual({ type: "agent", id: "agent:enrichment" }); // 五要素：actor
      expect(e.requestId).toBe("req-attack"); // 五要素：requestId
      expect(typeof e.createdAt).toBe("number"); // 五要素：when
      expect(e.objectType).toBe("analyzer_run"); // 五要素：object
      expect(e.objectId).toMatch(/^enrich-vt_lookup-/); // 五要素：objectId = 沙箱名
    }
    expect(denied[0].details).toMatchObject({ analyzer: "vt_lookup", target: "198.51.100.23:4444", errno: 111 });
    expect(denied[1].details).toMatchObject({ analyzer: "vt_lookup", env_keys: 3 });

    // 反向：假握手（blocked:false）是破绽不是拦截 → FAILURE 级 breach 审计（审计不说谎）
    const breach = new MemoryAuditSink();
    const breachBackend = new MsbAnalyzerBackend({
      audit: breach,
      requestId: "req-breach",
      run: fakeRunner({
        "/srv/analyzer.py": vmOut(
          { success: true, summary: { taxonomies: [] } },
          [{ kind: "egress", target: "198.51.100.23:4444", blocked: false, errno: 0 }],
        ),
      }),
    });
    await breachBackend.lookup("vt_lookup", CALL);
    expect(breach.entries.find((e) => e.action === "sandbox_egress_breach")?.result).toBe("FAILURE");
  });

  test("脚本缺失（ip_reputation 未提供真跑脚本）→ fail-closed 拒绝，不开 VM", async () => {
    const audit = new MemoryAuditSink();
    const calls: string[][] = [];
    const backend = new MsbAnalyzerBackend({ audit, requestId: "req-missing", run: fakeRunner({}, calls) });
    const r = await backend.lookup("ip_reputation", { data: "18.18.18.18", dataType: "ip", tlp: 2, pap: 2 });

    expect(r.success).toBe(false);
    expect(r.errorMessage).toBe("sandbox_run_failed:script_missing:ip_reputation");
    expect(calls).toHaveLength(0); // 没脚本就不该拉 VM
    expect(audit.entries[0]).toMatchObject({ action: "sandbox_run_failed", result: "FAILURE" });
  });
});

describe("攻击 fixture 完整性（mock 侧：attack/sandbox/01 的实体载荷与场景清单）", () => {
  test("场景清单 + 投毒脚本在场，载荷三件套（外联 C2 / 读宿主 env / 落残留）与 m6 卡测试计划一致", async () => {
    const scenario = JSON.parse(await readFile(`${ATTACK_DIR}scenario.json`, "utf8"));
    expect(scenario.id).toBe("attack/sandbox/01_poisoned_analyzer");
    expect(scenario.expected).toMatchObject({ egress: "blocked", env: "invisible", residue: "none" });

    const poisoned = await readFile(`${ATTACK_DIR}analyzer.py`, "utf8");
    expect(poisoned).toContain("198.51.100.23"); // C2 目标（fixtures 惯例 TEST-NET-2）
    expect(poisoned).toContain("connect_ex"); // 外联尝试
    expect(poisoned).toContain("environ"); // 宿主 env 探测
    expect(poisoned).toContain("/tmp/pwned"); // 持久化残留尝试
  });

  test("投毒件不进生产脚本目录：vm-analyzers/ 只有具名真跑 analyzer（clean separation）", async () => {
    expect((await readdir(VM_ANALYZERS)).sort()).toEqual(["vt_lookup.py"]);
  });
});

// ---------- 真跑侧（能力探测：有 microVM 环境才跑真断言，否则显式 skip 并打印原因） ----------

const probe = await msbProbe();
if (!probe.ok) console.warn(`[票 16 真跑 skip] ${probe.reason}`);

describe.skipIf(!probe.ok)("microsandbox 真跑（本地冒烟：验收 1-4 的真断言）", { timeout: 300_000 }, () => {
  const CANARY = "soc-canary-secret-16x-never-leaks";
  const msb = promisify(execFile);
  const sandboxNames = async (): Promise<string[]> => {
    const { stdout } = await msb(MSB, ["list"]);
    return stdout
      .split("\n")
      .slice(1) // 跳过表头 NAME IMAGE STATUS CREATED
      .map((l) => l.trim().split(/\s{2,}/)[0])
      .filter((n) => n && n.length > 0);
  };

  afterAll(async () => {
    delete process.env.SOC_CANARY_SECRET;
    // 测试自清：按归属标签清扫任何残留沙箱
    await msb(MSB, ["remove", "--label", "soc-demo=ticket16", "--force", "--quiet"]).catch(() => {});
  });

  test("验收 1：vt_lookup 在一次性 microVM 真跑——真脚本真执行，结果与情报表同源", async () => {
    process.env.SOC_CANARY_SECRET = CANARY;
    const audit = new MemoryAuditSink();
    const backend = new MsbAnalyzerBackend({ audit, requestId: "req-real" });
    const r = await backend.lookup("vt_lookup", CALL);

    expect(r.success).toBe(true);
    expect(r.summary.taxonomies).toEqual([
      { namespace: "VT", predicate: "reputation", value: "5/70", level: "malicious" },
    ]);
    expect(r.full).toMatchObject({ positives: 5, total: 70 });
    expect(r.artifacts).toEqual([{ dataType: "filename", data: "invoice_apr.zip" }]);
    expect(audit.entries.filter((e) => e.result !== "SUCCESS")).toHaveLength(0);
  });

  test("验收 2+3：attack/sandbox/01 投毒 analyzer——外联 C2 被拦 + 宿主凭证不可见 + 双 DENIED 审计", async () => {
    process.env.SOC_CANARY_SECRET = CANARY; // 金丝雀挂在宿主进程 env——msb 子进程带着它，VM 也看不见
    const audit = new MemoryAuditSink();
    const backend = new MsbAnalyzerBackend({
      audit,
      requestId: "req-attack-real",
      scriptFor: () => `${ATTACK_DIR}analyzer.py`, // 攻击面切真跑：沙箱里换上投毒 analyzer
    });
    const r = await backend.lookup("vt_lookup", CALL);

    // 投毒 analyzer 表面照常出结果（毒不出在结果上，出在动作上）
    expect(r.success).toBe(true);

    const denied = audit.entries.filter((e) => e.result === "DENIED");
    expect(denied.map((e) => e.action)).toEqual(["sandbox_egress_blocked", "sandbox_env_denied"]);
    expect(denied[0].details).toMatchObject({ target: "198.51.100.23:4444", errno: 111 }); // 宿主侧策略拒绝
    expect((denied[1].details as { env_keys: number }).env_keys).toBeLessThan(20); // VM 只有镜像最小 env

    // 独立度量（不信投毒者的自白）：我方探针进同策略 VM 复测 egress/env 两件事
    const probeScript = [
      "import json,os,socket",
      "s=socket.socket();s.settimeout(5)",
      "print(json.dumps({'errno':s.connect_ex(('198.51.100.23',4444)),",
      "'canary':[v for v in os.environ.values() if 'never-leaks' in v],",
      "'canary_key':os.environ.get('SOC_CANARY_SECRET')}))",
    ].join("\n");
    const { stdout } = await msb(MSB, [
      "run", "python:3.12", "--no-net", "--no-tty", "-q", "--timeout", "60s",
      "--label", "soc-demo=ticket16", "--", "python", "-c", probeScript,
    ]);
    const measured = JSON.parse(lastLine(stdout));
    expect(measured.errno).not.toBe(0); // C2 真被拦（对照实验：无 --no-net 时 errno=0，已另行人工验证）
    expect(measured.canary).toEqual([]); // 金丝雀值不在 VM env 里
    expect(measured.canary_key).toBeNull();
  });

  test("验收 4：VM 一次性——跑完即毁无残留（list 无沙箱 + 新 VM 看不到上一台的 /tmp/pwned）", async () => {
    const audit = new MemoryAuditSink();
    const backend = new MsbAnalyzerBackend({
      audit,
      requestId: "req-residue",
      scriptFor: () => `${ATTACK_DIR}analyzer.py`, // 投毒脚本会写 /tmp/pwned
    });
    await backend.lookup("vt_lookup", CALL);

    // 跑完即毁：backend finally remove 后，机器上没有这台沙箱
    expect((await sandboxNames()).filter((n) => n.startsWith("enrich-"))).toEqual([]);

    // 无状态残留：全新 VM 里 /tmp/pwned 不存在（上一台的写盘没跨过 VM 边界）
    const { stdout } = await msb(MSB, [
      "run", "python:3.12", "--no-net", "--no-tty", "-q", "--timeout", "60s",
      "--label", "soc-demo=ticket16", "--", "python", "-c",
      "import os,json;print(json.dumps({'pwned':os.path.exists('/tmp/pwned')}))",
    ]);
    expect(JSON.parse(lastLine(stdout)).pwned).toBe(false);
  });
});

// 兜底观察面：CI（无 msb）也要把「为什么 skip」说在明面上，不静默降级
describe("能力探测可观察", () => {
  test("msbProbe 返回形状良定：有 microVM 环境 ok:true，否则带原因 ok:false", () => {
    if (!probe.ok) {
      console.warn(`[票 16 真跑 skip] ${probe.reason}`);
      expect(probe.reason).toMatch(/\S/);
    } else {
      expect(probe).toEqual({ ok: true });
    }
  });
});
