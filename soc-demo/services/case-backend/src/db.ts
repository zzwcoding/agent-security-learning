import Database from "better-sqlite3";

export type DB = Database.Database;

// 六实体（PRD §5.1-5.6）+ outbox 事件表 + used_tokens 焚毁表（m9 依赖，同库同事务，m9 卡备注）。
// JSON 数组/对象字段存 TEXT；时间一律 epoch 毫秒。
const DDL = `
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity INTEGER NOT NULL DEFAULT 2,
  tlp INTEGER NOT NULL DEFAULT 2,
  pap INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'New',
  tags TEXT NOT NULL DEFAULT '[]',
  raw TEXT,
  verdict TEXT,
  verdict_ai TEXT,
  date INTEGER NOT NULL,
  new_date INTEGER NOT NULL,
  last_seen INTEGER,
  occurrences INTEGER NOT NULL DEFAULT 1,
  in_progress_date INTEGER,
  imported_date INTEGER,
  closed_date INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
-- 票 09（INV-6）：去重唯一约束兜底在 M2 SQLite——重复推送 (source, source_ref) 走
-- upsert occurrences+1，靠索引而非应用层查-插，防并发重复（PRD §6-M1 实现机制）
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(source, source_ref);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity INTEGER NOT NULL DEFAULT 2,
  tlp INTEGER NOT NULL DEFAULT 2,
  pap INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'New',
  verdict TEXT,
  verdict_note TEXT,
  verdict_ai TEXT,
  assignee TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  linked_alerts TEXT NOT NULL DEFAULT '[]',
  start_date INTEGER NOT NULL,
  end_date INTEGER,
  intake_source TEXT NOT NULL DEFAULT 'auto_pipeline',
  hypothesis_id TEXT
);

CREATE TABLE IF NOT EXISTS observables (
  id TEXT PRIMARY KEY,
  alert_id TEXT,
  case_id TEXT,
  data_type TEXT NOT NULL,
  data TEXT NOT NULL,
  message TEXT,
  tlp INTEGER NOT NULL DEFAULT 2,
  pap INTEGER NOT NULL DEFAULT 2,
  ioc INTEGER NOT NULL DEFAULT 0,
  sighted INTEGER NOT NULL DEFAULT 0,
  sighted_at INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  source_alert_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_observables_case ON observables(case_id);
CREATE INDEX IF NOT EXISTS idx_observables_alert ON observables(alert_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  title TEXT NOT NULL,
  task_group TEXT,
  status TEXT NOT NULL DEFAULT 'Todo',
  assignee TEXT
);

CREATE TABLE IF NOT EXISTS timeline_entries (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  structured TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_case ON timeline_entries(case_id);

CREATE TABLE IF NOT EXISTS audit_entries (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  request_id TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'SUCCESS',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_entries(object_id);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_entries(request_id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS used_tokens (
  jti TEXT PRIMARY KEY,
  source TEXT,
  burned_at INTEGER NOT NULL
);

-- 票 17（PRD §5.10 KBEntry）：知识沉淀账面。status 走 kbentry 状态机（proposed→approved/
-- rejected，INV-5 人审唯一通道）；向量检索面在 agent 侧 chroma——本表是数据归属地
-- （m7 卡决策「REST 面挂 M2」），approve/reject 在这里留痕 + 审计（INV-8 同事务）
CREATE TABLE IF NOT EXISTS kb_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_case_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  proposed_by TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kb_entries_status ON kb_entries(status, created_at);

-- 票 73（m2 假设实体，第七实体）：编排循环的输入账面。status 走 hypothesis 状态机
--（CONTEXT.md 语义核心：proposed→hunting→concluded/refuted/cancelled，INV-10 表外 409）；
-- cancel_reason 取消四因枚举（user_cancelled/planner_broken/spin/budget）。
-- POST /api/v1/hypotheses 置 proposed 并在同一事务发 outbox hypothesis.created（拉起 hunt_flow）。
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  proposed_by TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status, created_at);

-- 票 73：轮次归集段（m2 卡面新增读面的存储半边）。编排循环每轮 outcome 经公开写口
-- 落一条；(hypothesis_id, round_no) 唯一——事件重放/重报同轮幂等替换（INV-6 同族口径）。
-- tasks/children/judge/gap 存 JSON：children[{run_id,status}] 是父子 run 簿记的
-- 假设侧读面（run 行真相在 agent 侧，这里是归集视图）。
CREATE TABLE IF NOT EXISTS hypothesis_rounds (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  tasks TEXT NOT NULL DEFAULT '[]',
  children TEXT NOT NULL DEFAULT '[]',
  judge TEXT,
  gap TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(hypothesis_id, round_no)
);
`;

// 票 09：alerts 增 occurrences/last_seen。SQLite 的 CREATE TABLE IF NOT EXISTS 不会给
// 已存在的旧库文件补列，所以老库靠这里查缺补列（新库 DDL 一次到位，这里是 no-op）。
function migrate(db: DB): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(alerts)").all() as { name: string }[]).map((c) => c.name),
  );
  if (cols.size === 0) return; // alerts 表都不存在（不该发生，DDL 已建）
  if (!cols.has("last_seen")) db.exec("ALTER TABLE alerts ADD COLUMN last_seen INTEGER");
  if (!cols.has("occurrences")) {
    db.exec("ALTER TABLE alerts ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1");
  }
  // 票 73：cases 增 hypothesis_id 可空列（命中建案时回填，Case↔假设溯源锚）。
  const caseCols = new Set(
    (db.prepare("PRAGMA table_info(cases)").all() as { name: string }[]).map((c) => c.name),
  );
  if (caseCols.size > 0 && !caseCols.has("hypothesis_id")) {
    db.exec("ALTER TABLE cases ADD COLUMN hypothesis_id TEXT");
  }
}

export function openDb(path = ":memory:"): DB {
  const db = new Database(path);
  // 单写者：WAL + 5s 忙等（PRD 异常与边界）；:memory: 下这两条是无害的 no-op
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(DDL);
  migrate(db);
  return db;
}
