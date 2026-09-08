// 权限面报告（FR-M12.3）：按 PRD §5.7 工具分级口径给建议分级。
// L0 只读免验 / L1 写需任务票 / L2 高危需审批（isolate/删除/执行/外发一类）。
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: object;
}

export interface TierSuggestion {
  tier: "L0" | "L1" | "L2";
  risks: string[];
  requires_approval: boolean;
}

// 中文动词不能包 \b（CJK 非 \w，前面是标点时边界不成立），中英分开写
const L2 = /\b(?:delete|remove|drop|destroy|isolate|block|quarantine|execute|run|eval|deploy|pay|send|upload|shutdown)\b|删除|执行|隔离|阻断|部署|支付|发送|上传|外传|外发/i;
const L1 = /\b(?:write|create|update|insert|modify|patch|edit|move|merge|overwrite|append)\b|新建|写入|更新|修改|追加/i;

export function suggestTier(tool: McpTool): TierSuggestion {
  const haystack = `${tool.name.replace(/_/g, " ")} ${tool.description ?? ""}`;
  if (L2.test(haystack)) {
    return { tier: "L2", risks: ["high_impact"], requires_approval: true };
  }
  if (L1.test(haystack)) {
    return { tier: "L1", risks: ["write_operation"], requires_approval: false };
  }
  return { tier: "L0", risks: [], requires_approval: false };
}

export function schemaHasCredentialSurface(schemaText: string): boolean {
  return /\b(?:api[_-]?keys?|secret|password|credential|token)\b/i.test(schemaText);
}
