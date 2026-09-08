// agent 侧共享错误类：带 httpStatus，app.setErrorHandler 统一映射（case-backend 同款模式）。
export class NotFoundError extends Error {
  readonly code = "not_found";
  readonly httpStatus = 404;
  constructor(what: string) {
    super(`not_found: ${what}`);
    this.name = "not_found";
  }
}

// 票 18（FR-M8.1）：会话缺失/坏票/过期一律 401，Web 据此引导重登录（PRD M8 异常与边界）。
export class UnauthorizedError extends Error {
  readonly code = "unauthorized";
  readonly httpStatus = 401;
  constructor() {
    super("unauthorized: missing, malformed or expired session");
    this.name = "unauthorized";
  }
}
