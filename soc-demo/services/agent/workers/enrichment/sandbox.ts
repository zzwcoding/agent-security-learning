// m6 富化 worker · analyzer 执行 adapter 的「microsandbox 真跑」侧（票 16）。
//
// m6 卡 Seam ①：analyzer 执行 = adapter 双实现——FixtureAnalyzerTable（票 15，默认）
// / MsbAnalyzerBackend（本文件，演示攻击面切真跑）。两者都实现 AnalyzerBackend，
// flow（票 15）零改动：_deps.analyzers_ 换实现即切。
//
// 真跑的形状（PRD v1.1 变更 3「analyzer 按 Cortex 真实架构以可执行脚本形态存在」）：
//   每次 lookup 拉起一台一次性 microVM（msb run，本机 libkrun，非常驻服务），
//   analyzer 脚本 + 情报表只读挂进 VM，脚本真执行、真吐 Cortex 返回契约，跑完即毁。
//   情报源以文件挂载而非 HTTP：egress 全关（--no-net），所以正常 analyzer 也无需外联——
//   「能干活」与「能外联」在这台 VM 里是两件事，这正是第四攻击面要演示的。
//
// 沙箱边界的三道闸（对应票 16 验收 ②③④）：
//   egress  —— msb --no-net：宿主侧网络栈双向 deny，VM 里 connect_ex 立即 errno=111
//             （对照实验：无此旗标的 VM 用户态网络栈会假握手 errno=0——拦截真来自旗标）
//   env     —— microVM 不继承宿主 env：msb 进程 env 里挂金丝雀（INV-4 同款），VM 里 grep 不到
//   一次性  —— msb run 跑完会留 stopped 沙箱，所以 backend 在 finally 里 msb remove -f，
//             失败路径也毁（不留残留），remove 失败本身记 FAILURE 审计
//
// VM 侧协议：analyzer 脚本往 stdout 打一行 `<<ANALYZER_RESULT>>{result, attempts}`——
// result 照 Cortex 返回契约；attempts 是沙箱遥测（egress/env 探测），backend 据此记
// DENIED/breach 审计。审计不依赖投毒脚本的自白：blocked:false 会被记成 breach 而非拦截。
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AuditSink } from "../../src/audit.js";
import type { AnalyzerBackend, AnalyzerCall, AnalyzerName, AnalyzerResult } from "./analyzers.js";

const execFile = promisify(execFileCb);

/** VM 侧协议 marker：analyzer 脚本的 stdout 里，结果 JSON 挂在这行标记后面。 */
export const RESULT_MARKER = "<<ANALYZER_RESULT>>";

/** 默认镜像：python:3.12（真跑 analyzer 的运行时；新机器先 `msb pull python:3.12`）。 */
export const DEFAULT_IMAGE = "python:3.12";

export interface MsbArgsSpec {
  image: string;
  /** 沙箱名（一次性；remove 按名拆）。 */
  name: string;
  /** 宿主侧 analyzer 脚本路径（--copy 成 VM 内 /srv/analyzer.py）。 */
  scriptPath: string;
  /** 宿主侧情报表目录（--copy-dir 只读挂成 VM 内 /srv/ti）。 */
  tiDir: string;
  call: AnalyzerCall;
  timeoutSecs: number;
}

/** msb 命令行拓扑（纯函数）：拦截机制全部长在参数上——--no-net 关 egress、无 -e/--env
 *  即宿主 env 不进 VM、--timeout 兜底短命、具名 + 归属标签供清扫。CI 没有真 VM，
 *  但这张「命令行的形状」是可断言的拓扑承诺。 */
export function buildMsbArgs(spec: MsbArgsSpec): string[] {
  return [
    "run",
    spec.image,
    "--name",
    spec.name,
    "--no-net", // egress 全关（第四攻击面的拦截机制，宿主侧策略拒绝、双向 deny）
    "--no-tty",
    "-q",
    "--label",
    "soc-demo=ticket16", // 归属标签：测试/运维按标签清扫残留沙箱
    "--timeout",
    `${spec.timeoutSecs}s`, // 兜底短命：analyzer 挂死也不许占着 VM
    "--copy",
    `${spec.scriptPath}:/srv/analyzer.py`,
    "--copy-dir",
    `${spec.tiDir}:/srv/ti`,
    "--",
    "python",
    "/srv/analyzer.py",
    JSON.stringify(spec.call), // Cortex 调用四元组原样进 VM
  ];
}

/** msb 执行口（注入 seam）：生产 = execFile(msb)；测试 = fake runner 记账。 */
export type MsbRunner = (args: string[]) => Promise<{ stdout: string }>;

export interface MsbAnalyzerBackendDeps {
  audit: AuditSink;
  requestId: string;
  actor?: { type: string; id: string };
  image?: string;
  msbBin?: string;
  vmAnalyzersDir?: string;
  tiDir?: string;
  timeoutSecs?: number;
  run?: MsbRunner;
  /** 脚本定位 seam（攻击面切真跑的开关）：默认 vm-analyzers/<analyzer>.py；
   *  attack/sandbox/01 用它把执行位换成投毒 fixture。 */
  scriptFor?: (analyzer: AnalyzerName) => string;
}

interface VmAttempt {
  kind: string;
  blocked?: boolean;
  errno?: number;
  target?: string;
  env_keys?: string[];
  credential_paths_missing?: string[];
  found?: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class MsbAnalyzerBackend implements AnalyzerBackend {
  private readonly audit: AuditSink;
  private readonly requestId: string;
  private readonly actor: { type: string; id: string };
  private readonly image: string;
  private readonly msbBin: string;
  private readonly vmAnalyzersDir: string;
  private readonly tiDir: string;
  private readonly timeoutSecs: number;
  private readonly run: MsbRunner;
  private readonly scriptFor: (analyzer: AnalyzerName) => string;

  constructor(deps: MsbAnalyzerBackendDeps) {
    this.audit = deps.audit;
    this.requestId = deps.requestId;
    this.actor = deps.actor ?? { type: "agent", id: "agent:enrichment" };
    this.image = deps.image ?? DEFAULT_IMAGE;
    this.msbBin = deps.msbBin ?? process.env.MSB_BIN ?? "msb";
    this.vmAnalyzersDir = deps.vmAnalyzersDir ?? fileURLToPath(new URL("./vm-analyzers/", import.meta.url));
    this.tiDir =
      deps.tiDir ?? fileURLToPath(new URL("../../../../fixtures/ti/", import.meta.url));
    this.timeoutSecs = deps.timeoutSecs ?? 120;
    this.run =
      deps.run ??
      (async (args) =>
        await execFile(this.msbBin, args, {
          timeout: (this.timeoutSecs + 60) * 1000, // execFile 兜底（msb 自己的 --timeout 在前）
          maxBuffer: 4 * 1024 * 1024,
        }));
    this.scriptFor = deps.scriptFor ?? ((analyzer) => join(this.vmAnalyzersDir, `${analyzer}.py`));
  }

  async lookup(analyzer: AnalyzerName, call: AnalyzerCall): Promise<AnalyzerResult> {
    const scriptPath = this.scriptFor(analyzer);
    if (!existsSync(scriptPath)) {
      // fail-closed：没脚本不猜、不开 VM、拒绝执行（INV-1：异常一律拒绝）
      this.record("FAILURE", "sandbox_run_failed", analyzer, { reason: `script_missing:${analyzer}` });
      return this.refused(`script_missing:${analyzer}`);
    }

    const name = `enrich-${analyzer}-${randomUUID().slice(0, 8)}`;
    try {
      let stdout: string;
      try {
        ({ stdout } = await this.run(buildMsbArgs({
          image: this.image,
          name,
          scriptPath,
          tiDir: this.tiDir,
          call,
          timeoutSecs: this.timeoutSecs,
        })));
      } catch (e) {
        return this.failRun(name, analyzer, `vm_error:${errMsg(e)}`);
      }

      const line = stdout.split("\n").find((l) => l.includes(RESULT_MARKER));
      if (!line) return this.failRun(name, analyzer, "no_result_marker");
      let envelope: { result?: unknown; attempts?: VmAttempt[] };
      try {
        envelope = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length));
      } catch {
        return this.failRun(name, analyzer, "bad_result_json");
      }
      const shape = this.checkShape(envelope.result);
      if (!shape.ok) return this.failRun(name, analyzer, shape.reason);
      this.recordAttempts(name, analyzer, envelope.attempts ?? []);
      return shape.result;
    } finally {
      await this.remove(name, analyzer); // 跑完即毁：成功失败都拆（验收 ④ 的机制面）
    }
  }

  /** Cortex 返回契约的最小形状校验：VM 输出是不可信输入，不猜不兜底（INV-1）。 */
  private checkShape(raw: unknown): { ok: true; result: AnalyzerResult } | { ok: false; reason: string } {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "bad_result_shape" };
    const r = raw as Record<string, unknown>;
    const taxonomies = (r.summary as { taxonomies?: unknown } | undefined)?.taxonomies;
    if (typeof r.success !== "boolean" || !Array.isArray(taxonomies)) {
      return { ok: false, reason: "bad_result_shape" };
    }
    return { ok: true, result: r as unknown as AnalyzerResult };
  }

  /** 沙箱遥测 → 审计：拦截记 DENIED；「没拦住」记 FAILURE 级 breach（审计不说谎）。 */
  private recordAttempts(name: string, analyzer: AnalyzerName, attempts: VmAttempt[]): void {
    for (const a of attempts) {
      if (a.kind === "egress") {
        const blocked = a.blocked === true;
        this.record(
          blocked ? "DENIED" : "FAILURE",
          blocked ? "sandbox_egress_blocked" : "sandbox_egress_breach",
          name,
          { analyzer, target: a.target, errno: a.errno },
        );
      } else if (a.kind === "env_probe") {
        if (a.found === true) {
          this.record("FAILURE", "sandbox_env_breach", name, { analyzer, detail: a });
        } else {
          this.record("DENIED", "sandbox_env_denied", name, {
            analyzer,
            env_keys: Array.isArray(a.env_keys) ? a.env_keys.length : 0,
            credential_paths_missing: a.credential_paths_missing ?? [],
          });
        }
      }
    }
  }

  private failRun(name: string, analyzer: AnalyzerName, reason: string): AnalyzerResult {
    this.record("FAILURE", "sandbox_run_failed", name, { analyzer, reason });
    return this.refused(reason);
  }

  private refused(reason: string): AnalyzerResult {
    return { success: false, summary: { taxonomies: [] }, errorMessage: `sandbox_run_failed:${reason}` };
  }

  private async remove(name: string, analyzer: AnalyzerName): Promise<void> {
    try {
      await this.run(["remove", "-f", name, "-q"]);
    } catch (e) {
      // remove 失败 = 「跑完即毁」被破坏，这是安全事件级，不能静默
      this.record("FAILURE", "sandbox_remove_failed", name, { analyzer, reason: errMsg(e) });
    }
  }

  private record(
    result: "SUCCESS" | "FAILURE" | "DENIED",
    action: string,
    objectId: string,
    details: Record<string, unknown>,
  ): void {
    this.audit.record({
      action,
      actor: this.actor,
      objectId,
      objectType: "analyzer_run",
      details,
      requestId: this.requestId,
      result,
      createdAt: Date.now(),
    });
  }
}

/** 真跑能力探测：有 microVM 环境才允许真断言；否则显式返回原因（测试据此 skip 并
 *  打印——CI 没有 KVM 属预期，skip 必须可见，不静默降级）。探测本身也是一次真拉起。 */
export async function msbProbe(
  opts: { msbBin?: string; image?: string } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const bin = opts.msbBin ?? process.env.MSB_BIN ?? "msb";
  const image = opts.image ?? DEFAULT_IMAGE;
  try {
    await execFile(bin, ["--version"]);
  } catch {
    return {
      ok: false,
      reason: `microsandbox CLI 不可用（${bin} 不在 PATH；CI 无 KVM 属预期）——真跑断言 skip，mock 侧照常全绿`,
    };
  }
  const name = `probe-${randomUUID().slice(0, 8)}`;
  try {
    const { stdout } = await execFile(
      bin,
      [
        "run", image, "--name", name, "--no-net", "--no-tty", "-q",
        "--timeout", "30s", "--label", "soc-demo=ticket16",
        "--", "python", "-c", "print('ok')",
      ],
      { timeout: 120_000 },
    );
    if (!stdout.includes("ok")) return { ok: false, reason: `microVM 冒烟输出异常：${stdout.slice(0, 120)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `microVM 冒烟失败——真跑断言 skip：${errMsg(e)}` };
  } finally {
    await execFile(bin, ["remove", "-f", name, "-q"]).catch(() => {}); // 探针 VM 也一次性
  }
}
