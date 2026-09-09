import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mapWazuhAlert, validateWazuhAlert } from "./wazuh.js";
import { HttpM2Client, type M2Client } from "./m2client.js";

// 票 09：m1 告警接入的 webhook 正门（PRD §6-M1）。链路 = 接收校验 → 映射 → 不可信标记
// （校验/映射/标记都在 wazuh.ts 深模块）→ 写 M2 → 去重与发事件在 M2 侧完成。
// 去重不在本服务查表：唯一约束兜底在 M2 SQLite（m1 卡内部结构），本服务透传 dedup 结果——
// M2 回 201 就是新建，回 200 就是命中去重（幂等返回既有 id，不重复触发流水线）。
export function buildApp(opts: { m2?: M2Client } = {}) {
  const m2 = opts.m2 ?? new HttpM2Client(process.env.CASE_BACKEND_URL ?? "http://127.0.0.1:3002");
  const app = Fastify();

  app.get("/healthz", () => ({ ok: true, service: "ingest" }));

  // PRD §6-M1：格式非法（缺 rule.id/timestamp）与畸形 JSON 一律 422 invalid_alert；
  // Fastify 默认给畸形 JSON 400（err.statusCode=400），这里盖成 422
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (err instanceof SyntaxError || status === 400) {
      const reasons = [err instanceof Error ? err.message : String(err)];
      // 票 35（票 09-3）：422 且进审计（PRD 异常与边界）——畸形 JSON 的 FAILURE 条目，
      // body 解析不了所以 objectId=unknown。auditFailure 自吞错，绝不改变 422 本身。
      if (_req.url?.startsWith("/api/v1/webhooks")) {
        void m2.auditFailure({
          objectId: "unknown",
          details: { reasons },
          requestId: requestIdOf(_req.headers),
        });
      }
      return reply.status(422).send({ error: "invalid_alert", details: reasons });
    }
    return reply.status(500).send({ error: "internal_error" });
  });

  // 票 35：422 的 FAILURE 审计——objectId 尽力取声明告警 id（顶层 id 或 rule.id），
  // 取不到 unknown 占位；details 与 422 响应体的 reasons 同源（摘要，不复制整包载荷）。
  const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const declaredAlertId = (w: unknown): string => {
    const o = asObj(w);
    const id = asObj(o.rule).id ?? o.id;
    return id === undefined || id === null || id === "" ? "unknown" : String(id);
  };
  const requestIdOf = (h: Record<string, unknown>): string =>
    (typeof h["x-request-id"] === "string" && h["x-request-id"]) || randomUUID();

  app.post("/api/v1/webhooks/alerts", async (req, reply) => {
    const body: unknown = req.body;
    const alerts: unknown[] = Array.isArray(body) ? body : [body]; // FR-M1.1 单条/批量
    const details: string[] = [];
    alerts.forEach((w, i) => {
      const v = validateWazuhAlert(w);
      if (!v.ok) details.push(...v.details.map((d) => `[${i}] ${d}`));
    });
    if (details.length > 0 || alerts.length === 0) {
      // 票 35（票 09-3）：校验失败 422 同时向 M2 审计 FAILURE（actor=ingest），
      // objectId 取批里第一条声明的告警 id（溯源锚）；await 但 adapter 自吞错——
      // 审计挂了 422 照发，只是本地多一行 warn 日志。
      await m2.auditFailure({
        objectId: alerts.length > 0 ? declaredAlertId(alerts[0]) : "unknown",
        details: { reasons: details.length > 0 ? details : ["empty_body"] },
        requestId: requestIdOf(req.headers as Record<string, unknown>),
      });
      return reply.status(422).send({ error: "invalid_alert", details });
    }
    const results: { alert_id: string; dedup: boolean }[] = [];
    for (const w of alerts) {
      const r = await m2.ingestAlert(mapWazuhAlert(w));
      results.push({ alert_id: r.alertId, dedup: r.dedup });
    }
    if (Array.isArray(body)) return reply.status(200).send(results);
    return reply.status(results[0].dedup ? 200 : 201).send(results[0]);
  });

  return app;
}
