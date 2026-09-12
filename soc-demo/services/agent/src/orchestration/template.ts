// m14 编排循环 · 模板登记面（票 73）。机制层只有格式契约与机制默认档——句式族/菜单
// 内容等业务模板文件归内容层票 79（边界规则 R10：模板「格式类型定义」单文件例外，
// 本文件即该单文件：类型 + 无业务分支的缺省档）。
import type { TemplateSource, LoopTemplate } from "./ports.js";

/** 机制默认档：真模板登记面（票 79）就位前的兜底——上限取 spec 预算档
 *（max_rounds=20、单轮 ≤2 子任务），菜单 = 查证只读面（planner 票面同源，见
 * run-kinds.ts 注册表注释）。不含任何业务分支常量。 */
export const DEFAULT_TEMPLATE: LoopTemplate = {
  templateId: "default",
  maxRounds: 20,
  maxTasks: 2,
  menu: ["kb_lookup", "siem_query", "related_alerts"],
};

export class DefaultTemplateSource implements TemplateSource {
  of(templateId: string): LoopTemplate | null {
    // 票 79 前：一切 template_id 都落机制默认档（登记面缺席 ≠ 拒跑，上限/菜单是机制档）
    return { ...DEFAULT_TEMPLATE, templateId: templateId || DEFAULT_TEMPLATE.templateId };
  }
}
