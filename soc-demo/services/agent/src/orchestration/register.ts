// m14 编排循环 · hypothesis_register 循环侧缝的缺省内存桩（票 75）。
//
// 行为约定 9 miss 半边：假设证伪后把"假设-证据-结论"关系写入图谱——hypothesis_register
// 是 L1 写工具，工具本体、验票闸与真 Memory stub 归票 79（m14 卡 Seam：weknora 三工具）。
// 本票只立缝与缺省桩：入图一律 proposed 态（INV-5 口径——人审前不进检索面，票 83 对接
// 期定人审通道）。桩是真接口假实现（换真工具不换调用方，MemoryVectorStore 先例）；
// 生产装配零改动——OrchestrationDeps.register 缺省即本件。
import type { HypothesisRegisterSeam, RegisterCall, RegisterRecord } from "./ports.js";

export class MemoryHypothesisRegister {
  entries: RegisterRecord[] = [];

  async register(call: RegisterCall): Promise<RegisterRecord> {
    const record: RegisterRecord = { ...call, status: "proposed", registered_at: Date.now() };
    this.entries.push(record);
    return record;
  }
}

/** 生产缺省件（OrchestrationDeps.register 缺省）：进程内单例——桩期账面随进程存续，
 *  票 79 换真工具（经验票闸的 L1 写）时本件整体退场。 */
let defaultRegister: MemoryHypothesisRegister | null = null;
export function defaultHypothesisRegister(): HypothesisRegisterSeam {
  defaultRegister ??= new MemoryHypothesisRegister();
  return (call) => defaultRegister!.register(call);
}
