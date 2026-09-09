// 对话追问（案件时间线页的入口）客户端（票 21）。复用 m8 的公开正门：
// POST /api/v1/chat（services/agent，票 18）——Bearer 会话 + {message, case_id}，
// 案件上下文由后端按 FR-M8.6 的 field-profile 白名单装配，前端只传 case_id 不拼上下文
// （「追问数据从 M2 只读面来」是后端的事，m8 卡补边说明）。
//
// 为什么不用 sse.ts 的 ReconnectingSse？两条流形状不同：/events/stream 是 GET 长连、
// 要断线重连续传（INV-7）；/chat 是 POST 一次性流——后端同步跑完 chat run 再把
// 事件整体补发成响应，没有「断线重连」可言（重发就是重新提问）。所以这里只借
// 它的 wire 格式（formatSse：event: 名 + data: JSON），解析自己带一份轻量的。
import { ApiError } from "./api";

/** 对话 wire 帧（agent app.ts CHAT_WIRE_TYPES：token/tool_call/tool_result/
 *  approval_required/approval_decided/denied/done）。 */
export interface ChatFrame {
  type: string;
  data: Record<string, unknown>;
}

/** 从缓冲里切出完整帧（\n\n 分隔），返回剩余半帧。见 chat.test.ts 的粘包用例。
 *  空块（连续空行）不是帧：跳过，避免流收尾时凭空造出 message 帧。 */
export function parseSseFrames(buffer: string): { frames: ChatFrame[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames = parts
    .filter((block) => block.trim() !== "")
    .map((block) => {
      let type = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      } catch {
        /* data 非 JSON：帧照交付、负载留空 */
      }
      return { type, data };
    });
  return { frames, rest };
}

/** POST /api/v1/chat 并逐帧回调。非 2xx（会话过期 401 / 拒答 503 等）抛 ApiError。 */
export async function streamChat(opts: {
  token: string;
  message: string;
  caseId?: string;
  onFrame: (f: ChatFrame) => void;
  /** 测试注入替身；缺省 = 全局 fetch。 */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f("/api/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
    body: JSON.stringify({
      message: opts.message,
      ...(opts.caseId ? { case_id: opts.caseId } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(res.status, typeof body.error === "string" ? body.error : "unknown");
  }
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (text: string): void => {
    const { frames, rest } = parseSseFrames(text);
    buffer = rest;
    for (const fr of frames) opts.onFrame(fr);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    drain(buffer + decoder.decode(value, { stream: true }));
  }
  drain(buffer + "\n\n"); // 收尾：服务端没写结尾空行的半帧也交付（不丢尾帧）
}

export interface ChatStep {
  id: number;
  type: string;
  text: string;
}

/** 一轮对话的转录（reduct 状态）：token 帧拼答案，其余帧进过程行。 */
export interface ChatTurn {
  answer: string;
  steps: ChatStep[];
  done: boolean;
}

export const EMPTY_TURN: ChatTurn = { answer: "", steps: [], done: false };

function stepText(type: string, data: Record<string, unknown>): string | null {
  switch (type) {
    case "tool_call":
      return `调用工具 ${String(data.tool ?? "?")}`;
    case "tool_result":
      return `工具返回 ${String(data.tool ?? "?")}${data.ok === false ? "（失败）" : ""}`;
    case "approval_required":
      return `需要审批：${String(data.tool ?? "?")}（去审批卡页裁决）`;
    case "approval_decided":
      return `审批已裁决：${String(data.decision ?? "?")}`;
    case "denied":
      return `被拒绝：${String(data.reason ?? "")}`;
    default:
      return null; // 未知帧不进过程行（token/done 之外来什么都是对话噪声）
  }
}

/** 归约一帧 → 新转录（不可变，与 pipeline.ts applyEvent 同款纪律）。 */
export function applyChatFrame(turn: ChatTurn, f: ChatFrame): ChatTurn {
  if (f.type === "token") {
    return { ...turn, answer: turn.answer + String(f.data.delta ?? "") };
  }
  if (f.type === "done") return { ...turn, done: true };
  const text = stepText(f.type, f.data);
  if (text === null) return turn;
  return {
    ...turn,
    steps: [...turn.steps, { id: turn.steps.length, type: f.type, text }],
  };
}
