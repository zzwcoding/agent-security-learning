// m11 eval 体系 · 共享类型（票 19）。
//
// 三类东西各一张表：
//   1. TestCaseYaml —— PRD §5.11 的 test_case.yaml 字段（fixture 目录制的事实接口），
//      外加一列 expected_verdict：FR-M11.4「分诊准确率对照人工标注 verdict」的人工标注
//      槽位——标注进用例文件，准确率才有的对。
//   2. CaseEvidence —— 快道跑完一条用例后的取证包（run 状态/终值/工具面/两路审计），
//      断言器只认证据不认过程，这是「确定性」的第一道保证。
//   3. CaseResult / JudgeResult —— 报告与门槛的最终形状：checks（确定性，进门禁）与
//      judge（LLM 评分，只进报告不进门禁，决策 #7）在类型上就分开。
export type TriVerdict = "fp" | "btp" | "tp" | "uncertain";

export type MockPolicy = "inherit" | "never_mock" | "always_mock";

/** 防线拦截率分面（FR-M11.4 第二维）：拦截按「怎么拦的」分别计数——
 *  guard_scan = D2 扫描拦（guards block，含 chat 输入通道）；
 *  behavior_gate = 行为兜底（验票/审批闸 403、无票不可执行，D4/D5/D7）；
 *  review_reject = D8 人审驳回；sandbox_boundary = 票 16 沙箱边界（第四攻击面）；
 *  credential_boundary = 票 35 m9 凭证金丝雀（INV-4：SECRETS 值不落任何持久面）。 */
export type InterceptFacet = "guard_scan" | "behavior_gate" | "review_reject" | "sandbox_boundary" | "credential_boundary";

/** PRD §5.11 EvalCase（test_case.yaml）。票 22 扩维：alert_fixture / user_prompt 之外的
 *  第三种 input —— scenario（具名行为布景，审批/replay/沙箱等非「一条告警」的用例）；
 *  expected_verdict 对告警流用例必填（准确率对照口径），行为流用例可省。 */
export interface TestCaseYaml {
  name: string;
  input: { alert_fixture?: string; user_prompt?: string; scenario?: string };
  /** 人工标注 verdict（FR-M11.4 准确率的对照口径；确定性断言，进门禁；告警流必填）。 */
  expected_verdict?: TriVerdict;
  /** 攻击用例的预期拦截分面（FR-M11.4 分面计数的预期口径；有 attack 才有意义）。 */
  expected_facet?: InterceptFacet;
  /** judge strict 要点列表（FR-M11.2；全部命中才 1 分，分数不进门禁）。 */
  expected_output: string[];
  forbidden_tools: string[];
  expected_approvals: string[];
  max_tool_calls: number;
  max_tokens: number;
  tags: string[];
  mock_policy: MockPolicy;
  /** 攻击用例标注攻击面（§7），如 alert_injection；常规用例 null。 */
  attack: string | null;
}

/** 一次 LLM 消费用量的取证快照（M507 cost_all.csv 口径的 input/cache-read/output 三列）。 */
export interface UsageSnapshot {
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** 扫描 fixtures/eval 得到的一条用例（yaml 解析 + 相对路径落定后）。 */
export interface EvalCase {
  /** "<域>/<编号_场景>"，报告与 latest.json 里的用例名。 */
  fullName: string;
  domain: string;
  dirName: string;
  dir: string;
  yamlPath: string;
  spec: TestCaseYaml;
  /** input.alert_fixture 解析出的绝对路径（alert 流用例）；对话流用例（user_prompt）为 null。 */
  alertFixturePath: string | null;
}

/** M2 侧 audit_entries 一行（GET /api/v1/audit 的形状）。 */
export interface M2AuditRow {
  id: string;
  action: string;
  actor: unknown;
  objectId: string;
  objectType: string;
  details: Record<string, unknown>;
  requestId: string;
  result: string;
  createdAt: number;
}

/** 一条用例跑完后的取证包。断言器（assertions.ts）的全部输入。 */
export interface CaseEvidence {
  fullName: string;
  runId: string;
  /** 场景级完成度：run 自然跑完 or 布景走到预期终点（如审批仍挂起是 03 用例的预期）。
   *  triage/对话用例 = run 终态；scenario 用例由执行器落定。 */
  status: string;
  /** run 行的真实终态（awaiting_approval/failed/...）；scenario 取证用。 */
  runStatus: string;
  /** M2 终值 verdict（"true_positive" 等，TO_M2_VERDICT 的 wire 形态）；非告警流为 null。 */
  verdict: string | null;
  verdictAi: unknown;
  /** 按序去重的工具名（tool_call 事件）；toolCallCount 是不去重总数（max_tool_calls 口径）。 */
  toolCalls: string[];
  toolCallCount: number;
  /** 开过审批卡的工具（approval_required 事件）。 */
  approvals: string[];
  tokensUsed: number;
  /** guards DENIED 次数（攻击用例的防线留痕存在性）。 */
  guardsDenied: number;
  /** TP 建案时 M2 审计里 create/case 的 objectId；无建案为 null。 */
  caseId: string | null;
  /** 两路审计（PRD FR-S5：worker sink + M2 同库，同一不变量 INV-8 的两半）。 */
  auditWorker: {
    action: string;
    actor: { type: string; id: string };
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    requestId: string;
    result: string;
    createdAt: number;
  }[];
  auditM2: M2AuditRow[];
  durationMs: number;
  /** LLM 消费用量取证（M507 成本口径三列的来源）；告警流用例才有（UsageProbeLlm 在缝上量）。 */
  usage?: UsageSnapshot;
  /** 交给 judge 的执行记录渲染文本（FR-M11.2 的评分对象）。 */
  transcript: string;
}

/** 攻击用例的拦截取证（runner 从证据推导，报告分面计数的数据源）。 */
export interface AttackEvidence {
  facet: InterceptFacet;
  /** true = 该道防线真拦住了（分面计「拦截」）；false = 遗漏报红。 */
  intercepted: boolean;
  detail: string;
}

/** 一条确定性检查的结论。 */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** judge 结论：evaluable=false 时不算失败、不合成总分（PRD 异常与边界，ASP 口径）。 */
export type JudgeResult =
  | { evaluable: true; score: 0 | 1; hit: string[]; missed: string[]; model: string }
  | { evaluable: false; reason: string; model: string | null };

/** latest.json 里的一条用例结果。 */
export interface CaseResult {
  fullName: string;
  domain: string;
  tags: string[];
  /** 快道真跑过（false = 因车道限制显式跳过，如 never_mock）。 */
  ran: boolean;
  skippedReason?: string;
  /** 门槛 = 确定性 checks 全绿（judge 分数不在内，决策 #7）。 */
  passed: boolean;
  verdict: { expected: string; got: string | null; ok: boolean };
  checks: CheckResult[];
  judge: JudgeResult | null;
  toolCalls: number;
  tokens: number;
  durationMs: number;
  /** 攻击用例的拦截结论（非攻击用例 null）；防线拦截率分面计数的数据源。 */
  attack: { kind: string; facet: InterceptFacet; intercepted: boolean } | null;
  /** M507 成本口径的一行（非告警流 / skipped 用例没有）。 */
  cost?: {
    model: string;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    estCostUsd: number;
  };
}
