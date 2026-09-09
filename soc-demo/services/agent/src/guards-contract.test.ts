// 票 32 验收 1：guards 响应形状跨语言契约（消费端闸）。
// 数据只有一份：fixtures/guards/contract.json（py 生产端
// services/guards/test_guards_contract.py 读同一份，仿 fixtures/tickets 先例）。
// 本地起一台「按契约形状回样」的样例服务器，断言 guards-client 消费出的
// ScanDecision——客户端读了契约没有的键、或 blocked 语义漂移，这端先红。
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SCAN_CHANNELS, scanInjection, type ScanChannel } from "./guards-client.js";

interface GuardsContract {
  scan_injection: {
    request_fields: string[];
    response_fields: string[];
    threshold: number;
    scanner_name: string;
  };
  channels: string[];
  channel_policy: Record<string, string>;
  actions: string[];
  client_only: { consumed_fields: string[] };
  samples: { name: string; text: string; expect: { is_injection: boolean } }[];
}

// src → soc-demo/fixtures/guards（verify-ticket.test.ts 同款相对路径）
const contract = JSON.parse(
  readFileSync(new URL("../../../fixtures/guards/contract.json", import.meta.url), "utf8"),
) as GuardsContract;

test("通道枚举 ≡ 契约 channels（运行时名单共享，票 31 events.ts 先例）", () => {
  expect([...SCAN_CHANNELS]).toEqual(contract.channels);
  expect(new Set(SCAN_CHANNELS).size).toBe(SCAN_CHANNELS.length);
});

test("契约自洽：客户端声明的消费键 ⊆ 契约响应键集", () => {
  for (const field of contract.client_only.consumed_fields) {
    expect(contract.scan_injection.response_fields, `消费键 ${field} 必须在契约响应形状里`).toContain(field);
  }
});

describe("样例服务器 × 8 组合：客户端按契约消费出 ScanDecision", () => {
  let server: http.Server;
  let baseUrl: string;
  const badRequests: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as { text?: string; channel?: string };
        // 请求形状闸：客户端发出的键集必须 ≡ 契约 request_fields
        if (
          JSON.stringify(Object.keys(body).sort()) !==
          JSON.stringify([...contract.scan_injection.request_fields].sort())
        ) {
          badRequests.push(JSON.stringify(Object.keys(body).sort()));
        }
        const sample = contract.samples.find((s) => s.text === body.text);
        if (!sample || !body.channel) {
          res.writeHead(400).end();
          return;
        }
        const isInj = sample.expect.is_injection;
        const action = isInj ? contract.channel_policy[body.channel] : "allow";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            is_injection: isInj,
            score: isInj ? contract.scan_injection.threshold + 0.4 : 0,
            scanner: contract.scan_injection.scanner_name,
            action,
            hits: [],
            text: isInj && action === "strip" ? "" : body.text,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("每个样本 × 每通道：action/blocked/text 逐项咬合契约（blocked 规则锁死）", async () => {
    for (const sample of contract.samples) {
      for (const channel of contract.channels) {
        const d = await scanInjection(sample.text, channel as ScanChannel, { baseUrl });
        const action = sample.expect.is_injection
          ? contract.channel_policy[channel]
          : "allow";
        expect([sample.name, channel, d.action, d.blocked]).toEqual([
          sample.name,
          channel,
          action,
          sample.expect.is_injection && action === "block", // 契约 client_only.blocked_rule
        ]);
        if (sample.expect.is_injection && action === "strip") {
          expect(d.text, `${sample.name}/${channel}: strip 清洗结果应透传`).toBe("");
        } else {
          expect(d.text, `${sample.name}/${channel}: 原文应透传`).toBe(sample.text);
        }
        expect(d.score).toBe(sample.expect.is_injection ? contract.scan_injection.threshold + 0.4 : 0);
        expect(d.reason, "happy path 不该有 fail_closed 原因").toBeUndefined();
      }
    }
    expect(badRequests, "客户端发出的请求键集漂移").toEqual([]);
  });
});
