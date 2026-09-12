// m13 · Wazuh 形态告警生成器。body 结构照 fixtures/alerts 真样例照抄（读文件不拷贝，
// 结构漂移时这里跟着变）；sourceRef 全局唯一递增——CONTEXT INV-6：同 (source, sourceRef)
// 重复推送只 occurrences+1，唯一化防 M2 去重把压测流量吃成计数器。
// 铁律：只生成 payload，不 import services 内部（fixtures 是中立层共享资产）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "..", "..", "fixtures", "alerts");

// 进程内全局序列 + 进程标签：同机多进程/多轮跑也不撞（sourceRef 唯一性是单测对账项）
let seq = 0;
const RUN_TAG = `bench-${process.pid.toString(36)}-${Date.now().toString(36)}`;

/** 全局唯一递增 id：b-<pid36>-<ts36>-000001（用满 100 万条才可能在同轮内重复，压测量级远够） */
export function nextId() {
  seq += 1;
  return `${RUN_TAG}-${String(seq).padStart(6, "0")}`;
}

const shapeCache = new Map();

/** 读真 fixture 的结构（缓存）；缺文件直接抛——不静默退化成手造结构。 */
export function loadFixtureShape(name = "ssh-5712-real") {
  const hit = shapeCache.get(name);
  if (hit) return hit;
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8"));
  shapeCache.set(name, raw);
  return raw;
}

/**
 * 造一条 Wazuh 形态告警：结构 = 真 fixture，只换三处——
 *   id（→ M2 sourceRef，唯一化防 INV-6 去重）、timestamp（now，合法时间戳过 ingest 验型）、
 *   agent.name（host 参数，M2 读口 host 过滤的播种锚）。
 */
export function makeAlert({
  fixture = "ssh-5712-real",
  host = "bench-host",
  id = nextId(),
  timestamp = new Date().toISOString(),
} = {}) {
  const alert = structuredClone(loadFixtureShape(fixture));
  alert.id = id;
  alert.timestamp = timestamp;
  if (alert.agent && typeof alert.agent === "object") alert.agent.name = host;
  return alert;
}

/** 一池唯一告警：基准卡按 amount 精确取用（见 b1-endpoints.mjs 的 requests 数组）。 */
export function makeAlertPool(n, opts = {}) {
  return Array.from({ length: n }, () => makeAlert(opts));
}

/**
 * gateway-mint（POST /internal/mint）的任务票请求体池——形态照 services/gateway/app.py
 * 真代码核过：type=task_ticket 需 jti/sub/case_id/run_id/scope/allowed_tools 六字段，
 * mint 是无状态 HMAC 签名，jti 不查库（焚毁表在 M2/验票闸侧），唯一 jti 只是保持
 * 与生产形态一致。jti 全局唯一递增。
 */
export function makeMintBody({ jti = nextId(), sub = "m4:triage", caseId = "bench-case", runId = nextId() } = {}) {
  return {
    type: "task_ticket",
    jti,
    sub,
    case_id: caseId,
    run_id: runId,
    scope: ["alert:read", "case:read"],
    allowed_tools: ["siem_query", "kb_search"],
  };
}

/** M2 直写（POST /api/v1/alerts）最小合法体：type/source/sourceRef/title 四必填照真代码。 */
export function makeUpsertBody({ source = "bench:upsert", sourceRef = nextId(), title = "bench upsert alert" } = {}) {
  return { type: "wazuh_alert", source, sourceRef, title };
}
