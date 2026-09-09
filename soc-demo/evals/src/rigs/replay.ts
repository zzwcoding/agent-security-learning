// m11 eval 体系 · replay 维 rig（票 44·F6 自 scenarios.ts 拆出；素材 = 票 09 INV-6：
// ingest webhook 正门 → 真 case-backend SQLite 约束，推两遍不重复建案）。
import { readFileSync } from "node:fs";
import { buildApp as buildIngestApp } from "../../../services/ingest/src/app.js";
import { HttpM2Client } from "../../../services/ingest/src/m2client.js";
import { replay, replayOne } from "../../../scripts/replay.js";
import { httpJson, startCaseBackend, type CaseBackend } from "../../../services/agent/workers/triage/testkit.js";
import { FIXTURES_ALERTS, check, skeleton, type ScenarioOutcome } from "./shared.js";
import type { EvalCase, M2AuditRow } from "../types.js";

async function replayRig(): Promise<{ url: string; backend: CaseBackend; close: () => Promise<void> }> {
  const backend = await startCaseBackend();
  const app = buildIngestApp({ m2: new HttpM2Client(backend.url) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    backend,
    close: () => new Promise((resolve) => app.close(() => backend.close().then(resolve))),
  };
}

export async function scenarioReplayDedup(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await replayRig();
  try {
    if (c.alertFixturePath === null) throw new Error(`${c.fullName}：replay 布景需要 alert_fixture`);
    const payload = readFileSync(c.alertFixturePath, "utf8");
    const file = c.dirName;
    const r1 = await replayOne(rig.url, file, payload);
    const r2 = await replayOne(rig.url, file, payload);
    const alertId = r1.alertId ?? "";
    const alertRes = await httpJson(rig.backend.url, "GET", `/api/v1/alerts/${alertId}`);
    const occurrences = Number((alertRes.json as { occurrences?: number }).occurrences ?? 0);
    const allAlerts = (await httpJson(rig.backend.url, "GET", "/api/v1/alerts")).json as { alerts?: unknown[] } | unknown[];
    const list = Array.isArray(allAlerts) ? allAlerts : (allAlerts.alerts ?? []);
    const auditsRes = await httpJson(rig.backend.url, "GET", `/api/v1/audit?objectId=${alertId}`);

    const ev = skeleton(c.fullName, "replay-dedup", {
      auditM2: auditsRes.json as unknown as M2AuditRow[],
      verdictAi: { push1: { status: r1.status, dedup: r1.dedup }, push2: { status: r2.status, dedup: r2.dedup }, occurrences },
    });
    const extraChecks = [
      check("replay_dedup_same_id",
        r1.status === 201 && r1.dedup === false && r2.status === 200 && r2.dedup === true && r2.alertId === r1.alertId,
        `第一推 ${r1.status}(新建) → 第二推 ${r2.status}(dedup=${String(r2.dedup)})，同一条 alert ${alertId}`),
      check("replay_occurrences_incremented", occurrences === 2, `occurrences=${occurrences}（+1 刷新，不新建行）`),
      check("replay_no_second_case", list.length === 1, `账面告警数=${list.length}（INV-6：不重复建案）`),
    ];
    return { evidence: ev, extraChecks };
  } finally {
    await rig.close();
  }
}

export async function scenarioReplayDataset(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await replayRig();
  try {
    // scripts/replay.ts 的行为契约：整目录按速率推两遍，第二遍全 dedup
    const pass1 = await replay({ url: rig.url, dir: FIXTURES_ALERTS, rate: 50 });
    const pass2 = await replay({ url: rig.url, dir: FIXTURES_ALERTS, rate: 50 });
    const created1 = pass1.filter((r) => r.status === 201).length;
    const dedup2 = pass2.filter((r) => r.dedup === true).length;
    const allAlerts = (await httpJson(rig.backend.url, "GET", "/api/v1/alerts")).json as { alerts?: unknown[] } | unknown[];
    const list = Array.isArray(allAlerts) ? allAlerts : (allAlerts.alerts ?? []);

    const ev = skeleton(c.fullName, "replay-dataset", {
      auditM2: [],
      verdictAi: { files: pass1.length, pass1_created: created1, pass2_dedup: dedup2, alerts_total: list.length },
    });
    const extraChecks = [
      check("replay_dataset_first_pass_creates",
        pass1.length > 0 && created1 === pass1.length,
        `第一遍 ${pass1.length} 条全新建（created=${created1}）`),
      check("replay_dataset_second_pass_all_dedup",
        dedup2 === pass2.length,
        `第二遍 ${pass2.length} 条全 dedup（dedup=${dedup2}，created=${pass2.filter((r) => r.status === 201).length}）`),
      check("replay_dataset_alert_count_stable",
        list.length === pass1.length,
        `推了两遍账面仍 ${list.length} 条告警（=文件数，不重复建案）`),
    ];
    return { evidence: ev, extraChecks };
  } finally {
    await rig.close();
  }
}
