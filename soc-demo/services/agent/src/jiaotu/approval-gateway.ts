// 椒图（agentjiaotu）g4 审批外接 adapter（狗粮票 58，批准中继形态——设计 §3-G5/G6/G9）。
// JIAOTU_GATEWAY_URL 设定时由 index.ts 装配进 buildApp({approvalGateway})，graph.ts 的
// 挂起申报、app.ts 的批准/驳回中继、run-dispatcher 的 G9 对账四路共用这一个出站封装；
// 未装配绝不被构造，内部模式零变化。端口接口（ApprovalGateway/ApprovalGatewayError）
// 立在领域模块 approvals.ts，本类只做 wire 映射——token-ports 三件同款分工。
//
// wire 契约真源 = 椒图 services/gateway/src/approval/index.ts（2026-09-11 核实）：
//   申报      POST /internal/approvals        头 authorization: Bearer <agent api_key>，
//             body {tool, params, params_hash, risk, case_id}（agent_identity 缺省=api_key
//             解析身份不自带；kind 缺省 tool_execution；params_hash 传值只做一致性对账，
//             服务端按 g1 契约重算）→ 201 {approval_id}
//   对账      GET  /api/v1/approvals/:id      公开面无认证 → 200 {approval:{status,…}, audit}
//   批准中继  POST /api/v1/approvals/:id/approve   头 x-approver-token（口令错 401、
//             非 pending 409、不存在 404）→ 200 {approval_token:{token, jti, exp}}——
//             一次性票只在响应里出现一次，网关不落库不再分发（中继形态的支点）
//   驳回中继  POST /api/v1/approvals/:id/reject    头 x-approver-token，body {reason}
//             （必填，缺 400）→ 200 {ok:true}
//
// 错误映射：非 2xx 一律抛 ApprovalGatewayError(原 status)——401/404/409 原码透传，
// 不自吞不自造；响应正文一个字节不进 message（上游错误文本不许流入审计/事件面）。
// 超时统一 AbortSignal.timeout(2000)；fetchImpl 构造注入（57 idiom），契约测试捕获
// 请求形态，绝不真出网。
import {
  type ApprovalDeclareInput,
  type ApprovalGateway,
  ApprovalGatewayError,
} from "../approvals.js";
import type { JiaoTuClientOpts } from "./token-ports-jiaotu.js";

/** 出站超时：与 57 三件同口径（2s）。 */
const TIMEOUT_MS = 2000;

/** 椒图批准 200 响应形（approval/index.ts approve 路由）。 */
interface JiaoTuApprovalToken {
  token: string;
  jti: string;
  exp: number;
}

export class JiaoTuApprovalGateway implements ApprovalGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JiaoTuClientOpts = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.JIAOTU_GATEWAY_URL ?? "http://jiaotu-gateway:8080";
    this.apiKey = opts.apiKey ?? process.env.JIAOTU_API_KEY ?? "";
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  /** 挂起申报（设计 §4.1 declare）：领域字段 → g4 SubmitApprovalInput 逐字段映射
   *  （reason→risk 缺省空串、caseId→case_id 缺省空串——g4 两字段缺省口径一致）。 */
  async declare(card: ApprovalDeclareInput): Promise<{ externalId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/internal/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        tool: card.tool,
        params: card.params,
        params_hash: card.paramsHash,
        risk: card.reason ?? "",
        case_id: card.caseId ?? "",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new ApprovalGatewayError(res.status);
    const body = (await res.json()) as { approval_id?: unknown };
    return { externalId: String(body.approval_id ?? "") };
  }

  /** G9 对账读口：公开面详情里的 approval.status 就是裁决真相（惰性结算后可信）。 */
  async fetchStatus(externalId: string): Promise<{ status: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/approvals/${encodeURIComponent(externalId)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (res.status !== 200) throw new ApprovalGatewayError(res.status);
    const body = (await res.json()) as { approval?: { status?: unknown } };
    return { status: String(body.approval?.status ?? "") };
  }

  /** 批准中继：口令放头不放体（g4 只认 X-Approver-Token 头）；票从响应里拆出。 */
  async approve(externalId: string, approverToken: string): Promise<JiaoTuApprovalToken> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/approvals/${encodeURIComponent(externalId)}/approve`,
      {
        method: "POST",
        headers: { "x-approver-token": approverToken },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new ApprovalGatewayError(res.status);
    const body = (await res.json()) as { approval_token?: Partial<JiaoTuApprovalToken> };
    const minted = body.approval_token;
    if (!minted || typeof minted.token !== "string" || typeof minted.jti !== "string") {
      throw new Error("jiaotu approve response missing approval_token");
    }
    return { token: minted.token, jti: minted.jti, exp: Number(minted.exp ?? 0) };
  }

  /** 驳回中继：reason 必填进体（g4 没原因的驳回 400）。 */
  async reject(externalId: string, approverToken: string, reason: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/approvals/${encodeURIComponent(externalId)}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-approver-token": approverToken },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new ApprovalGatewayError(res.status);
  }
}
