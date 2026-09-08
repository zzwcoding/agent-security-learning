// 内嵌扫描规则（票 05 / FR-M12.2、FR-M12.4，决策记录 #11：CLI 本地内嵌，不依赖运行时 guards）。
// 投毒攻击族与 guards 的注入扫描同源（票 04），另加 MCP 描述投毒特有的伪装特征。
export interface PoisonScan {
  is_injection: boolean;
  score: number;
  families: string[];
}

const THRESHOLD = 0.5;

const FAMILIES: readonly [string, number, RegExp][] = [
  ["instruction_override", 0.6, /ignore (all |any )?(previous|prior|above|earlier)|disregard (all |the )?(previous|above)|忽略(以上|之前|上面|前面)(的)?(所有)?(指令|指示|规则|内容)/i],
  ["authority_escalation", 0.6, /(developer|admin|god|dan)\s*mode|已(经)?(获得|拥有)(管理员|授权|权限)|已由(值班长|管理员|admin)批准|无需(再次)?审批|approved by (the )?(admin|duty)|拥有管理员权限/i],
  ["tool_call_injection", 0.6, /"name"\s*:\s*"[a-z_]+"\s*,\s*"(arguments|parameters)"|调用工具\s*[a-z_]+/i],
  ["data_exfiltration", 0.6, /send (the )?(conversation|chat|context|api[_ ]?keys?|credentials|all )( history)? ?to|把(对话|会话|上下文|密钥|凭证|所有)(历史)?(发送|上传|外传|外发)到/i],
  ["prompt_exfiltration", 0.5, /(reveal|print|show|repeat)( the | your )?(system )?(prompt|instructions)|(打印|输出|泄露|显示)(你的)?(系统)?提示词/i],
  ["invisible_chars", 0.5, /\u200b|\u200c|\u200d|\u2060|\ufeff/],
  ["mcp_camouflage", 0.5, /(\bsystem\b|\bassistant\b)\s*(note|prompt|message)\s*[:：]|\bsystem\s*[:：]|<system>|[A-Za-z0-9+/]{32,}={0,2}/i],
];

export function scanDescription(text: string): PoisonScan {
  const families: string[] = [];
  let score = 0;
  for (const [family, weight, pattern] of FAMILIES) {
    if (pattern.test(text)) {
      families.push(family);
      score += weight;
    }
  }
  return { is_injection: score >= THRESHOLD, score: Math.min(1, score), families };
}

// 凭证暴露模式（FR-M12.4）：字面密钥 / 明文键值 / PEM；schema 来源另查敏感属性名
const SECRET_LITERAL = /\b(?:sk|ghp|gho|xoxb|AKIA)[_-]?[A-Za-z0-9]{8,}\b/;
const SECRET_KV = /(?:api[_-]?key|secret|password|passwd|token)\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}/i;
const PEM = /BEGIN (?:RSA |EC )?PRIVATE KEY/;
const CREDENTIAL_WORD = /\b(?:api[_-]?keys?|secret|password|credential)\b/i;

export function scanCredentialText(text: string, source: string): { source: string; match: string }[] {
  const out: { source: string; match: string }[] = [];
  for (const pattern of [SECRET_LITERAL, SECRET_KV, PEM]) {
    const m = text.match(pattern);
    if (m) out.push({ source, match: m[0].slice(0, 48) });
  }
  if (source.startsWith("schema")) {
    const m = text.match(CREDENTIAL_WORD);
    if (m) out.push({ source, match: m[0] });
  }
  return out;
}
