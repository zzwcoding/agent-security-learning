// 信封 hash 链（m3 内部模块 envelope；PRD：{run_id, node, state_ref, prev_hash, hash}，
// hash 链式计算；v3 决策 ⑦ 原样继承）。
//
// 防篡改原理 = 区块链那招：每个信封的 hash 盖住「自己全部字段 + 上一个信封的 hash」，
// 所以改链上任何一环（状态字节 / node 名 / hash 本身 / 链环顺序），从那一环往后全部对不上。
// state_ref 是状态快照**原始字节**的 sha256（内容寻址引用）——PRD「状态里放引用不放全文」
// 在落库形态上的对应：引用（state_ref）进信封参与签名，快照（state）紧挨着放，resume 时
// 先对字节再验链，篡改落盘状态任意字节都会被 state_ref 当场戳穿。
//
// 字节级校验的取舍：hash 盖的是 JSON.stringify 原串，不是规范化后的形态——键序重排也算
// 篡改（字节变了）。信封自身字段的 hash 复用 verify-ticket 的 paramsHash（规范化序列化），
// 与票面契约共用同一套 canonicalJson。
import { createHash } from "node:crypto";
import { paramsHash } from "./verify-ticket.js";

/** 第一个信封的 prev_hash：空串即创世。 */
export const GENESIS_PREV_HASH = "";

/** 信封（不含状态快照本体——快照由 checkpointer 紧挨着存）。 */
export interface Envelope {
  runId: string;
  seq: number;
  node: string;
  stateRef: string;
  prevHash: string;
  hash: string;
}

/** 落库行 = 信封 + 状态快照原文。 */
export interface EnvelopeRow extends Envelope {
  state: string;
}

export class TamperedCheckpointError extends Error {
  readonly code = "checkpoint_tampered";
  readonly httpStatus = 409;
  constructor(what: string) {
    super(`checkpoint_tampered: ${what}`);
    this.name = "checkpoint_tampered";
  }
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 盖一个信封：stateRef 锁状态字节，hash 盖信封全字段 + prev_hash（链）。 */
export function sealEnvelope(
  prev: Envelope | null,
  input: { runId: string; node: string; stateJson: string },
): Envelope {
  const seq = (prev?.seq ?? 0) + 1;
  const stateRef = "sha256:" + sha256Hex(input.stateJson);
  const prevHash = prev?.hash ?? GENESIS_PREV_HASH;
  const hash = paramsHash({
    run_id: input.runId,
    seq,
    node: input.node,
    state_ref: stateRef,
    prev_hash: prevHash,
  });
  return { runId: input.runId, seq, node: input.node, stateRef, prevHash, hash };
}

/** 整链复核：seq 连续、prev_hash 逐环相扣、state_ref 对得上状态字节、hash 重算一致。
 *  任何一条不满足 = 落盘状态被动过 → TamperedCheckpointError（resume 必拒）。 */
export function verifyChain(rows: EnvelopeRow[]): void {
  let prev: Envelope | null = null;
  for (const row of rows) {
    if (row.seq !== (prev?.seq ?? 0) + 1) {
      throw new TamperedCheckpointError(`chain gap at seq ${row.seq}`);
    }
    const expectedStateRef = "sha256:" + sha256Hex(row.state);
    if (row.stateRef !== expectedStateRef) {
      throw new TamperedCheckpointError(`state bytes tampered at seq ${row.seq}`);
    }
    const expectPrev = prev?.hash ?? GENESIS_PREV_HASH;
    if (row.prevHash !== expectPrev) {
      throw new TamperedCheckpointError(`prev_hash mismatch at seq ${row.seq}`);
    }
    const hash = paramsHash({
      run_id: row.runId,
      seq: row.seq,
      node: row.node,
      state_ref: row.stateRef,
      prev_hash: row.prevHash,
    });
    if (row.hash !== hash) {
      throw new TamperedCheckpointError(`envelope hash mismatch at seq ${row.seq}`);
    }
    prev = row;
  }
}
