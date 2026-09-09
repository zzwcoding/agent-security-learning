import Database from "better-sqlite3";

export type DB = Database.Database;

// m3 supervisor 自持三张表（票 10）。注意：run/checkpoint/事件流是编排侧自己的状态，
// 不进 M2 的六实体库——m3 卡把 checkpointer/SSE 总线划给 agent 服务，SQLite 落自己的卷
// （compose：./data/agent:/data）。JSON 字段存 TEXT；时间一律 epoch 毫秒。
const DDL = `
-- run 实体（CONTEXT.md 状态机：queued→running→awaiting_approval→running→completed/failed）
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  case_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  fail_reason TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- SSE 事件总线（决策 #9：事件自增 id 落 SQLite）。id 全局自增=持久化游标，
-- 客户端带 Last-Event-ID 回来按 id>cursor 补发（INV-7 不丢不重）
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

-- checkpointer 信封（PRD：{run_id, node, state_ref, prev_hash, hash} 链式计算；
-- state 存快照原文，state_ref 是它的 sha256 引用——篡改任意字节 resume 必拒）
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  node TEXT NOT NULL,
  state TEXT NOT NULL,
  state_ref TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- checkpoint 任务写入（票 23，LangGraph 原生机制）：interrupt/resume 的中间写入
-- （__interrupt__/__resume__ 记录）挂在产生它的那个 checkpoint 上，杀进程重启后
-- Command(resume) 靠它们找回被挂起的任务。blob 是 serde 序列化字节。
CREATE TABLE IF NOT EXISTS checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

-- 审批卡（票 11）：L2 动作 interrupt 时开卡，卡即「决定绑定 (run, tool_call)」的落点——
-- (run_id, tool, params_hash) 定位一次 tool_call；params 存 JSON 原文（Web 展示），
-- 身份比对只用 params_hash（INV-2 的锚）。status 走 statemachine 的审批状态机。
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node TEXT NOT NULL,
  tool TEXT NOT NULL,
  params TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  case_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approver TEXT,
  reject_reason TEXT,
  token TEXT,
  token_jti TEXT,
  executed_at INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id, tool, params_hash);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

-- 票 40（G2-9 清偿）：M2 outbox 消费游标——event_cursors.name → 已消费到的
-- outbox_events.id 水位（autorun.ts 的消费循环）。持久化在 agent 自己的库：重启不重放。
-- 就算游标丢失（库被删）重放也安全——防重兜底（票 13 verdict 锁 + runs 表查 + M2 kb
-- 账面查）保证「重复事件不重复拉起」（INV-6），这里只是少做无用功。
CREATE TABLE IF NOT EXISTS event_cursors (
  name TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL
);
`;

// 票 17：runs 增 case_id（knowledge_flow 的目标案件）。老库靠查缺补列——
// SQLite 的 CREATE TABLE IF NOT EXISTS 不会给已存在的表补列（case-backend 同款做法）
function migrate(db: DB): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name),
  );
  if (cols.size === 0) return; // runs 表不存在（DDL 已建，不该发生）
  if (!cols.has("case_id")) db.exec("ALTER TABLE runs ADD COLUMN case_id TEXT");
}

export function openDb(path = ":memory:"): DB {
  const db = new Database(path);
  // 单写者：WAL + 5s 忙等（与 case-backend 同口径）；:memory: 下是无害 no-op
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(DDL);
  migrate(db);
  return db;
}
