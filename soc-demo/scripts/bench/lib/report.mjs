// m13 · 结果表渲染：autocannon result → markdown 表（可直接贴报告）。
// CONTEXT「压测拐点」口径：每张表必须带机器规格+时间戳+复现命令——数字只同机比，不当生产 SLO。
import os from "node:os";

/** 机器规格（B0 约定：没机器规格的数字是废纸）。 */
export function machineSpec(now = new Date()) {
  const cpus = os.cpus();
  return {
    timestamp: now.toISOString(),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCores: cpus.length,
    totalMemGB: Math.round(os.totalmem() / 2 ** 30),
    arch: os.arch(),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  };
}

/** 一行引用块形态的机器规格（贴报告用）。 */
export function machineSpecLine(spec = machineSpec()) {
  return `> 机器：${spec.cpuModel} × ${spec.cpuCores} 核 · 内存 ${spec.totalMemGB} GB · ${spec.platform} · ${spec.arch} · node ${spec.node}`;
}

const ms = (v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a");
const num = (v) => (Number.isFinite(v) ? v.toFixed(0) : "n/a");

// autocannon 的百分位键：p50/p95/p99；percentiles 选项请求不到的档位回退 n/a（不硬造）
function pct(latency, p) {
  const key = `p${String(p).replace(".", "_")}`;
  return latency?.[key];
}

export const B1_TABLE_HEADER =
  "| case | 档位 | P50(ms) | P95(ms) | P99(ms) | req/s | 错误 | 复现命令 |\n" +
  "|---|---|---|---|---|---|---|---|";

/**
 * autocannon result → 一行 markdown：
 * | case | 档位 | P50 | P95 | P99 | req/s | 错误 | 复现命令 |
 * 错误 = autocannon 计的网络/超时错误 + 非 2xx 响应数（fail-closed 口径：非绿即错）。
 */
export function benchRow({ name, profile, result, repro }) {
  const l = result.latency ?? {};
  const err = (result.errors ?? 0) + (result.non2xx ?? 0);
  return `| ${name} | ${profile} | ${ms(pct(l, 50))} | ${ms(pct(l, 95))} | ${ms(pct(l, 99))} | ${num(result.requests?.average)} | ${err} | \`${repro}\` |`;
}

/**
 * autocannon statusCodeStats → 分支校验行（对账 201 新建 / 200 去重两分支没被吃串）。
 * 形如：`分支校验（状态码计数）：201=9999 200=1`
 */
export function statusStatLine(result) {
  const stats = result.statusCodeStats ?? {};
  const parts = Object.entries(stats)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([code, s]) => `${code}=${s.count ?? s.total ?? 0}`);
  return `分支校验（状态码计数）：${parts.length > 0 ? parts.join(" ") : "（无计数）"}`;
}
