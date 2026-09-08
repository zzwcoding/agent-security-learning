// agent 侧共享错误类：带 httpStatus，app.setErrorHandler 统一映射（case-backend 同款模式）。
export class NotFoundError extends Error {
  readonly code = "not_found";
  readonly httpStatus = 404;
  constructor(what: string) {
    super(`not_found: ${what}`);
    this.name = "not_found";
  }
}
