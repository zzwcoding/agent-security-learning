// m11 eval 体系 · replay 维 rig（票 44·F6 自 scenarios.ts 拆出；素材 = 票 09 INV-6：
// ingest webhook 正门 → 真 case-backend SQLite 约束，推两遍不重复建案）。
// 票 46（边界盲区收口）：不再 import scripts/replay.js（自票 44 前 scenarios.ts 逐字
// 搬移，落在 R2 只圈 services 向 / R4 只圈 services 向之间的盲区）——照票 28 E3 同款
// 口径改子进程执行：execFile tsx scripts/replay.ts，断言对象换成 CLI stdout 的行为面
// （逐条行 `  {file} -> {status}[ alert_id=…][ dedup]` + 汇总行 `replay done: …`）。
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildApp as buildIngestApp } from "../../../services/ingest/src/app.js";
import { HttpM2Client } from "../../../services/ingest/src/m2client.js";
import { httpJson, startCaseBackend, type CaseBackend } from "../../../services/agent/workers/triage/testkit.js";
import { FIXTURES_ALERTS, check, skeleton, type ScenarioOutcome } from "./shared.js";
import type { EvalCase, M2AuditRow } from "../types.js";

const run = promisify(execFile);
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const REPLAY_TS = fileURLToPath(new URL("../../../scripts/replay.ts", import.meta.url));

/** CLI 一条回放记录的 stdout 行为面（与 ReplayRecord 字段一一对应；dedup 缺省=false）。 */
interface CliRecord {
  file: string;
  status: number;
  alertId?: string;
  dedup: boolean;
}

/** 解析 scripts/replay.ts 的 stdout：逐条行 + 汇总行（缺汇总行 = CLI 没跑完，直接炸）。 */
function parseReplayStdout(stdout: string): { records: CliRecord[]; created: number; dedup: number } {
  const records: CliRecord[] = [];
  for (const m of stdout.matchAll(/^ {2}(\S+) -> (\d+)(.*)$/gm)) {
    records.push({
      file: m[1],
      status: Number(m[2]),
      alertId: /alert_id=(\S+)/.exec(m[3])?.[1],
      dedup: / dedup/.test(m[3]),
    });
  }
  const summary = stdout.match(/replay done: (\d+) pushed, (\d+) created, (\d+) dedup/);
  if (!summary) throw new Error(`replay CLI 汇总行缺失（stdout 尾部：${stdout.slice(-300)}）`);
  return { records, created: Number(summary[2]), dedup: Number(summary[3]) };
}

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
    // CLI 吃目录不吃单文件，且只认 *.json：同一条 fixture 落进临时目录（文件名 =
    // `${dirName}.json`），连推两遍的语义与原 replayOne 直调一致（同一 payload POST 两次）
    const dir = await mkdtemp(join(tmpdir(), "replay-dedup-"));
    await writeFile(join(dir, `${c.dirName}.json`), readFileSync(c.alertFixturePath, "utf8"));
    try {
      const args = ["--url", rig.url, "--dir", dir, "--rate", "1000"];
      const p1 = parseReplayStdout((await run(TSX, [REPLAY_TS, ...args], { timeout: 30_000 })).stdout);
      const p2 = parseReplayStdout((await run(TSX, [REPLAY_TS, ...args], { timeout: 30_000 })).stdout);
      const r1 = p1.records[0]!;
      const r2 = p2.records[0]!;
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
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await rig.close();
  }
}

export async function scenarioReplayDataset(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await replayRig();
  try {
    // scripts/replay.ts 的行为契约：整目录按速率推两遍，第二遍全 dedup（子进程两跑读汇总行）
    const args = ["--url", rig.url, "--dir", FIXTURES_ALERTS, "--rate", "50"];
    const p1 = parseReplayStdout((await run(TSX, [REPLAY_TS, ...args], { timeout: 30_000 })).stdout);
    const p2 = parseReplayStdout((await run(TSX, [REPLAY_TS, ...args], { timeout: 30_000 })).stdout);
    const created1 = p1.created;
    const dedup2 = p2.dedup;
    const allAlerts = (await httpJson(rig.backend.url, "GET", "/api/v1/alerts")).json as { alerts?: unknown[] } | unknown[];
    const list = Array.isArray(allAlerts) ? allAlerts : (allAlerts.alerts ?? []);

    const ev = skeleton(c.fullName, "replay-dataset", {
      auditM2: [],
      verdictAi: { files: p1.records.length, pass1_created: created1, pass2_dedup: dedup2, alerts_total: list.length },
    });
    const extraChecks = [
      check("replay_dataset_first_pass_creates",
        p1.records.length > 0 && created1 === p1.records.length,
        `第一遍 ${p1.records.length} 条全新建（created=${created1}）`),
      check("replay_dataset_second_pass_all_dedup",
        dedup2 === p2.records.length,
        `第二遍 ${p2.records.length} 条全 dedup（dedup=${dedup2}，created=${p2.created}）`),
      check("replay_dataset_alert_count_stable",
        list.length === p1.records.length,
        `推了两遍账面仍 ${list.length} 条告警（=文件数，不重复建案）`),
    ];
    return { evidence: ev, extraChecks };
  } finally {
    await rig.close();
  }
}
