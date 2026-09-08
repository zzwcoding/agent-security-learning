// 票 14 · m5 调查报告进 Timeline 的 m2 侧配套：POST /cases/:id/timeline 透传
// structured 机读负载（PRD §5.5 TimelineEntry.structured —— FR-M5.4 的落库形态）。
import { expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";

test("timeline 写入透传 structured，读回原样；不带 structured 时为 null", async () => {
  const app = buildApp({ db: openDb(":memory:") });
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/cases",
    payload: { title: "[wazuh_alert] - centos7 - 2026-09-08" },
  });
  expect(created.statusCode).toBe(201);
  const caseId = (created.json() as { id: string }).id;

  const report = {
    summary: "ssh 暴力破解关联调查",
    severity_assessment: 3,
    confidence: 0.8,
    findings: [{ entity: "18.18.18.18", evidence: "Invalid user blimey", source_tool: "siem_query" }],
    affected_assets: ["centos7"],
    recommended_actions: [{ tool: "isolate_host", params: { host: "centos7" }, justification: "持续爆破" }],
    kb_refs: [],
    incomplete: false,
  };
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/timeline`,
    payload: { kind: "investigation_report", author: "agent:investigation", body: "## 调查报告", structured: report },
  });
  expect(res.statusCode).toBe(201);

  const list = await app.inject({ method: "GET", url: `/api/v1/cases/${caseId}/timeline` });
  const entries = list.json() as { kind: string; structured: unknown }[];
  expect(entries).toHaveLength(1);
  expect(entries[0].kind).toBe("investigation_report");
  expect(entries[0].structured).toEqual(report); // 机读负载原样读回（eval/检索用）

  const plain = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/timeline`,
    payload: { kind: "note", author: "soc1", body: "手工备注" },
  });
  expect(plain.statusCode).toBe(201);
  const list2 = await app.inject({ method: "GET", url: `/api/v1/cases/${caseId}/timeline` });
  const entries2 = list2.json() as { kind: string; structured: unknown }[];
  expect(entries2[1].structured).toBeNull();
  await app.close();
});
