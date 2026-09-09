// 票 49：PII 受控反查的前端纯逻辑层（React 之外可单测，close.ts 同款套路）。
// - findPlaceholders：从任意文本里找出脱敏占位符 `<TYPE>`（去重保序）——
//   「文本里没有占位符就不出反查按钮」，不猜哪些字段会脱敏；
// - canRevealPii：角色闸的镜像（duty_lead/admin）——agent 端点是权威闸，这里
//   只是「可见性即第一收窄」（FR-M8.2 口径）；web 不 import 他包源码（边界规则），
//   两边名单一致性靠测试锚定（票 39 记票④先例）；
// - revealErrorText：反查失败的 ApiError → 人话（401/403/404/502 各有人话）。
//   （ApiError 按形状读 status/code——duck-typing，close.ts 同款，不引类型依赖。）

/** 反查可见角色（A.2 特殊化口径：PII 反查不走工具闸，端点白名单 duty_lead/admin；
 *  与 services/agent/src/app.ts 的 PII_REVEAL_ROLES 同源，改一边必红）。 */
export const PII_REVEAL_ROLES: ReadonlySet<string> = new Set(["duty_lead", "admin"]);

export function canRevealPii(role: string | undefined): boolean {
  return !!role && PII_REVEAL_ROLES.has(role);
}

// <TYPE>：大写字母开头、大写字母/数字/下划线组成、成对尖括号——普通文本里的
// 「a < b」、小写标签都不算（不误报）。
const PLACEHOLDER_RE = /<[A-Z][A-Z0-9_]*>/g;

export function findPlaceholders(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set(text.match(PLACEHOLDER_RE) ?? [])];
}

/** 反查失败 → 页面上直接能念的提示（ApiError 是输入）。 */
export function revealErrorText(e: unknown): string {
  const status = typeof e === "object" && e !== null && "status" in e
    ? Number((e as { status: unknown }).status)
    : NaN;
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (status === 401) return "会话已过期：请重新登录后再试反查";
  if (status === 403) return "PII 反查只对值班长/管理员开放，已留痕（你的角色无权限）";
  if (status === 404) return "映射表里查不到这个占位符（可能来自 mapstore 建立之前的脱敏）";
  if (status === 502) return "guards 不可达：反查失败，可稍后重试";
  return `反查失败：${code || String(e)}`;
}
