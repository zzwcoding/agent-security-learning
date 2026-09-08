import { describe, expect, test } from "vitest";
import {
  extractObservables,
  mapWazuhAlert,
  severityFromLevel,
  untrustedSection,
  validateWazuhAlert,
} from "./wazuh.js";

// PRD §6-M1 接口契约里的 Wazuh 告警示例（5712 官方 logtest 形态）
const wazuh5712 = {
  timestamp: "2023-04-25T13:51:36.409000Z",
  id: "1682430696.3725",
  rule: {
    id: "5712",
    level: 10,
    description: "sshd: brute force trying to get access to the system.",
    groups: ["syslog", "sshd", "authentication_failures"],
    mitre: { id: ["T1110"], tactic: ["Credential Access"], technique: ["Brute Force"] },
  },
  agent: { id: "000", name: "centos7" },
  manager: { name: "centos7" },
  decoder: { name: "sshd" },
  data: { srcip: "18.18.18.18", srcport: "48928", srcuser: "blimey" },
  full_log:
    "Oct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928",
  location: "master->/var/log/syslog",
};

describe("severity 映射表（PRD §5.1：0-4→1，5-9→2，10-14→3，15→4）", () => {
  test("带边界值全带走一遍", () => {
    const table: [number, number][] = [
      [0, 1], [4, 1], [5, 2], [9, 2], [10, 3], [14, 3], [15, 4], [16, 4],
    ];
    for (const [level, severity] of table) {
      expect(severityFromLevel(level), `rule.level=${level}`).toBe(severity);
    }
  });
});

test("5712 契约示例映射：source/sourceRef/title/severity/tags/date 全落位", () => {
  const input = mapWazuhAlert(wazuh5712);
  expect(input.type).toBe("wazuh_alert");
  expect(input.source).toBe("wazuh:centos7"); // §5.1：'wazuh:' + manager.name
  expect(input.sourceRef).toBe("1682430696.3725"); // §5.1：取告警 id，天然去重键
  expect(input.title).toBe("sshd: brute force trying to get access to the system.");
  expect(input.severity).toBe(3); // level 10 → High
  expect(input.tlp).toBe(2);
  expect(input.pap).toBe(2);
  expect(input.tags).toEqual([
    "group:syslog",
    "group:sshd",
    "group:authentication_failures",
    "mitre:T1110",
  ]);
  expect(input.date).toBe(Date.parse("2023-04-25T13:51:36.409000Z"));
});

test("未知字段整包进 raw 不丢数据（PRD 职责与边界：不做全字段 schema 校验拒绝）", () => {
  const weird = { ...wazuh5712, some_future_field: { nested: [1, 2, 3] } };
  const input = mapWazuhAlert(weird);
  expect(input.raw).toEqual(weird);
});

test("observable 抽取走结构化字段（PRD §6-M1 实现机制）：srcip/srcuser/url/path/hash", () => {
  const obs = extractObservables({
    data: { srcip: "18.18.18.18", srcport: "48928", srcuser: "blimey", url: "http://x/y" },
    syscheck: {
      path: "/etc/cron.d/db-backup",
      md5_after: "9d5f1c7e21b52a6e59b4c31f2e5a2d6e",
      sha256_after: "c05640e21ec2b1b4b4101c1a67a1a3c8af7c7ae9b6b98f8b1b1f0e9a2d3c4b5a",
      size_after: "137", // 非 hash 字段，不抽
      uname_after: "root",
    },
  });
  const types = obs.map((o) => `${o.dataType}:${o.data}`);
  expect(types).toContain("ip:18.18.18.18");
  expect(types).toContain("other:blimey");
  expect(types).toContain("url:http://x/y");
  expect(types).toContain("filename:/etc/cron.d/db-backup");
  expect(types).toContain("hash:9d5f1c7e21b52a6e59b4c31f2e5a2d6e");
  expect(types).toContain(
    "hash:c05640e21ec2b1b4b4101c1a67a1a3c8af7c7ae9b6b98f8b1b1f0e9a2d3c4b5a",
  );
  expect(types).not.toContain("hash:137");
});

describe("不可信标记（CONTEXT.md 术语 untrusted；FR-M1.4 入库即标记）", () => {
  test("full_log 进 description 附录段并带 untrusted 标记", () => {
    const input = mapWazuhAlert(wazuh5712);
    expect(input.description).toContain(
      untrustedSection("full_log", wazuh5712.full_log),
    );
    expect(input.description).toContain("[untrusted:true field:full_log]");
  });

  test("data.* 抽出的 observable 带 untrusted tag，syscheck 抽出的不带", () => {
    const obs = extractObservables({
      data: { srcip: "10.0.0.1" },
      syscheck: { path: "/etc/passwd" },
    });
    const byType = Object.fromEntries(obs.map((o) => [o.dataType, o]));
    expect(byType.ip?.tags).toContain("untrusted");
    expect(byType.filename?.tags ?? []).not.toContain("untrusted");
  });
});

describe("接收校验（PRD §6-M1：缺 rule.id/timestamp → 422）", () => {
  test("完整告警过闸", () => {
    expect(validateWazuhAlert(wazuh5712)).toEqual({ ok: true });
  });
  test("缺 rule.id 报 details", () => {
    const noRule: Record<string, unknown> = { ...wazuh5712 };
    delete noRule.rule;
    const v = validateWazuhAlert(noRule);
    expect(v).toEqual({ ok: false, details: ["rule.id_missing"] });
  });
  test("缺/坏 timestamp 报 details", () => {
    expect(validateWazuhAlert({ rule: { id: "1" }, timestamp: "not-a-date" })).toEqual({
      ok: false,
      details: ["timestamp_missing_or_invalid"],
    });
    expect(validateWazuhAlert({ rule: { id: "1" } })).toEqual({
      ok: false,
      details: ["timestamp_missing_or_invalid"],
    });
  });
  test("非对象直接拒", () => {
    expect(validateWazuhAlert("hello")).toEqual({ ok: false, details: ["body_not_object"] });
  });
});
