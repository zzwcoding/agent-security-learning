// 登录态管理测试（jsdom 提供 localStorage）：过期会话必须被拒（fail-closed），
// 刷新后从 localStorage 恢复，登出清干净。
import { beforeEach, describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  clearSession,
  loadSession,
  saveSession,
  sessionValid,
  toSession,
  type Session,
} from "./auth";

const raw = {
  session_id: "ses_x",
  token: "aaa.bbb",
  username: "soc1@soc.local",
  role: "soc1",
  role_label: "SOC1 分析师",
  visible_tools: ["get_alert", "kb_lookup"],
  expires_at: 2000,
};

function makeSession(over: Partial<Session> = {}): Session {
  return { ...toSession(raw), ...over };
}

beforeEach(() => localStorage.clear());

describe("session 纯函数", () => {
  it("toSession：wire 命名 → 前端命名", () => {
    const s = toSession(raw);
    expect(s).toEqual({
      token: "aaa.bbb",
      sessionId: "ses_x",
      username: "soc1@soc.local",
      role: "soc1",
      roleLabel: "SOC1 分析师",
      visibleTools: ["get_alert", "kb_lookup"],
      expiresAt: 2000,
    });
  });

  it("sessionValid：当前时刻严格早于 exp 才有效", () => {
    expect(sessionValid(makeSession(), 1999)).toBe(true);
    expect(sessionValid(makeSession(), 2000)).toBe(false); // JWT 语义：exp 当秒已过期
    expect(sessionValid(makeSession(), 2001)).toBe(false);
  });
});

describe("localStorage 持久化", () => {
  it("save → load 原样恢复；恢复时校验时效（nowSec 注入）", () => {
    saveSession(makeSession());
    expect(loadSession(1000)).toEqual(makeSession());
    expect(loadSession(5000)).toBeNull(); // 已过期 → 拒绝
  });

  it("过期会话 load 时顺手清掉，不留垃圾", () => {
    saveSession(makeSession());
    loadSession(5000);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("被篡改/损坏的存量数据 → null，不抛异常（fail-closed 不崩页面）", () => {
    localStorage.setItem(STORAGE_KEY, "not-json{{{");
    expect(loadSession(1000)).toBeNull();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 1 }));
    expect(loadSession(1000)).toBeNull();
  });

  it("clearSession 清干净", () => {
    saveSession(makeSession());
    clearSession();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
