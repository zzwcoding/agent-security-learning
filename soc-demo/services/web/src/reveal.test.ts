// 票 49：PII 受控反查的前端纯逻辑层（React 之外可单测，close.ts 同款套路）。
// - findPlaceholders：从任意文本里找出脱敏占位符 `<TYPE>`（去重保序）——
//   「文本里没有占位符就不出反查按钮」，不猜哪些字段会脱敏；
// - canRevealPii：角色闸的镜像（duty_lead/admin，与 agent 端点白名单同源 A.2
//   特殊化口径——web 不 import 他包源码，一致性靠测试锚定，票 39 记票④先例）；
// - revealErrorText：反查失败的 ApiError → 人话（401/403/404/502 各有人话）。
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { canRevealPii, findPlaceholders, revealErrorText } from "./reveal";

describe("findPlaceholders（占位符检测：没有就不出按钮，不猜）", () => {
  it("找出 <TYPE> 形占位符并去重保序", () => {
    expect(findPlaceholders("邮箱 <EMAIL_ADDRESS>，电话 <PHONE_NUMBER>，又一个 <EMAIL_ADDRESS>")).toEqual([
      "<EMAIL_ADDRESS>",
      "<PHONE_NUMBER>",
    ]);
  });

  it("非字符串/无占位符 → 空数组", () => {
    expect(findPlaceholders(null)).toEqual([]);
    expect(findPlaceholders(undefined)).toEqual([]);
    expect(findPlaceholders(42)).toEqual([]);
    expect(findPlaceholders("普通文本没有占位符")).toEqual([]);
  });

  it("小写/尖括号不成对不算占位符（不误报普通文本）", () => {
    expect(findPlaceholders("<email> 和 <phone_number>")).toEqual([]);
    expect(findPlaceholders("比较 a < b 且 c > d")).toEqual([]);
  });
});

describe("canRevealPii（角色镜像：duty_lead/admin）", () => {
  it("值班长与管理员可见；soc1/redteam/未登录不可见", () => {
    expect(canRevealPii("duty_lead")).toBe(true);
    expect(canRevealPii("admin")).toBe(true);
    expect(canRevealPii("soc1")).toBe(false);
    expect(canRevealPii("redteam")).toBe(false);
    expect(canRevealPii(undefined)).toBe(false);
  });
});

describe("revealErrorText（ApiError → 人话）", () => {
  it("401 会话过期 / 403 角色不够 / 404 查无此占位符 / 502 guards 不可达", () => {
    expect(revealErrorText(new ApiError(401, "unauthorized"))).toContain("重新登录");
    expect(revealErrorText(new ApiError(403, "pii_reveal_forbidden"))).toContain("值班长");
    expect(revealErrorText(new ApiError(404, "placeholder_unknown"))).toContain("查不到");
    expect(revealErrorText(new ApiError(502, "guards_unavailable"))).toContain("guards");
  });

  it("未知错误带 code 透传，不编理由", () => {
    expect(revealErrorText(new ApiError(500, "boom"))).toContain("boom");
  });
});
