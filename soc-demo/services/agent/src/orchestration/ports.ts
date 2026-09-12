// m14 编排循环 · seam 类型件（票 73）。机制目录只有类型与注入缝——业务模板名/句式族
// 一概不进（边界规则 R10：内容归票 79，这里只有格式契约的纯类型 + 机制默认档）。
//
// 六个注入缝（生产装配在 index.ts，测试全换假件）：
//   HypothesisPort —— m2 假设实体的公开 REST 面（迁移 hunting/结论、轮次归集写读）；
//   RunDoor        —— m3 run 机器标准入口（POST /internal/runs 壳；R11：m14 不碰铸票
//                     客户端，票由 app.ts 装配按注册表票面铸——铸票唯一通道不变）；
//   HuntLedger     —— 父子 run 簿记（run_id ↔ hypothesis/round/parent/task，agent 自持
//                     SQLite 或内存；轮次接力幂等锚 + 子 run 交接态恢复源）；
//   LoopEventBus   —— agent run_events 事件的进程内扇出（index.ts 经 events.ts 的
//                     eventTap 喂入）；await_children 事件唤醒与轮次接力的唯一信号源；
//   TemplateSource —— 模板登记面（格式契约：template_id + max_rounds/max_tasks 改写 +
//                     菜单子集；模板文件归内容层票 79，本票只有机制默认档）；
//   LoopLlm        —— planner/judge/gap 的 LLM adapter（m14 卡 Seam：fake/real 双件；
//                     本票 fake 确定性桩，74/75 换真）。
import type { SseEventType } from "../events.js";

// ---------- 模板格式契约（R10 例外：纯类型无行为，单文件语义） ----------

/** 模板 = template_id + 轮次/单轮任务数改写 + 菜单子集（句式族是内容层，不进机制）。 */
export interface LoopTemplate {
  templateId: string;
  maxRounds: number;
  maxTasks: number;
  /** planner 可选能力子集（菜单外选择由 planner 契约拒绝，票 74/75 落 DENIED 审计）。 */
  menu: readonly string[];
}

export interface TemplateSource {
  of(templateId: string): LoopTemplate | null;
}

// ---------- 节点间契约（specs/orchestration-loop.md「m14 内部契约」） ----------

export interface PlannedTask {
  tool: string;
  params: Record<string, unknown>;
  rationale: string;
}

export interface JudgeOutput {
  sufficient: boolean;
  verdict: "hit" | "miss" | null;
  confidence: number;
  gap_description: string | null;
}

export interface GapOutput {
  gap_description: string;
  unknown: string;
  suggested_focus: string[];
}

export interface PlannerInput {
  hypothesis_text: string;
  evidence_so_far: string[];
  gap: GapOutput | null;
  menu: readonly string[];
  template: { max_rounds: number; max_tasks: number };
}

export interface RoundReport {
  task: PlannedTask;
  result_summary: string;
  params_hash: string;
}

export interface JudgeInput {
  hypothesis_text: string;
  round_reports: RoundReport[];
  /** 机制侧提示（既往轮数）：fake 桩的收敛判据用；真 adapter（票 74/75）按 spec 契约
   *  只消费 hypothesis_text + round_reports。 */
  prior_rounds?: number;
}

export interface GapInput {
  judge_output: JudgeOutput;
  evidence_so_far: string[];
}

export interface LoopLlm {
  planner(input: PlannerInput): Promise<{ tasks: PlannedTask[]; tokens: number }>;
  judge(input: JudgeInput): Promise<JudgeOutput & { tokens: number }>;
  gap(input: GapInput): Promise<GapOutput & { tokens: number }>;
}

// ---------- m2 假设实体公开面（REST adapter 的类型；生产 HttpHypothesisPort） ----------

export interface HypothesisView {
  id: string;
  status: "proposed" | "hunting" | "concluded" | "refuted" | "cancelled";
  template_id: string;
  text: string;
}

export interface RoundRecord {
  round_no: number;
  tasks: PlannedTask[];
  children: { run_id: string; status: string }[];
  judge: JudgeOutput | null;
  gap: GapOutput | null;
}

export interface HypothesisDetail extends HypothesisView {
  rounds: RoundRecord[];
}

export interface HypothesisPort {
  getDetail(id: string): Promise<HypothesisDetail | null>;
  /** proposed→hunting（hunt_flow 首轮开始前置，行为约定 1；非法迁移远端 409 原样上抛）。 */
  startHunting(id: string): Promise<void>;
  /** hunting→concluded/refuted/cancelled（行为约定 9/11/12 的循环侧落账）。 */
  transition(id: string, to: "concluded" | "refuted" | "cancelled", opts?: { reason?: string }): Promise<void>;
  recordRound(id: string, round: RoundRecord): Promise<void>;
}

// ---------- m3 标准入口壳与事件 ----------

/** POST /internal/runs 的进程内壳：返回 run_id（app.ts 装配注入；铸票/入队全在正门内）。 */
export interface RunDoor {
  post(payload: { kind: string; case_id?: string }): Promise<string>;
}

/** agent 落盘事件（events.ts RunEvent 的结构子集，避免机制件直依赖总线内部）。 */
export interface LoopEvent {
  id: number;
  runId: string;
  type: SseEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type LoopListener = (e: LoopEvent) => void;
export type Unsubscribe = () => void;

export interface LoopEventBus {
  publish(e: LoopEvent): void;
  subscribe(fn: LoopListener): Unsubscribe;
}

// ---------- 父子 run 簿记 ----------

export interface HuntLink {
  runId: string;
  /** round = 轮次链 run（hunt_flow，一轮一条串行链）；task = 扇出的取证子 run（hunt_task）。 */
  role: "round" | "task";
  hypothesisId: string;
  roundNo: number;
  /** task 角色的父轮次 run_id；round 角色为 null（轮间接力靠 hypothesis+round_no 归集）。 */
  parentRunId: string | null;
  task: PlannedTask | null;
}

export interface HuntLedger {
  put(link: HuntLink): void;
  get(runId: string): HuntLink | null;
  /** 该假设第 roundNo 轮的轮次 run 链接（接力幂等锚：有 = 已拉起，重放不再起）。 */
  findByRound(hypothesisId: string, roundNo: number): HuntLink | null;
  childrenOf(parentRunId: string): HuntLink[];
  rounds(hypothesisId: string): HuntLink[];
  /** 全量（测试/运维巡检用；生产消费方都走上面四个定向口）。 */
  all(): HuntLink[];
}

/** await_children 的事件唤醒口（await-children.ts 实现；flow 只见此类型）。 */
export interface ChildOutcome {
  runId: string;
  ok: boolean;
  resultSummary: string;
  paramsHash: string;
}

export interface ChildWaiter {
  wait(childRunIds: string[]): Promise<ChildOutcome[]>;
}
