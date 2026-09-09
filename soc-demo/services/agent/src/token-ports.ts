// agent 侧的出站票据 seam（票 11 审批铸票 + 票 13 任务票 + 票 34 焚毁读口）。adapter
// 形态照 m1 的 M2Client 先例：测试换假件，生产换 HTTP，链路代码一行不改。
//
// 铸票：m9 卡「审批卡 REST 挂 agent，铸票调 gateway」+「每个 worker 被拉起时由铸币
// 服务签发任务级最小 scope 票」——agent 自己不持签名密钥，一律 POST gateway
// /internal/mint（票 06 产物，SOC_HMAC_KEY 在网关 env）。
// 焚毁（写侧）：INV-2「用后焚毁登记」，登记真相在 M2 used_tokens 表（票 03，
// 审计同库同事务）；执行成功后 fire-and-forget POST，写失败只打日志不阻塞——
// 同进程即时重放的缺口另有卡的 executed_at 单次执行标记兜底。
// 焚毁（读侧）：票 34 接通——闸前的跨进程装填查 GET /internal/used-tokens/:jti，
// 查询失败 fail-closed（INV-1），重放防线不再依赖 TTL 自然过期。

// ---------- 铸票（gateway /internal/mint，m9 卡公开接口） ----------

export interface MintRequest {
  jti: string;
  approvalId: string;
  approvedBy: string;
  tool: string;
  params: unknown;
  /** 票面绑定的案件；alert_flow 前段还没有 case 时为 null（铸成空串占位，闸侧跳过 case 校验）。 */
  caseId: string | null;
}

/** 任务票铸造参数（票 13 起用，PRD §5.8）：worker 被拉起时的任务级最小 scope 票。
 *  allowed_tools 只含该 worker 的工具族——分诊的六件套里没有任何 L2（INV-3）。 */
export interface TaskTicketRequest {
  jti: string;
  sub: string;
  caseId: string | null;
  runId: string;
  scope: string[];
  allowedTools: string[];
}

export interface MintedToken {
  token: string;
  payload: Record<string, unknown>;
}

export interface MintClient {
  mintApprovalToken(req: MintRequest): Promise<MintedToken>;
  /** 任务票（TTL 900s，CONTEXT.md 统一口径）：L1 写工具的授权票，worker 每次拉起申领一枚。 */
  mintTaskTicket(req: TaskTicketRequest): Promise<MintedToken>;
}

export class HttpMintClient implements MintClient {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.GATEWAY_URL ?? "http://gateway:8002") {
    this.baseUrl = baseUrl;
  }

  async mintTaskTicket(req: TaskTicketRequest): Promise<MintedToken> {
    const res = await fetch(`${this.baseUrl}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "task_ticket",
        jti: req.jti,
        sub: req.sub,
        case_id: req.caseId ?? "",
        run_id: req.runId,
        scope: req.scope,
        allowed_tools: req.allowedTools,
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      throw new Error(`gateway mint failed: HTTP ${res.status}`);
    }
    return (await res.json()) as MintedToken;
  }

  async mintApprovalToken(req: MintRequest): Promise<MintedToken> {
    const res = await fetch(`${this.baseUrl}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "approval_token",
        jti: req.jti,
        approval_id: req.approvalId,
        approved_by: req.approvedBy,
        tool: req.tool,
        params: req.params,
        case_id: req.caseId ?? "",
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      throw new Error(`gateway mint failed: HTTP ${res.status}`);
    }
    return (await res.json()) as MintedToken;
  }
}

// ---------- 焚毁读口（M2 GET /internal/used-tokens/:jti，票 34 接通） ----------
//
// 票 11 遗留（G2-1）：闸的 BurnRegistry 是同步读口，M2 是 HTTP——彼时生产 used 不传，
// 跨进程重放靠 executed_at + TTL 兜底。本票给出异步读口 adapter：查询在进闸【前】由
// graph.ts 装填（闸本体与 interrupt 同步契约不动），真相只认 case-backend 的 used_tokens。
// 与 fire-and-forget 的写口相反，读口在同步执行路径上必须「问到才放行」：任何失败都
// 抛给闸侧归 fail-closed（INV-1），绝不静默当「未焚」。

/** 跨进程焚毁真相读口（INV-2）：查 jti 是否已登记 used_tokens。
 *  200 = 已焚（true）、404 = 未焚（false）；其他状态码/网络错一律抛——
 *  「查不到真相」和「真相是没有」是两回事，前者必须让闸病掉（INV-1）。 */
export interface UsedTokenReader {
  lookup(jti: string): Promise<boolean>;
}

export class HttpUsedTokenReader implements UsedTokenReader {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  async lookup(jti: string): Promise<boolean> {
    const res = await fetch(
      `${this.baseUrl}/internal/used-tokens/${encodeURIComponent(jti)}`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error(`used_tokens lookup failed: HTTP ${res.status}`);
  }
}

// ---------- 焚毁登记（M2 POST /internal/used-tokens，票 03 产物） ----------

export interface TokenBurner {
  burn(jti: string, source?: string): void;
}

/** 生产 adapter：POST M2 登记 used_tokens。执行器是同步循环（better-sqlite3 全同步），
 *  这里 best-effort 发出去即返回；失败打日志可见——票 12 接容器时若要强一致，
 *  换「本地镜像表 + outbox 补偿」的 adapter，调用方零改动（seam 立在这里的意义）。 */
export class HttpTokenBurner implements TokenBurner {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  burn(jti: string, source = "approval"): void {
    void fetch(`${this.baseUrl}/internal/used-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jti, source }),
    }).catch((e: unknown) => {
      console.error(JSON.stringify({ warn: "used_tokens_register_failed", jti, error: String(e) }));
    });
  }
}
