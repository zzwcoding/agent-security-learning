// 票 37（ADR 0001 承诺兑现）：Langfuse 可选旁路。审计主链路走 M2 AuditEntry（票 35 的
// HttpAuditSink，真相源不动）；本模块只在三把 env 钥匙（LANGFUSE_PUBLIC_KEY/SECRET_KEY/
// HOST）齐了才把审计与 SSE 事件【镜像】进 Langfuse——缺 key = makeLangfuseMirror() 返回
// null，tap 不挂、单 sink，与装本模块之前逐字节一致（默认链路零改动是硬验收）。
//
// 为什么是手写 HTTP 而不是官方 SDK / OpenTelemetry：那是重件（v3 全家桶依赖栈连 compose
// 都背不动，PRD v1.1 变更 1 同款权衡）。v2 的 ingestion HTTP API 一个 POST 就够：
// POST {host}/api/public/ingestion，Basic 认证（public key 当用户名、secret key 当密码），
// body = { batch: [ {id, type, timestamp, body} ] }，type 用 trace-create / event-create
// 两种（v2 zod：timestamp 必须 ISO 带时区；trace id 惯例 32 字符）。刻意做薄：每个事件
// 一条 point observation，不做 node span 配对 / LLM generation 面——那是全量 OTel 的活，
// 真需要时在 emitToIngestion 换 span-create/generation-create 即可，wire 闸已在测试里。
//
// 出站纪律 = HttpAuditSink 同款 fire-and-forget：record/onEvent 同步返回不阻塞业务，
// 失败只打结构化日志 warn=langfuse_mirror_failed；flush() 只给测试排空在途请求。
import { createHash, randomUUID } from "node:crypto";
import type { AuditEntry, AuditSink } from "./audit.js";
import type { RunEvent } from "./events.js";

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

/** 三把钥匙当开关：双 key 齐才启用（HOST 可缺省 compose 服务名）。key 是唯一开关——
 *  容器在不在不归 env 管，key 空时一个字节都不该发（零开销）。 */
export function langfuseConfigFromEnv(env: Record<string, string | undefined> = process.env): LangfuseConfig | null {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() ?? "";
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim() ?? "";
  if (!publicKey || !secretKey) return null;
  const host = (env.LANGFUSE_HOST?.trim() || "http://langfuse:3000").replace(/\/+$/, "");
  return { publicKey, secretKey, host };
}

/** runId/requestId → 32 位 hex traceId。Langfuse 惯例 trace id 32 字符，而 run id 是
 *  `run_<uuid>` 不合身；sha256 收敛成确定性 id——同一 run 冒烟两次 id 稳定，冒烟脚本
 *  与查询方都免登记直接可算。前缀分区：`run:<id>` 与 `audit:<id>` 不相撞。 */
export function traceIdFor(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

// v2 ingestion 的两种事件（timestamp 顶层 + body 分型；ISO 带时区由 toISOString 的 Z 满足）
interface IngestionItem {
  id: string;
  type: "trace-create" | "event-create";
  timestamp: string;
  body: Record<string, unknown>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** ObservationLevel 白名单（v2 枚举）：DENIED/FAILURE 抬 WARNING，error 事件抬 ERROR。 */
function levelFor(result: unknown, type: string): string | undefined {
  if (type === "error") return "ERROR";
  if (result === "DENIED" || result === "FAILURE") return "WARNING";
  return undefined;
}

export class LangfuseMirror implements AuditSink {
  private readonly basic: string;
  private readonly inFlight = new Set<Promise<void>>();
  /** 已 announce 过 trace-create 的 traceId（进程内去重：每个 run/audit 只发一次头件）。 */
  private readonly traced = new Set<string>();

  constructor(readonly config: LangfuseConfig) {
    this.basic = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64")}`;
  }
  /** SSE 事件 → 每 run 一条 trace（id=hash(run:runId)），事件为 point observation
   *  （name 带 type 与节点/动作，payload 原样进 metadata）。externalId 照发（cloud/新版
   *  收）；v2.95.11 自托管 ingestion 实证落库恒 null——查询锚点是确定性 traceId 与
   *  metadata.run_id，别依赖 externalId。 */
  onEvent(e: RunEvent): void {
    const traceId = traceIdFor(`run:${e.runId}`);
    const payload = e.payload as Record<string, unknown>;
    const name =
      e.type === "audit"
        ? `audit.${String(payload.action ?? "unknown")}`
        : typeof payload.node === "string"
          ? `${e.type}.${payload.node}`
          : e.type;
    const items: IngestionItem[] = [];
    if (!this.traced.has(traceId)) {
      this.traced.add(traceId);
      items.push({
        id: randomUUID(),
        type: "trace-create",
        timestamp: iso(Date.now()),
        body: { id: traceId, name: "agent.run", timestamp: iso(e.createdAt), externalId: e.runId, metadata: { run_id: e.runId } },
      });
    }
    items.push({
      id: randomUUID(),
      type: "event-create",
      timestamp: iso(e.createdAt),
      body: {
        id: randomUUID(),
        traceId,
        name,
        startTime: iso(e.createdAt),
        metadata: payload, // SSE payload 原样镜像——镜像语义：Langfuse 里看到的就是事件流里的
        ...(levelFor(payload.result, e.type) ? { level: levelFor(payload.result, e.type) } : {}),
      },
    });
    this.send(items);
  }

  /** 审计五要素 → 独立 trace（id=hash(audit:requestId)，externalId=requestId）。与 run
   *  trace 的互链走两跳：run 的 audit 事件在 run trace 里，本 trace 的 metadata 带
   *  requestId——PRD「trace 与审计经 requestId/run_id 互链」的最薄满足。 */
  record(entry: AuditEntry): void {
    const traceId = traceIdFor(`audit:${entry.requestId}`);
    const items: IngestionItem[] = [];
    if (!this.traced.has(traceId)) {
      this.traced.add(traceId);
      items.push({
        id: randomUUID(),
        type: "trace-create",
        timestamp: iso(Date.now()),
        body: {
          id: traceId,
          name: "agent.audit",
          timestamp: iso(entry.createdAt),
          externalId: entry.requestId,
          metadata: { request_id: entry.requestId },
        },
      });
    }
    const level = levelFor(entry.result, "audit");
    items.push({
      id: randomUUID(),
      type: "event-create",
      timestamp: iso(entry.createdAt),
      body: {
        id: randomUUID(),
        traceId,
        name: `audit.${entry.action}`,
        startTime: iso(entry.createdAt),
        metadata: {
          action: entry.action,
          actor: entry.actor,
          objectId: entry.objectId,
          objectType: entry.objectType,
          result: entry.result,
          requestId: entry.requestId,
          details: entry.details,
        },
        ...(level ? { level } : {}),
      },
    });
    this.send(items);
  }

  /** fire-and-forget 出站（HttpAuditSink 同款：2s 超时闸 + 失败只打结构化日志）。 */
  private send(items: IngestionItem[]): void {
    const send = fetch(`${this.config.host}/api/public/ingestion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.basic },
      body: JSON.stringify({ batch: items, metadata: { source: "soc-demo/agent" } }),
      signal: AbortSignal.timeout(2000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`langfuse_ingestion_http_${res.status}`);
        await res.json().catch(() => null); // 排干响应体，连接可复用
      })
      .catch((e: unknown) => {
        console.error(JSON.stringify({ warn: "langfuse_mirror_failed", error: String(e) }));
      });
    const tracked = send.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /** 排空在途出站（测试确定性用；业务路径绝不 await 它）。 */
  flush(): Promise<void> {
    return Promise.all([...this.inFlight]).then(() => undefined);
  }
}

/** 生产装配口（index.ts 一行接）：keys 缺 → null（audit 保持单 sink、tap 不挂）；
 *  keys 齐 → 镜像实例，调用方负责 tee 进 audit 链并 setEventTap。 */
export function makeLangfuseMirror(env: Record<string, string | undefined> = process.env): LangfuseMirror | null {
  const config = langfuseConfigFromEnv(env);
  return config ? new LangfuseMirror(config) : null;
}

/** 镜像启用时 audit 一弦两 sink：M2 真相源（HttpAuditSink）照旧 + Langfuse 旁路。
 *  顺序刻意 M2 在前——旁路慢半拍不影响真相源先落。 */
export class TeeAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}
  record(entry: AuditEntry): void {
    for (const sink of this.sinks) sink.record(entry);
  }
}
