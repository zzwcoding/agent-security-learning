// 审批回路的两条出站 seam（票 11）。adapter 形态照 m1 的 M2Client 先例：
// 测试换假件，生产换 HTTP，链路代码一行不改。
//
// 铸票：m9 卡「审批卡 REST 挂 agent，铸票调 gateway」——agent 自己不持签名密钥，
// 批准后 POST gateway /internal/mint（票 06 产物，SOC_HMAC_KEY 在网关 env）。
// 焚毁：INV-2「用后焚毁登记」，登记真相在 M2 used_tokens 表（票 03，
// 审计同库同事务）；执行成功后 fire-and-forget POST，写失败只打日志不阻塞——
// 登记缺口的兜底是 ApprovalToken 300s TTL + 卡的 executed_at 单次执行标记。

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

export interface MintedToken {
  token: string;
  payload: Record<string, unknown>;
}

export interface MintClient {
  mintApprovalToken(req: MintRequest): Promise<MintedToken>;
}

export class HttpMintClient implements MintClient {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.GATEWAY_URL ?? "http://gateway:8002") {
    this.baseUrl = baseUrl;
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

// ---------- 焚毁登记（M2 /internal/used-tokens，票 03 产物） ----------

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
