// 票 68（框架红线：sdd-flow 原则 6「点名即上」）：@fastify/under-pressure 过载卸载装配。
//
// 开关纪律（jiaotu JIAOTU_GATEWAY_URL 同款，docker-compose.yml/.env.example 空缺省透传）：
// UNDER_PRESSURE=on 才 register；env 缺省/其他值 = 零注册 = 默认形态逐字节不变。
//
// 阈值缺省 = 教学演示量级保守值，三个都 env 可覆盖。出处（官方 README，v9.x，2026-09 核对）：
//   · maxEventLoopDelay/maxHeapUsedBytes/maxRssBytes 官方缺省全是 0，且「if the value is 0
//     the check will not be performed」——零检查等于白装，故 on 时必须显式给值；
//   · maxEventLoopDelay=1000ms 与 README 示例同量级；heap/RSS 取远高于本机演示日常水位的
//     保守上限（B4 轮实测 agent 满载扇出 CPU ~18%、RSS 数百 MB 内，容器无内存限额），
//     宁迟 shed 不误 shed；要更敏感用 UNDER_PRESSURE_MAX_* env 压低（报告「机制演示」档）。
//
// 503 响应语义全部插件自带（FST_UNDER_PRESSURE「Service Unavailable」+ Retry-After 缺省
// 10s），本项目不自造响应；app.ts 的 setErrorHandler 只放行该 code（不落通用 500 兜底）。
// /status 是插件自带暴露口（exposeStatusRoute），healthCheck 把 memoryUsage 四项指标并进
// 应答——压测时从宿主 curl :PORT/status 即取 eventLoopDelay 对照（m13 只走公开面）。
// 票面提到的 exposureInterval 在官方现版（9.x）不存在，最接近的是 sampleInterval（缺省
// 1000ms，Node ≥11.10.0 用 monitorEventLoopDelay）——保持官方缺省不覆盖。
import underPressure from "@fastify/under-pressure";
import type { FastifyInstance } from "fastify";

/** 教学演示量级保守缺省（出处见文件头注）；均可被 UNDER_PRESSURE_MAX_* env 覆盖。 */
export const UNDER_PRESSURE_THRESHOLDS = {
  maxEventLoopDelay: 1000, // ms
  maxHeapUsedBytes: 1_073_741_824, // 1 GiB
  maxRssBytes: 1_610_612_736, // 1.5 GiB
} as const;

/** env 数字解析：空/非有限数 → 回缺省（开关只认字面 "on"，同 EVENT_DRIVEN 风格）。 */
function envNum(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** UNDER_PRESSURE=on → 插件选项（阈值读 env）；其余值/缺省 → null（零注册）。 */
export function underPressureOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  if (env.UNDER_PRESSURE !== "on") return null;
  return {
    maxEventLoopDelay: envNum(env, "UNDER_PRESSURE_MAX_EVENT_LOOP_DELAY_MS", UNDER_PRESSURE_THRESHOLDS.maxEventLoopDelay),
    maxHeapUsedBytes: envNum(env, "UNDER_PRESSURE_MAX_HEAP_USED_BYTES", UNDER_PRESSURE_THRESHOLDS.maxHeapUsedBytes),
    maxRssBytes: envNum(env, "UNDER_PRESSURE_MAX_RSS_BYTES", UNDER_PRESSURE_THRESHOLDS.maxRssBytes),
    // 过载时 /status 与业务面同一张卸载面（onRequest 先于路由）；健康时带出插件指标
    exposeStatusRoute: {
      url: "/status",
      routeOpts: {},
      routeResponseSchemaOpts: {
        heapUsed: { type: "number" },
        rssBytes: { type: "number" },
        eventLoopDelay: { type: "number" },
        eventLoopUtilized: { type: "number" },
      },
    },
    healthCheck: async (app: FastifyInstance) => ({ ...app.memoryUsage() }),
  };
}

/** 装配点：on = register 并返回 true；off = 什么都不做返回 false（app 形态与票 68 之前一致）。 */
export function registerUnderPressure(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): boolean {
  const opts = underPressureOptionsFromEnv(env);
  if (!opts) return false;
  app.register(underPressure, opts);
  return true;
}
