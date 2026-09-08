// m8 对话 Copilot · 教学版会话（FR-M8.1「四种预置身份选择登录，会话绑定角色 claims」）。
//
// 系统不设用户管理界面（PRD §11 边界）：四个身份由种子预置，登录 = 选一个脸。会话本体
// 是一张 HMAC 签名的两段式 token（b64url(payload).hex(hmac_sha256)）——与任务票/审批票
// 同一门 HMAC 纪律（SOC_HMAC_KEY），但**不是票**：票管工具执行授权（m9），会话只管
// 「你是哪位」，claims 里只有 sub/role，没有任何工具 scope（INV-3 的反面教材位）。
// 与三段式票在 wire 上肉眼可分，防止有人拿会话当票使。
import { createHmac, timingSafeEqual } from "node:crypto";

export interface PresetIdentity {
  username: string;
  role: string;
  label: string;
}

/** 四预置身份（PRD §3 角色表 + gateway plugins/config.yaml user_map 同一映射）。
 *  红队也有登录位——越权演示从正门走：登录成功，但 A.2 里它一格授权都没有。 */
export const PRESET_IDENTITIES: PresetIdentity[] = [
  { username: "soc1@soc.local", role: "soc1", label: "SOC1 分析师" },
  { username: "duty_lead@soc.local", role: "duty_lead", label: "值班长（SOC2+）" },
  { username: "admin@soc.local", role: "admin", label: "安全工程师（管理员）" },
  { username: "redteam@soc.local", role: "redteam", label: "红队（演示）" },
];

export interface SessionClaims {
  sid: string;
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

/** 教学版会话 TTL：12 小时。过期 → 401 引导重登录（PRD M8 异常与边界）。 */
export const SESSION_TTL_S = 12 * 3600;

function signHex(key: string, unsigned: string): string {
  return createHmac("sha256", Buffer.from(key, "utf8")).update(unsigned, "utf8").digest("hex");
}

/** 签会话 token：b64url(payload JSON).hex(hmac)。payload 字段集 = SessionClaims。 */
export function signSession(claims: SessionClaims, key: string): string {
  const b64p = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${b64p}.${signHex(key, b64p)}`;
}

/** 验会话：恒时比签 → 验字段形状 → 验时效。任何一步不过 = null（fail-closed，INV-1）。
 *  nowSec 注入当前时刻（与 verifyTicket 同一 clock policy：测试不许吃 wall clock）。 */
export function verifySession(token: string, key: string, nowSec: number): SessionClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [b64p, sig] = parts;
    const expected = Buffer.from(signHex(key, b64p), "utf8");
    const got = Buffer.from(sig, "utf8");
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    const p = JSON.parse(Buffer.from(b64p, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof p.sid !== "string" || typeof p.sub !== "string" || typeof p.role !== "string" ||
      typeof p.iat !== "number" || typeof p.exp !== "number"
    ) {
      return null;
    }
    if (nowSec >= p.exp) return null; // JWT 语义：当前时刻须严格早于 exp
    return p as unknown as SessionClaims;
  } catch {
    return null;
  }
}
