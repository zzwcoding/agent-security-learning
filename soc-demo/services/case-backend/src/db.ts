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
  intake_source TEXT NOT NULL DEFAULT 'auto_pipeline'
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
