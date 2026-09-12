// 椒图（agentjiaotu）形态的出站票据三 adapter（狗粮票 57，CONTEXT.md「狗粮接入」）。
// JIAOTU_GATEWAY_URL 设定时由 index.ts 装配整体换入，替换 token-ports.ts 的内部三件
// （HttpMintClient/HttpUsedTokenReader/HttpTokenBurner）——seam 已立（token-ports.ts
// 接口原样实现），链路代码零改；本文件的类不经装配绝不会被构造，默认形态零变化。
//
// wire 契约真源 = 椒图 services/gateway/src/identity/index.ts（票 17 后核实：
// internal 口已统一认证——mint/burned/burn 三口都要 Bearer agent api_key）：
//   铸任务票  POST /internal/tickets/mint   头 authorization: Bearer <agent api_key>，
//             201 {token, jti, exp}（401/4xx/5xx 一律抛，铸票在同步路径上）
//   查焚毁    GET  /internal/tickets/:jti/burned  头 authorization: Bearer <agent api_key>，
//             200 {burned: bool}（未登记的 jti 也是 200 {burned:false}——所以非 200 一律抛，
//             INV-1 fail-closed 口径同内部读口）
//   焚毁发起  POST /internal/tickets/:jti/burn  头 authorization: Bearer <agent api_key>，
//             幂等 {jti, first_time}；写侧 fire-and-forget 口径与内部 burner 相同
//
// 字段映射（§4.1 逐字段对照）：soc-demo `sub` → `agent_identity`、`caseId ?? ""` →
// `case_id`，其余 snake_case 一一对应；jti 由 soc-demo 侧生成（同 HttpMintClient 现口径）。
// 响应合成：椒图 201 {token,jti,exp} → MintedToken{token, payload:{jti,exp}}——消费方
// 只用 `.token` 与 `.payload.jti`，payload 是合成壳不是票面。
//
// INV-2 单口（审批铸票）：椒图只许 g4（审批模块）铸审批票（x-internal-caller 闸，
// identity/index.ts:772-788）。外部模式 soc-demo 不自铸审批票——token 经批准响应中继
// 回来（审批对接属票 58）。谁调 mintApprovalToken 都是误用，到此必炸且点名 g4。
//
// 超时统一 AbortSignal.timeout(2000)，与内部三件同口径；fetchImpl 构造注入
// （GatewayLlmClient 先例），契约测试捕获请求形态，绝不真出网。
import {
  type MintClient,
  type MintedToken,
  type TaskTicketRequest,
  type TokenBurner,
  type UsedTokenReader,
} from "../token-ports.js";

/** 出站超时：三件统一 2s（同内部三件口径；burn 的 2s 到时以 TimeoutError 形态走失败日志）。 */
const TIMEOUT_MS = 2000;

/** 椒图铸票 201 响应形（identity/index.ts MintedTicket）。 */
interface JiaoTuMinted {
  token: string;
  jti: string;
  exp: number;
}

/** 三 adapter 共用的构造注入：生产缺省吃 env（baseUrl=JIAOTU_GATEWAY_URL、
 *  apiKey=JIAOTU_API_KEY），测试注入 fetchImpl/显式值覆盖，绝不真出网。 */
export interface JiaoTuClientOpts {
  baseUrl?: string;
  /** 三口共用（票 17 起椒图 internal 口统一认证，出站全带 Bearer） */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

// ---------- 铸任务票（POST /internal/tickets/mint，端点即票型——无 type 判别字段） ----------

export class JiaoTuMintClient implements MintClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JiaoTuClientOpts = {}) {
    // 缺省服务名按设计文档 §4.1 的 compose 口径（jiaotu-gateway，椒图 GATEWAY_PORT 默认 8080）
    this.baseUrl = opts.baseUrl ?? process.env.JIAOTU_GATEWAY_URL ?? "http://jiaotu-gateway:8080";
    this.apiKey = opts.apiKey ?? process.env.JIAOTU_API_KEY ?? "";
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  async mintTaskTicket(req: TaskTicketRequest): Promise<MintedToken> {
    // 票 17：椒图 mint 口已统一认证，缺 key 出站即 401（椒图侧 401 + DENIED 审计）——
    // 本侧不做静默重试/降级，非 2xx 直接抛，worker 拉起立刻看见配置缺口
    const res = await this.fetchImpl(`${this.baseUrl}/internal/tickets/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        agent_identity: req.sub,
        scope: req.scope,
        case_id: req.caseId ?? "",
        run_id: req.runId,
        allowed_tools: req.allowedTools,
        jti: req.jti,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // 铸票在同步路径上（worker 拉起必须立刻看见失败）：非 2xx 一律抛，只记状态码
      // 不记正文——上游错误文本不许流入我们的审计/事件面（INV-4 邻域卫生，同 llm-client）
      throw new Error(`jiaotu mint failed: HTTP ${res.status}`);
    }
    const minted = (await res.json()) as JiaoTuMinted;
    // 响应合成（差距 G4）：椒图回 {token,jti,exp}， MintClient 消费方期待 payload 壳——
    // jti/exp 原样进壳，票面本体仍在 token 里（验签真相在闸侧，不在这里拆）
    return { token: minted.token, payload: { jti: minted.jti, exp: minted.exp } };
  }

  async mintApprovalToken(): Promise<MintedToken> {
    // INV-2 单口：审批票唯一铸造口在椒图 g4（x-internal-caller 闸）。外部模式 soc-demo
    // 侧审批 token 走「批准响应中继」（票 58），不走本口——调到这里就是误用，炸响不静默
    // （async 保证以 rejected promise 形态炸，调用侧 await/try-catch 必接得住）。
    throw new Error("approval mint belongs to gateway g4");
  }
}

// ---------- 焚毁读口（GET /internal/tickets/:jti/burned，INV-1 fail-closed 纪律不变） ----------

export class JiaoTuUsedTokenReader implements UsedTokenReader {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JiaoTuClientOpts = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.JIAOTU_GATEWAY_URL ?? "http://jiaotu-gateway:8080";
    this.apiKey = opts.apiKey ?? process.env.JIAOTU_API_KEY ?? "";
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  async lookup(jti: string): Promise<boolean> {
    // 票 17：焚毁账读口同样统一认证（与 burner 同一把 agent api_key）
    const res = await this.fetchImpl(
      `${this.baseUrl}/internal/tickets/${encodeURIComponent(jti)}/burned`,
      {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    // 椒图口径：未登记的 jti 也回 200 {burned:false}——401/404/5xx/不可达都是「病」，
    // 一律抛给闸侧 fail-closed（INV-1）：「查不到真相」绝不冒充「真相是没有」
    if (res.status !== 200) {
      throw new Error(`jiaotu burned lookup failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { burned: unknown };
    return body.burned === true;
  }
}

// ---------- 焚毁发起（POST /internal/tickets/:jti/burn，Bearer api_key，fire-and-forget） ----------

export class JiaoTuTokenBurner implements TokenBurner {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JiaoTuClientOpts = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.JIAOTU_GATEWAY_URL ?? "http://jiaotu-gateway:8080";
    this.apiKey = opts.apiKey ?? process.env.JIAOTU_API_KEY ?? "";
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  /** source 参数不进椒图 wire（焚毁口只认路径 jti + Bearer 头，identity/index.ts:817-847），
   *  接口形保留（TokenBurner 契约），实现按椒图口径只发 jti。 */
  burn(jti: string): void {
    // fire-and-forget（INV-2 写侧口径不变）：执行器同步循环，best-effort 发出即返回；
    // 椒图幂等（first_time 语义在网关侧），失败只打结构化日志——重放防线另有
    // executed_at + TTL 兜底（同内部 HttpTokenBurner 的缝位说明）
    void this.fetchImpl(`${this.baseUrl}/internal/tickets/${encodeURIComponent(jti)}/burn`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) {
          // 网关侧拒绝（401 未注册/非 active 等）：写口失败可见不阻塞，只记状态码不记正文
          console.error(
            JSON.stringify({ warn: "jiaotu_burn_failed", jti, error: `HTTP ${res.status}` }),
          );
        }
      })
      .catch((e: unknown) => {
        // 网络错/2s 超时（TimeoutError）同落结构化日志，字段口径与内部 burner 一致
        console.error(JSON.stringify({ warn: "jiaotu_burn_failed", jti, error: String(e) }));
      });
  }
}
