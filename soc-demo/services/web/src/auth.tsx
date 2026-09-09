// 登录态管理（FR-M8.1 四预置身份登录）：React context 管状态（拍板口径：不引状态
// 管理库），localStorage 管持久化（浏览器刷新 → 会话恢复，PRD M10 异常与边界）。
// 会话本体是 agent 签发的 HMAC 会话 token（services/agent/workers/chat/session.ts），
// 前端只管保存/携带/过期判断——过期即清空回登录页（fail-closed，不猜时效）。
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { login, type LoginResponse } from "./api";

export interface Session {
  token: string;
  sessionId: string;
  username: string;
  role: string;
  roleLabel: string;
  visibleTools: string[];
  expiresAt: number;
}

export const STORAGE_KEY = "soc.web.session";

/** wire（snake_case）→ 前端命名。 */
export function toSession(res: LoginResponse): Session {
  return {
    token: res.token,
    sessionId: res.session_id,
    username: res.username,
    role: res.role,
    roleLabel: res.role_label,
    visibleTools: res.visible_tools,
    expiresAt: res.expires_at,
  };
}

/** JWT 语义：当前时刻（秒）严格早于 exp 才有效。nowSec 注入，测试不吃 wall clock。 */
export function sessionValid(s: Session, nowSec: number): boolean {
  return nowSec < s.expiresAt;
}

export function saveSession(s: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

/** 恢复登录态：过期/损坏一律 null 并顺手清掉（绝不让坏数据挡在登录页前面）。 */
export function loadSession(nowSec = Math.floor(Date.now() / 1000)): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Session>;
    if (
      typeof s.token !== "string" ||
      typeof s.username !== "string" ||
      typeof s.role !== "string" ||
      typeof s.roleLabel !== "string" ||
      typeof s.expiresAt !== "number" ||
      !Array.isArray(s.visibleTools)
    ) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (!sessionValid(s as Session, nowSec)) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return s as Session;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

interface AuthCtx {
  session: Session | null;
  login: (username: string) => Promise<Session>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const value = useMemo<AuthCtx>(
    () => ({
      session,
      login: async (username: string) => {
        const s = toSession(await login(username));
        saveSession(s);
        setSession(s);
        return s;
      },
      logout: () => {
        clearSession();
        setSession(null);
      },
    }),
    [session],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}
