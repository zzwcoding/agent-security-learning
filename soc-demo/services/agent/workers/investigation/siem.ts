// m5 调查 worker · SIEM 后端 seam + fixture 告警集检索 adapter（票 14）。
//
// m5 卡 Seam：「SIEM 后端（adapter：fixture 告警集检索 / 将来真 Wazuh）」。
// demo 阶段拿 fixtures/alerts/ 的 11 条真 Wazuh 告警当 SIEM 语料——FR-M5.1
// 「按实体（ip/user/host）+ 强制时间窗的 pivot 查询，后端为 fixture 告警集的
// 全文/字段检索」。换真 Wazuh 时只换 adapter，循环与闸一行不动（tracer bullet）。
// 票 78：同一 adapter 再挂四个狩猎维度索引（FIM/外联/web 访问/进程谱系，见文末
// HuntQueryBackend）——共用本语料与时间窗口径，不另起第二套查询面。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type EntityType = "ip" | "user" | "host";

/** PRD §6-M5 mock SIEM 工具签名（LLM tool schema 的执行侧参数）。 */
export interface SiemQueryParams {
  entity_type: EntityType;
  entity: string;
  time_window: { from: string; to: string };
  max_results?: number;
}

export interface SiemHit {
  id: string;
  timestamp: string;
  rule_id: string;
  rule_description: string;
  agent_name: string;
  full_log: string;
}

export interface SiemResult {
  total: number;
  hits: SiemHit[];
}

export interface SiemBackend {
  query(params: SiemQueryParams): Promise<SiemResult>;
}

interface CorpusEvent {
  timestamp?: unknown;
  id?: unknown;
  rule?: { id?: unknown; description?: unknown; firedtimes?: unknown };
  agent?: { name?: unknown };
  data?: {
    srcip?: unknown;
    srcuser?: unknown;
    // 票 78 四维度结构化字段（外联/web 访问/进程谱系；id = web accesslog 的状态码）
    dstip?: unknown;
    dstport?: unknown;
    dns?: unknown;
    url?: unknown;
    id?: unknown;
    process_name?: unknown;
    parent_process_name?: unknown;
    user?: unknown;
  };
  // 票 78 FIM 维度结构化字段（syscheck 事件）
  syscheck?: {
    path?: unknown;
    mode?: unknown;
    uname_after?: unknown;
    md5_after?: unknown;
    sha1_after?: unknown;
    sha256_after?: unknown;
  };
  full_log?: unknown;
}

const DEFAULT_MAX_RESULTS = 50;

/** 字段检索（结构化实体字段）+ 全文检索（full_log 包含）双口径，任一命中即算。 */
function matchesEntity(w: CorpusEvent, entityType: EntityType, entity: string): boolean {
  const fullLog = typeof w.full_log === "string" ? w.full_log : "";
  if (fullLog.includes(entity)) return true; // 全文口径
  if (entityType === "ip") return w.data?.srcip === entity;
  if (entityType === "user") return w.data?.srcuser === entity;
  return w.agent?.name === entity;
}

export class FixtureSiem implements SiemBackend, HuntQueryBackend {
  private readonly corpusDir: string;
  private cache: CorpusEvent[] | null = null;

  constructor(corpusDir: string) {
    this.corpusDir = corpusDir;
  }

  private corpus(): CorpusEvent[] {
    if (!this.cache) {
      this.cache = readdirSync(this.corpusDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(this.corpusDir, f), "utf8")) as CorpusEvent);
    }
    return this.cache;
  }

  async query(params: SiemQueryParams): Promise<SiemResult> {
    const from = Date.parse(params.time_window.from);
    const to = Date.parse(params.time_window.to);
    const hits = this.corpus()
      .filter((w) => typeof w.timestamp === "string")
      .map((w) => ({
        raw: w,
        ts: Date.parse(w.timestamp as string),
        id: typeof w.id === "string" ? w.id : "",
        ruleId: typeof w.rule?.id === "string" || typeof w.rule?.id === "number" ? String(w.rule.id) : "",
        desc: typeof w.rule?.description === "string" ? w.rule.description : "",
        agent: typeof w.agent?.name === "string" ? w.agent.name : "",
        fullLog: typeof w.full_log === "string" ? w.full_log : "",
      }))
      .filter((e) => e.ts >= from && e.ts <= to)
      .filter((e) => matchesEntity(e.raw, params.entity_type, params.entity))
      .sort((a, b) => a.ts - b.ts);

    const sliced = hits.slice(0, params.max_results ?? DEFAULT_MAX_RESULTS);
    return {
      total: hits.length,
      hits: sliced.map((e) => ({
        id: e.id,
        timestamp: new Date(e.ts).toISOString(),
        rule_id: e.ruleId,
        rule_description: e.desc,
        agent_name: e.agent,
        full_log: e.fullLog,
      })),
    };
  }

  // ---- 票 78 狩猎四维度：同一 FixtureSiem、同一语料上的四个维度索引 ----

  /** 四维共用的查询骨架：与 siem_query 同一强制时间窗/排序/max_results 口径；
   *  scope 圈定维度索引（结构化字段存在性），match 做维度内字段匹配。 */
  private hunt<H>(
    params: HuntCoreParams,
    scope: (w: CorpusEvent) => boolean,
    match: (w: CorpusEvent) => boolean,
    project: (w: CorpusEvent, ts: number) => H,
  ): HuntResult<H> {
    const from = Date.parse(params.time_window.from);
    const to = Date.parse(params.time_window.to);
    const hits = this.corpus()
      .filter(scope)
      .filter((w) => typeof w.timestamp === "string")
      .map((w) => ({ raw: w, ts: Date.parse(w.timestamp as string) }))
      .filter((e) => e.ts >= from && e.ts <= to)
      .filter((e) => match(e.raw))
      .sort((a, b) => a.ts - b.ts);
    const sliced = hits.slice(0, params.max_results ?? DEFAULT_MAX_RESULTS);
    return { total: hits.length, hits: sliced.map((e) => project(e.raw, e.ts)) };
  }

  queryFileChanges(params: FileChangeQueryParams): Promise<HuntResult<FileChangeHit>> {
    const r = this.hunt(
      params,
      (w) => typeof w.syscheck?.path === "string", // FIM 维度圈定：syscheck 事件
      (w) => {
        const sys = w.syscheck as NonNullable<CorpusEvent["syscheck"]>;
        if (params.field === "hash") {
          // 哈希口径：md5/sha1/sha256 精确等值
          return [sys.md5_after, sys.sha1_after, sys.sha256_after].some(
            (h) => typeof h === "string" && h === params.value,
          );
        }
        // 路径口径：子串匹配（按目录/文件名片段狩猎）
        return (sys.path as string).includes(params.value);
      },
      (w, ts) => {
        const sys = w.syscheck as NonNullable<CorpusEvent["syscheck"]>;
        return {
          ...baseHit(w, ts),
          file: {
            path: str(sys.path),
            mode: str(sys.mode),
            user: str(sys.uname_after),
            md5: str(sys.md5_after),
            sha256: str(sys.sha256_after),
          },
        };
      },
    );
    return Promise.resolve(r);
  }

  queryOutboundConns(params: OutboundConnQueryParams): Promise<HuntResult<OutboundConnHit>> {
    const r = this.hunt(
      params,
      // 外联维度圈定：有结构化 dstip/dns 的事件（firewall/kernel 口径）
      (w) => typeof w.data?.dstip === "string" || typeof w.data?.dns === "string",
      (w) => {
        const d = w.data as NonNullable<CorpusEvent["data"]>;
        const fullLog = str(w.full_log);
        if (params.field === "dst_ip") return str(d.dstip) === params.value || fullLog.includes(params.value);
        if (params.field === "domain") return str(d.dns) === params.value || fullLog.includes(params.value);
        // 频率口径：rule.firedtimes ≥ N（重复信标/beacon）
        const n = Number(params.value);
        return Number.isFinite(n) && firedtimesOf(w) >= n;
      },
      (w, ts) => {
        const d = w.data as NonNullable<CorpusEvent["data"]>;
        return {
          ...baseHit(w, ts),
          conn: {
            dst_ip: str(d.dstip),
            dst_port: str(d.dstport),
            domain: str(d.dns),
            firedtimes: firedtimesOf(w),
          },
        };
      },
    );
    return Promise.resolve(r);
  }

  queryWebAccess(params: WebAccessQueryParams): Promise<HuntResult<WebAccessHit>> {
    const r = this.hunt(
      params,
      (w) => typeof w.data?.url === "string", // web 访问维度圈定：accesslog 事件
      // URL 模式口径：结构化 url + full_log（日志行是解码形态）双口径，任一命中即算
      (w) => str(w.data?.url).includes(params.url_pattern) || str(w.full_log).includes(params.url_pattern),
      (w, ts) => {
        const d = w.data as NonNullable<CorpusEvent["data"]>;
        return {
          ...baseHit(w, ts),
          access: { url: str(d.url), src_ip: str(d.srcip), status: str(d.id) },
        };
      },
    );
    return Promise.resolve(r);
  }

  queryProcLineage(params: ProcLineageQueryParams): Promise<HuntResult<ProcLineageHit>> {
    const r = this.hunt(
      params,
      (w) => typeof w.data?.process_name === "string" || typeof w.data?.parent_process_name === "string",
      (w) => {
        const d = w.data as NonNullable<CorpusEvent["data"]>;
        const child = str(d.process_name);
        const parent = str(d.parent_process_name);
        // 进程名口径：结构化字段精确等值（全文子串会把 sh 匹配进 bash，不做）
        if (params.role === "child") return child === params.process;
        if (params.role === "parent") return parent === params.process;
        return child === params.process || parent === params.process;
      },
      (w, ts) => {
        const d = w.data as NonNullable<CorpusEvent["data"]>;
        return {
          ...baseHit(w, ts),
          lineage: { child: str(d.process_name), parent: str(d.parent_process_name), user: str(d.user) },
        };
      },
    );
    return Promise.resolve(r);
  }
}

// ---------- 票 78 狩猎查询工具 ×4 的数据源 seam（PRD §13.4b 共享底座） ----------
//
// 口径与 SiemBackend 同一 adapter、同一语料、同一强制时间窗——四维度只是同一
// FixtureSiem 上多四个维度索引，不是第二套查询面（票 78 铁律）。维度圈定用结构化
// 字段存在性（文件=syscheck、外联=dstip/dns、web=url、进程=process/parent），
// 字段匹配沿用 matchesEntity 的「结构化字段 + full_log 全文」双口径（进程名除外：
// 全文子串会把 sh 匹配进 bash，进程维度只走结构化等值）。

export interface HuntCoreParams {
  time_window: { from: string; to: string };
  max_results?: number;
}

export interface HuntResult<H> {
  total: number;
  hits: H[];
}

/** ① file_change_query：按路径/哈希查文件新增/篡改（FIM 维度——webshell 落盘取证）。 */
export interface FileChangeQueryParams extends HuntCoreParams {
  field: "path" | "hash";
  value: string;
}

export interface FileChangeHit extends SiemHit {
  file: { path: string; mode: string; user: string; md5: string; sha256: string };
}

/** ② outbound_conn_query：按目的 IP/域名/频率查外联（C2 心跳维度）。 */
export interface OutboundConnQueryParams extends HuntCoreParams {
  field: "dst_ip" | "domain" | "freq";
  value: string;
}

export interface OutboundConnHit extends SiemHit {
  conn: { dst_ip: string; dst_port: string; domain: string; firedtimes: number };
}

/** ③ web_access_query：按 URL 模式查访问异常（web 攻击痕迹维度）。 */
export interface WebAccessQueryParams extends HuntCoreParams {
  url_pattern: string;
}

export interface WebAccessHit extends SiemHit {
  access: { url: string; src_ip: string; status: string };
}

/** ④ proc_lineage_query：按进程名查父子关系（持久化/提权维度）。role 缺省 = any。 */
export interface ProcLineageQueryParams extends HuntCoreParams {
  process: string;
  role?: "child" | "parent" | "any";
}

export interface ProcLineageHit extends SiemHit {
  lineage: { child: string; parent: string; user: string };
}

/** 狩猎查询数据源 seam：生产 = FixtureSiem（本文件），测试/其他业务注入 fake。 */
export interface HuntQueryBackend {
  queryFileChanges(params: FileChangeQueryParams): Promise<HuntResult<FileChangeHit>>;
  queryOutboundConns(params: OutboundConnQueryParams): Promise<HuntResult<OutboundConnHit>>;
  queryWebAccess(params: WebAccessQueryParams): Promise<HuntResult<WebAccessHit>>;
  queryProcLineage(params: ProcLineageQueryParams): Promise<HuntResult<ProcLineageHit>>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const firedtimesOf = (w: CorpusEvent): number =>
  typeof w.rule?.firedtimes === "number" ? w.rule.firedtimes : 1;

const baseHit = (w: CorpusEvent, ts: number): SiemHit => ({
  id: typeof w.id === "string" ? w.id : "",
  timestamp: new Date(ts).toISOString(),
  rule_id: typeof w.rule?.id === "string" || typeof w.rule?.id === "number" ? String(w.rule.id) : "",
  rule_description: typeof w.rule?.description === "string" ? w.rule.description : "",
  agent_name: typeof w.agent?.name === "string" ? w.agent.name : "",
  full_log: str(w.full_log),
});
