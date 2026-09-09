// 票 31：SSE 事件类型双端契约（体检对账三-14 / 结构-3「三份手抄已漂移过一次」）。
//
// 锚 = fixtures/sse-events.json。此前事件名单抄了三份：agent events.ts 的 SseEventType
// 全集、app.ts 的 CHAT_WIRE_TYPES 对话子集、web sse.ts 的 SSE_EVENT_TYPES 全集——注释里
// 写着「新增类型两端同步」，但没有任何机器咬合。本文件钉 agent 侧两份（全集 + 子集）；
// web 消费端的对称闸在 services/web/src/sse-contract.test.ts，读同一份样品。
// agent 改名单没改样品 → 这里红；改了样品 web 没跟 → web 那边红。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SSE_EVENT_TYPES } from "./events.js";
import { CHAT_WIRE_TYPES } from "./app.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../fixtures/sse-events.json", import.meta.url), "utf8"),
) as { event_types: string[]; chat_wire_types: string[] };

describe("SSE 事件类型双端契约：fixtures/sse-events.json（agent 产出侧）", () => {
  test("agent 全集 SSE_EVENT_TYPES ≡ 样品 event_types（顺序也是 wire 契约的一部分）", () => {
    expect([...SSE_EVENT_TYPES]).toEqual(FIXTURE.event_types);
  });

  test("chat wire 子集 ≡ 样品 chat_wire_types，且 ⊆ event_types（对话流只出对话语义帧，PRD §6-M8）", () => {
    const chat = [...CHAT_WIRE_TYPES];
    expect(new Set(chat).size).toBe(chat.length); // Set 里没有重复名单
    expect([...chat].sort()).toEqual([...FIXTURE.chat_wire_types].sort());
    for (const t of chat) expect(FIXTURE.event_types).toContain(t);
  });
});
