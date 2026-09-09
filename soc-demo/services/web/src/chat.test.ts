// 对话追问（FR-M10.4 入口 + FR-M8.5/M8.6 复用）的纯逻辑层单测：
// parseSseFrames —— POST /api/v1/chat 的 SSE 响应帧解析（跨 chunk 半帧粘包）；
// streamChat —— fetch 流式读取（fetch 替身真给 ReadableStream，不走模块 mock）；
// applyChatFrame —— 帧流 → 对话转录（答案文本 + 过程行）。
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { applyChatFrame, parseSseFrames, streamChat, type ChatFrame, type ChatTurn } from "./chat";

const enc = new TextEncoder();

describe("parseSseFrames", () => {
  it("多帧一次到齐：event 名 + data JSON", () => {
    const { frames, rest } = parseSseFrames(
      'id: 1\nevent: token\ndata: {"delta":"主机"}\n\nid: 2\nevent: done\ndata: {"type":"done"}\n\n',
    );
    expect(rest).toBe("");
    expect(frames).toEqual([
      { type: "token", data: { delta: "主机" } },
      { type: "done", data: { type: "done" } },
    ]);
  });

  it("半帧留缓冲：尾帧不完整不误交付", () => {
    const one = parseSseFrames('event: token\ndata: {"delta":"a"}\n\nevent: tok');
    expect(one.frames).toHaveLength(1);
    expect(one.rest).toBe("event: tok");
    const two = parseSseFrames(one.rest + 'en\ndata: {"delta":"b"}\n\n');
    expect(two.frames).toEqual([{ type: "token", data: { delta: "b" } }]);
  });

  it("data 非 JSON：帧照交付、负载为空（不吞帧）", () => {
    const { frames } = parseSseFrames("event: done\ndata: ok\n\n");
    expect(frames).toEqual([{ type: "done", data: {} }]);
  });
});

describe("streamChat", () => {
  it("POST /api/v1/chat 带 Bearer 会话与 case_id，流式逐帧回调", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('event: token\ndata: {"delta":"隔离前"}\n\n'));
            c.enqueue(enc.encode('event: token\ndata: {"delta":"先确认"}\n\nevent: done\ndata: {}'));
            c.enqueue(enc.encode("\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const seen: ChatFrame[] = [];
    await streamChat({
      token: "a.b", message: "隔离主机 centos7", caseId: "case_000001",
      onFrame: (f) => seen.push(f), fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/chat");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer a.b");
    expect(JSON.parse(init.body)).toEqual({ message: "隔离主机 centos7", case_id: "case_000001" });
    expect(seen.map((f) => f.type)).toEqual(["token", "token", "done"]);
  });

  it("非 2xx（会话过期 401 等）抛 ApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    await expect(
      streamChat({ token: "bad", message: "hi", onFrame: () => {}, fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("applyChatFrame", () => {
  const empty: ChatTurn = { answer: "", steps: [], done: false };
  it("token 拼答案；工具/审批/拒绝帧进过程行；done 置结束", () => {
    let t = empty;
    t = applyChatFrame(t, { type: "token", data: { delta: "建议隔离 " } });
    t = applyChatFrame(t, { type: "token", data: { delta: "centos7" } });
    t = applyChatFrame(t, { type: "tool_call", data: { tool: "isolate_host", node: "execute" } });
    t = applyChatFrame(t, { type: "approval_required", data: { tool: "isolate_host" } });
    t = applyChatFrame(t, { type: "denied", data: { reason: "角色不可见" } });
    t = applyChatFrame(t, { type: "done", data: {} });
    expect(t.answer).toBe("建议隔离 centos7");
    expect(t.steps.map((s) => s.text)).toEqual([
      "调用工具 isolate_host",
      "需要审批：isolate_host（去审批卡页裁决）",
      "被拒绝：角色不可见",
    ]);
    expect(t.done).toBe(true);
  });
});
