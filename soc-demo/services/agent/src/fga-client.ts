// agent 侧 OpenFGA 出站客户端（票 18·ADR 0002 框架红线：chat 意图闸的三态裁决走票 12
// 的真 openfga 容器与 fga 矩阵——soc1/duty_lead/admin/redteam 四角色 × 4 工具族）。
//
// 与 gateway 侧插件（services/gateway/plugins/fga_check.py）同问一句话：
//   check(user:<角色>, can_execute, tool:<工具>) —— 元组形状、store/model id 来源
//   （fga_ids.json，setup-openfga.sh 每次重建世界时刷新，绝不写死）都保持同一世界。
//
// fail-closed 纪律（INV-1）：裁判联系不上/超时/非 200/ids 不可读，一律
// { allowed:false, reason }——deny 覆盖 allow，绝不带着「裁判瞎了」放行。
// 出站 seam：fetchImpl 可注入（票 08 test_proxy.py MockTransport 先例的 TS 对位），
// 契约测试捕获请求形态，绝不真出网；真容器冒烟走 fgaSmokeProbe 显式探测。
// 票 43（F3）：超时/错误分类/ProbeResult/冒烟骨架收进共享出站件 outbound.ts。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isOutboundTimeout,
  outboundTimeoutReason,
  smokeHttpProbe,
  timeoutSignal,
  type ProbeResult,
} from "./outbound.js";

export type { ProbeResult };

export interface FgaIds {
  store_id: string;
  model_id: string;
}

export type FgaCheckResult = { allowed: true } | { allowed: false; reason: string };

/** FGA 检查器的形状（gate 的注入 seam）：问「user 能不能直接执行 tool」。 */
export type FgaChecker = (user: string, tool: string) => Promise<FgaCheckResult>;

const DEFAULT_IDS_PATH = "../../../services/gateway/plugins/fga_ids.json";

export const loadFgaIds = {
  /** 仓库内默认位置（本文件在 services/agent/src/ → 上三级是 soc-demo 根）。 */
  defaultPath(): string {
    return fileURLToPath(new URL(DEFAULT_IDS_PATH, import.meta.url));
  },
  /** 显式路径读口（compose 挂载 /fga/fga_ids.json 时经 FGA_IDS_FILE 注入）。 */
  pathOf(p: string): FgaIds {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (typeof raw.store_id !== "string" || typeof raw.model_id !== "string") {
      throw new Error("fga_ids.json 缺 store_id/model_id");
    }
    return { store_id: raw.store_id, model_id: raw.model_id };
  },
  /** 缺省装配：FGA_IDS_FILE env > 仓库内默认路径。读不到抛错，由调用方 fail-closed。 */
  load(p?: string): FgaIds {
    return this.pathOf(p ?? process.env.FGA_IDS_FILE ?? this.defaultPath());
  },
};

/** 问裁判一句 can_execute；连接/超时/非 200/JSON 坏形都抛异常，由调用方按 deny 处理。
 *  与 py 侧 query_openfga 同一请求契约（POST /stores/{store}/check）。 */
export async function queryOpenfga(
  apiUrl: string,
  ids: FgaIds,
  fgaUser: string,
  toolObj: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<boolean> {
  const res = await fetchImpl(`${apiUrl}/stores/${ids.store_id}/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tuple_key: { user: fgaUser, relation: "can_execute", object: toolObj },
      authorization_model_id: ids.model_id,
    }),
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) throw new Error(`fga_http_${res.status}`);
  const obj = (await res.json()) as { allowed?: unknown };
  if (typeof obj.allowed !== "boolean") throw new Error("fga_bad_shape");
  return obj.allowed;
}

export interface FgaClientOpts {
  /** OpenFGA REST（缺省 env FGA_API_URL > 宿主映射口 127.0.0.1:18080；compose 里服务名 openfga:8080） */
  apiUrl?: string;
  /** store/model id（缺省 loadFgaIds.load()；测试注入固定值） */
  ids?: FgaIds | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 生产 FGA 检查器：任何异常收口成 {allowed:false, reason}（INV-1 fail-closed）。 */
export function makeFgaChecker(opts: FgaClientOpts = {}): FgaChecker {
  const apiUrl = opts.apiUrl ?? process.env.FGA_API_URL ?? "http://127.0.0.1:18080";
  const timeoutMs = opts.timeoutMs ?? 3000;
  return async (user, tool) => {
    let ids: FgaIds | null;
    try {
      ids = opts.ids !== undefined ? opts.ids : loadFgaIds.load();
    } catch {
      return { allowed: false, reason: "fga_ids_unreadable" };
    }
    if (!ids) return { allowed: false, reason: "fga_ids_unreadable" };
    try {
      const allowed = await queryOpenfga(apiUrl, ids, user, `tool:${tool}`, timeoutMs, opts.fetchImpl);
      return allowed ? { allowed: true } : { allowed: false, reason: "fga_denied" };
    } catch (e) {
      return { allowed: false, reason: outboundTimeoutReason("fga", isOutboundTimeout(e)) };
    }
  };
}

/** 真 OpenFGA 容器冒烟能力探测（票 16 msbProbe / 票 27 llmSmokeProbe 先例）：
 *  /healthz 可达且 fga_ids.json 可读才允许真裁决；否则显式带原因返回（测试据此
 *  skip 并打印），绝不静默。骨架（fetch+超时+ProbeResult）走共享 smokeHttpProbe。 */
export async function fgaSmokeProbe(apiUrl?: string): Promise<ProbeResult> {
  const base = apiUrl ?? process.env.FGA_API_URL ?? "http://127.0.0.1:18080";
  const reachable = await smokeHttpProbe(`${base}/healthz`, {
    timeoutMs: 3000,
    onHttpStatus: (status) => `openfga /healthz HTTP ${status}`,
    onUnreachable: () =>
      `openfga 不可达（${base}）——真容器冒烟 skip。要跑：docker compose up -d openfga && bash scripts/setup-openfga.sh`,
  });
  if (!reachable.ok) return reachable;
  try {
    loadFgaIds.load();
  } catch {
    return {
      ok: false,
      reason: "fga_ids.json 不可读——真容器冒烟 skip。要跑：bash scripts/setup-openfga.sh（幂等，30 秒重建授权世界）",
    };
  }
  return { ok: true };
}
