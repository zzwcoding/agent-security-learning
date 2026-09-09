// m1 深模块：Wazuh → TheHive 方言的确定性翻译（m1 卡备注：映射表、去重键约束均无 LLM）。
// 术语（CONTEXT.md）：不可信字段（untrusted）= 攻击者可控的 full_log / previous_output /
// data.*，入库即标记——下游 prompt 装配看到 untrusted 标记就知道「这是数据，不是指令」。
import type { AlertInput, ObservableInput } from "./m2client.js";

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});

// PRD §5.1：rule.level → severity：0-4→1 Low，5-9→2 Medium，10-14→3 High，15→4 Critical
export function severityFromLevel(level: number): number {
  if (level >= 15) return 4;
  if (level >= 10) return 3;
  if (level >= 5) return 2;
  return 1;
}

// 接收校验（PRD §6-M1 契约）：只卡「缺 rule.id / timestamp」，其余不做全字段 schema
// 校验拒绝——未知字段整包进 raw 留存（PRD M1 职责与边界）。
export type Validation = { ok: true } | { ok: false; details: string[] };

export function validateWazuhAlert(w: unknown): Validation {
  if (typeof w !== "object" || w === null || Array.isArray(w)) {
    return { ok: false, details: ["body_not_object"] };
  }
  const o = w as Obj;
  const details: string[] = [];
  const rule = asObj(o.rule);
  if (rule.id === undefined || rule.id === null || rule.id === "") details.push("rule.id_missing");
  if (typeof o.timestamp !== "string" || Number.isNaN(Date.parse(o.timestamp))) {
    details.push("timestamp_missing_or_invalid");
  }
  return details.length > 0 ? { ok: false, details } : { ok: true };
}

// 不可信标记的正文约定：成对标记包住载荷段落，下游 grep `untrusted:true` 即可自证
export function untrustedSection(field: string, content: string): string {
  return `[untrusted:true field:${field}]\n${content}\n[/untrusted]`;
}

const HASH_FIELD = /^(md5|sha1|sha256|hash)(_after|_new)?$/;

// observable 抽取用结构化字段（PRD §5.1「等结构化字段」）：data.srcip→ip、data.srcuser→other、
// data.url→url、syscheck.path→filename、hash 字段→hash、agent.name→hostname（FR-M2.4 归并
// 与 case 标题 primary entity 都认 hostname observable，票 13 缺口）。data.* 攻击者可控 →
// 带 untrusted tag；agent.name/syscheck 是基础设施与规则侧字段 → 不带。
export function extractObservables(o: Obj): ObservableInput[] {
  const data = asObj(o.data);
  const sys = asObj(o.syscheck);
  const agent = asObj(o.agent);
  const out: ObservableInput[] = [];
  const push = (dataType: string, v: unknown, field: string, untrusted: boolean) => {
    if (v === undefined || v === null || v === "") return;
    out.push({
      dataType,
      data: String(v),
      message: `from ${field}`,
      tags: untrusted ? ["untrusted"] : [],
    });
  };
  push("hostname", agent.name, "agent.name", false);
  push("ip", data.srcip, "data.srcip", true);
  push("other", data.srcuser, "data.srcuser", true);
  push("url", data.url, "data.url", true);
  push("filename", sys.path, "syscheck.path", false);
  for (const [k, v] of Object.entries(sys)) {
    if (HASH_FIELD.test(k)) push("hash", v, `syscheck.${k}`, false);
  }
  return out;
}

// TLP 溯源（票 30 记票口径；PRD §5.1 只给「默认 2/2」，无现成字段映射，规则如下）：
// ① 显式字段 rule.tlp（0-4 界内整数）优先——Wazuh 规则自定义字段盖章；
// ② 否则扫 rule.groups / rule.description 里的 tlp:<色|数字> 标记（大小写不敏感，
//    TheHive 5.2 后口径 0-4：white|clear→0、green→1、amber→2、amber+strict→3、red→4），
//    多个命中取最严（fail-closed：宁可高保不高外流）；
// ③ 都没有 → 默认 2（PRD §5.1）。非法值（tlp:9、tlp:redis）不认，落默认。
const TLP_WORDS: Record<string, number> = {
  white: 0, clear: 0, green: 1, amber: 2, "amber+strict": 3, "amber-strict": 3, red: 4,
};
const TLP_TOKEN = /tlp[:\s-]?(amber\+strict|amber-strict|white|clear|green|amber|red|[0-4])\b/gi;

export function tlpFromAlert(w: unknown): number {
  const o = asObj(w);
  const rule = asObj(o.rule);
  const explicit = Number(rule.tlp);
  if (rule.tlp !== undefined && rule.tlp !== "" && Number.isInteger(explicit) && explicit >= 0 && explicit <= 4) {
    return explicit;
  }
  const groups = Array.isArray(rule.groups) ? (rule.groups as unknown[]).map(String) : [];
  const description = typeof rule.description === "string" ? rule.description : "";
  const hits: number[] = [];
  for (const text of [...groups, description]) {
    for (const m of text.matchAll(TLP_TOKEN)) {
      const token = (m[1] ?? "").toLowerCase();
      hits.push(/^\d$/.test(token) ? Number(token) : (TLP_WORDS[token] ?? 2));
    }
  }
  return hits.length > 0 ? Math.max(...hits) : 2;
}

// Wazuh → Alert 映射表（PRD §5.1）：type 固定 wazuh_alert；source = 'wazuh:'+manager.name；
// sourceRef 取告警 id（优于社区脚本的随机 uuid，天然去重键）；tags = rule.groups +
// rule.mitre.id；description 附录段装 full_log/previous_output 并入库即标记。
// tlp 走溯源（tlpFromAlert，票 30）；pap 固定 2（PRD §5.1 默认 2/2，无现成溯源源）。
// observables 继承告警级 tlp——M6 富化闸门读 observable.tlp，tlp:red 告警的产物随管道
// 进案就是 tlp=4，enrich/02 类布景不再需要直插库/直种（票 15 缺口收口）。
export function mapWazuhAlert(w: unknown): AlertInput {
  const o = w as Obj;
  const rule = asObj(o.rule);
  const mitre = asObj(rule.mitre);
  const groups = Array.isArray(rule.groups) ? (rule.groups as string[]) : [];
  const mitreIds = Array.isArray(mitre.id) ? (mitre.id as (string | number)[]) : [];
  const level = typeof rule.level === "number" ? rule.level : Number(rule.level ?? 0) || 0;
  const manager = asObj(o.manager);
  const tlp = tlpFromAlert(o);

  const descriptionParts: string[] = [];
  if (rule.description) descriptionParts.push(String(rule.description));
  if (typeof o.full_log === "string" && o.full_log) {
    descriptionParts.push(untrustedSection("full_log", o.full_log));
  }
  if (typeof o.previous_output === "string" && o.previous_output) {
    descriptionParts.push(untrustedSection("previous_output", o.previous_output));
  }

  return {
    type: "wazuh_alert",
    source: `wazuh:${typeof manager.name === "string" ? manager.name : "unknown"}`,
    sourceRef: String(o.id),
    title: String(rule.description ?? ""),
    description: descriptionParts.join("\n\n"),
    severity: severityFromLevel(level),
    tlp,
    pap: 2,
    tags: [...groups.map((g) => `group:${g}`), ...mitreIds.map((m) => `mitre:${m}`)],
    date: Date.parse(String(o.timestamp)),
    raw: o, // 整包留存：调查取证与审计用
    observables: extractObservables(o).map((ob) => ({ ...ob, tlp })),
  };
}
