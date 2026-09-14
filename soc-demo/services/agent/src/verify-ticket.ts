// m9 验票闸（票 07）：所有工具调用执行前的唯一关卡——
//   verifyTicket(toolCall, ctx, now) → {allow:true} | {allow:false, code:403, reason}
// PRD 设计哲学：LLM 是不可信的决策者——它嘴里说「我要调 isolate_host」不算数，
// 手里有没有我们盖过钢印的合法票才算数。挂点在 LangGraph 工具调用封装层（票 10+ 接线）。
//
// 裁决顺序与 py 铸币侧 mint.verify() 同序参照（签名 → 时效 → 焚毁 → scope/参数），
// fail-closed：任何一步不过立刻短路 403；闸体任何异常也归 403（INV-1）。
// reason 枚举 = contract.json.reasons：PRD FR-S2.2 六种 403 + allow +
// signature_invalid（本契约扩展，fail-closed 桶的名字，见 fixtures/tickets/README.md）。
//
// 票 27 换闸（agent-guard 狗粮首用）：票面裁决真相（签名/exp/jti/焚毁/allowed_tools/
// params_hash 六判据）改由 @agentjiaotu/agent-guard 纯函数面出具（verifyToken /
// verifyTokenSignature / paramsHash）——不接 createGuard 整闸（其 L2 放行前同步焚毁
// 撞「用后焚」红线③，且要求 soc-demo 不存在的三个 HTTP 缝）。soc-demo 侧保留：
// tierOf 分级控制流（红线②，表源 tools-manifest.json 不换——包「未登记→
// scope_insufficient」语义不被引入，口径仍是 no_ticket）、case/run 绑定（红线①）、
// unseal+asClaims 形状预闸（soc 序：形状先于 exp）、7 值 reason、带 payload 返回形、
// 闸内零焚毁（BurnRegistry.has 一行桥接包 isBurned，写侧仍由执行方用后焚）、
// fail-closed 桶名 signature_invalid（INV-1）。公共面逐名冻结——消费方零改动。
// 安全注记：包 verifyToken 的审批分支只查 params_hash 不查 tool（包 token.ts:103-109），
// 审批路径必须自查 p.tool（与包闸面 createGuard 的 L2 自排同构，包 guard.ts:251-254），
// 否则「错工具+对参数」从 scope_insufficient 变 allow——回归锁在 verify-ticket.guard-adapter.test.ts。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { paramsHash as guardParamsHash, verifyToken, verifyTokenSignature } from "@agentjiaotu/agent-guard";

export type DenyReason =
  | "no_ticket"
  | "scope_insufficient"
  | "token_expired"
  | "token_used"
  | "params_mismatch"
  | "require_approval"
  | "signature_invalid";

export type VerifyResult =
  | { allow: true; reason: "allow"; payload?: TicketClaims | ApprovalClaims }
  | { allow: false; code: 403; reason: DenyReason };

/** 焚毁表 seam：闸只读（has）。生产实现在 M2 used_tokens 表（票 03，审计同库同事务）；
 *  MemoryBurnRegistry 是单测/演示用的内存适配器——执行方在工具执行成功后调 burn 登记。 */
export interface BurnRegistry {
  has(jti: string): boolean;
}

export class MemoryBurnRegistry implements BurnRegistry {
  private readonly burned = new Set<string>();
  has(jti: string): boolean {
    return this.burned.has(jti);
  }
  burn(jti: string): void {
    this.burned.add(jti);
  }
}

export interface VerifyCtx {
  /** 任务票 wire 串（票 10 起由 M3 拉起 worker 时申领）。传 wire 原串而非解析后的对象，
   *  闸才能真验签——PRD §5.8 的 JSON 是数据模型示意，线上形态以 fixtures/tickets/ 契约为准。 */
  ticket?: string;
  /** ApprovalToken wire 串（票 11 起由审批卡批准后铸出）。 */
  approvalToken?: string;
  /** 当前案件/run——case-run 绑定校验（FR-S2.2）：票不是万能通行证。 */
  caseId?: string;
  runId?: string;
  /** 焚毁表读口（INV-2 防重放）；不传 = 不查（仅测试便利，生产必传）。 */
  used?: BurnRegistry;
}

export interface VerifyOpts {
  /** HMAC 密钥（UTF-8 原始字节，两端共享同一枚，ADR 0001）；缺省读 env SOC_HMAC_KEY。 */
  hmacKey?: string;
}

export interface TicketClaims {
  jti: string;
  sub: string;
  case_id: string;
  run_id: string;
  scope: string[];
  allowed_tools: string[];
  iat: number;
  exp: number;
}

export interface ApprovalClaims {
  jti: string;
  approval_id: string;
  approved_by: string;
  tool: string;
  params_hash: string;
  case_id: string;
  iat: number;
  exp: number;
  used: boolean;
}

// 工具分级（FR-S2.1）：分级知识住在 fixtures/tools.manifest.json 登记表（票 48，
// ADR 0004-2——原票 07 的手写小表已退役）。tierOf：L0 只读免验 / L1 写需任务票 /
// L2 高危需审批铸票；未登记工具按登记表 policy 的默认级对待——fail-closed 更严口径
// （默认 L1）：没登记就没票可用，无票一律 403。manifest 读不到/JSON 坏 → tierOf 抛
// → 落进下面闸体的 try 收进 403（INV-1：闸的粮草病了也绝不放行）。
import { tierOf } from "./tools-manifest.js";

function deny(reason: DenyReason): VerifyResult {
  return { allow: false, code: 403, reason };
}

/** 参数规范化 hash——与 py json.dumps(ensure_ascii=False, sort_keys=True,
 *  separators=(",",":")) 逐字节一致（INV-2 的锚，跨语言契约测试锁死）。 */
export function paramsHash(params: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalJson(params), "utf8").digest("hex");
}

// JSON.stringify 默认无空格（= py 的紧凑分隔符）；只差键序——递归排好再序列化。
// 数组保序（py sort_keys 只排 dict 键）；undefined 序列化成 null（py 无此值，防御性兜底）。
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function signHex(key: Buffer, unsigned: string): string {
  return createHmac("sha256", key).update(unsigned, "utf8").digest("hex");
}

// 恒时比较（py hmac.compare_digest 对位）：不管第几个字节不同耗时都一样，防按响应时间试探签名
function sigMatches(expectedHex: string, got: string): boolean {
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 解码 + 验签（py unseal 对位）：格式坏/签名不符/JSON 坏 → 抛异常，由闸体统一收进
 *  signature_invalid。签名校验在 json 解析之前——被篡改过的字节永远没机会进解析器。 */
function unseal(key: Buffer, token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [b64h, b64p, sig] = parts;
  if (!sigMatches(signHex(key, `${b64h}.${b64p}`), sig)) throw new Error("signature mismatch");
  return JSON.parse(Buffer.from(b64p, "base64url").toString("utf8")) as Record<string, unknown>;
}

// payload 形状把关：py 里缺字段会 KeyError 自己炸出来再被接住；TS 读到 undefined 不炸，
// undefined 参与比较会静默漏过——必须显式验型，否则 fail-closed 有洞。
function reqStr(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== "string") throw new Error(`bad claim: ${k}`);
  return v;
}
function reqNum(p: Record<string, unknown>, k: string): number {
  const v = p[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`bad claim: ${k}`);
  return v;
}
function reqStrArr(p: Record<string, unknown>, k: string): string[] {
  const v = p[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`bad claim: ${k}`);
  return v as string[];
}

function asTicketClaims(p: Record<string, unknown>): TicketClaims {
  return {
    jti: reqStr(p, "jti"),
    sub: reqStr(p, "sub"),
    case_id: reqStr(p, "case_id"),
    run_id: reqStr(p, "run_id"),
    scope: reqStrArr(p, "scope"),
    allowed_tools: reqStrArr(p, "allowed_tools"),
    iat: reqNum(p, "iat"),
    exp: reqNum(p, "exp"),
  };
}

function asApprovalClaims(p: Record<string, unknown>): ApprovalClaims {
  const used = p["used"];
  if (typeof used !== "boolean") throw new Error("bad claim: used");
  return {
    jti: reqStr(p, "jti"),
    approval_id: reqStr(p, "approval_id"),
    approved_by: reqStr(p, "approved_by"),
    tool: reqStr(p, "tool"),
    params_hash: reqStr(p, "params_hash"),
    case_id: reqStr(p, "case_id"),
    iat: reqNum(p, "iat"),
    exp: reqNum(p, "exp"),
    used,
  };
}

/** 验票闸本体（m9 卡公开接口）。nowSec 注入当前时刻（unix 秒，iat/exp 同域）——
 *  契约 clock policy 禁 wall clock，测试一律传 fixture 的 verify_now。 */
export function verifyTicket(
  toolCall: { name: string; params?: unknown },
  ctx: VerifyCtx = {},
  nowSec: number = Math.floor(Date.now() / 1000),
  opts: VerifyOpts = {},
): VerifyResult {
  // INV-1 fail-closed：整个闸体包进 try——密钥缺失、焚毁表炸了、参数序列化失败……
  // 闸自己病了也一律 403，绝不向上抛、更绝不放行。归 signature_invalid：
  // 契约 reasons_note 把它定为 fail-closed 桶的名字。
  try {
    const keyRaw = opts.hmacKey ?? process.env.SOC_HMAC_KEY;
    if (!keyRaw) return deny("signature_invalid"); // 与 gateway 铸票缺密钥拒签同一口径

    // 用 typeof 判分支而非真值判断：空串票 "" 是「坏票」（→signature_invalid），不是「没带票」
    if (typeof ctx.approvalToken === "string") return verifyApproval(keyRaw, toolCall, ctx, nowSec);
    if (typeof ctx.ticket === "string") return verifyTaskTicket(keyRaw, toolCall, ctx, nowSec);

    // 闸控制流：手里什么签名票都没有（no_ticket/require_approval 不是票面状态，
    // 不由票面 fixture 覆盖——README「reason 枚举」节）
    if (tierOf(toolCall.name) === 0) return { allow: true, reason: "allow" }; // L0 只读免验
    if (tierOf(toolCall.name) === 2) return deny("require_approval"); // L2 必须经人审批铸票（FR-S2.4）
    return deny("no_ticket"); // L1 写工具（含未登记默认级）没带票
  } catch {
    return deny("signature_invalid");
  }
}

// 任务票路径（PRD §5.8）：worker 的任务级最小 scope 票。
// 分工照包闸面自己的用法（guard.ts:216）：soc 出形状闸 + 语境（case/run 绑定），
// 包 verifyToken 出票面真相——签名→exp→jti→焚毁→allowed_tools（包 token.ts:91-116，
// 与 soc 原 :218-220 判据全序等价）。
function verifyTaskTicket(
  keyRaw: string,
  toolCall: { name: string; params?: unknown },
  ctx: VerifyCtx,
  nowSec: number,
): VerifyResult {
  const key = Buffer.from(keyRaw, "utf8");
  const p = asTicketClaims(unseal(key, ctx.ticket as string)); // 形状预闸留 soc（8 字段，先于 exp）
  const v = verifyToken(keyRaw, ctx.ticket as string, {
    tool: toolCall.name,
    now: nowSec, // 契约 clock policy：显式注入，禁 wall clock（两边同文）
    // BurnRegistry.has → 包 isBurned 一行桥接（语义零翻译）；焚毁写侧不在这里——闸内零焚毁（红线③）
    isBurned: (jti) => ctx.used?.has(jti) ?? false,
  });
  if (!v.allow) return deny(v.reason); // signature_invalid | token_expired | token_used | scope_insufficient（⊂ soc 7 值，零映射）
  if (ctx.caseId !== undefined && p.case_id !== ctx.caseId) return deny("scope_insufficient"); // case 绑定（红线①，soc 语境判据）
  if (ctx.runId !== undefined && p.run_id !== ctx.runId) return deny("scope_insufficient"); // run 绑定
  return { allow: true, reason: "allow", payload: p };
}

// ApprovalToken 路径（PRD §5.9）：L2 动作经人批准后的一次性令牌。
// 分工照包闸面自己的 L2 用法（guard.ts:236-259）：包 verifyTokenSignature 出签名+exp
// 真相，其余判据闸层自排——【安全注记】包纯函数 verifyToken 的审批分支不查 tool
// （包 token.ts:103-109），这里必须自查 p.tool，否则「错工具+对参数」会放行。
// used 先于 tool 的 soc 序保留；params_hash 比对用包 paramsHash（JSON 域与 soc 实现
// 逐字节一致，双仓各有 py 锚点契约测试）。
function verifyApproval(
  keyRaw: string,
  toolCall: { name: string; params?: unknown },
  ctx: VerifyCtx,
  nowSec: number,
): VerifyResult {
  const key = Buffer.from(keyRaw, "utf8");
  const token = ctx.approvalToken as string;
  const p = asApprovalClaims(unseal(key, token)); // 形状预闸留 soc（9 字段，先于 exp）
  const v = verifyTokenSignature(keyRaw, token, nowSec);
  if (!v.ok) return deny(v.reason); // signature_invalid | token_expired
  if (ctx.used?.has(p.jti)) return deny("token_used"); // 一次性（INV-2：重放必 403；闸只读，焚毁写侧在执行方）
  if (p.tool !== toolCall.name) return deny("scope_insufficient"); // 安全判据：票只对铸造时的那个工具有效（闸自查，包不代查）
  // 参数指纹比对：改参数即失效（FR-S2.2/INV-2 的全部机制就这一句话）
  if (guardParamsHash(toolCall.params) !== p.params_hash) return deny("params_mismatch");
  if (ctx.caseId !== undefined && p.case_id !== ctx.caseId) return deny("scope_insufficient"); // case 绑定（红线①）
  return { allow: true, reason: "allow", payload: p };
}
