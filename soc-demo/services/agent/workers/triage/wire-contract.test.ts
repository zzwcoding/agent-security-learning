// 票 30：alert wire 全链契约测试（对账三-15「三段各有本地测试但链条无 fixture 锁」）。
//
// 锚 = fixtures/alerts 具名 fixture。三段同锁：
//   ① ingest 映射：fixture 走【真 ingest 服务】的 webhook 正门（子进程起服务 →
//      真 mapWazuhAlert，不是 testkit 的布景副本）；
//   ② REST 存取：真 case-backend（子进程）POST /api/v1/alerts 存进、GET 读出的
//      wire 形状逐字段锁；
//   ③ agent 消费：生产 HttpTriageM2.getAlert 读到的 AlertDto 形状，以及 FR-M2.4
//      按 hostname 归并、TLP 溯源到 case observables（M6 富化闸门的输入）。
//
// 纪律（边界规则 R1）：agent/ingest/case-backend 互不 import 源码——跨服务断言
// 全部走公开 REST 面，服务用 testkit 的子进程先例（票 28）起真件。
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HttpTriageM2 } from "./m2.js";
import { httpJson, startCaseBackend, startIngest } from "./testkit.js";

const FIX = (f: string) =>
  fileURLToPath(new URL(`../../../../fixtures/alerts/${f}`, import.meta.url));
const readFixture = (f: string): Record<string, unknown> =>
  JSON.parse(readFileSync(FIX(f), "utf8")) as Record<string, unknown>;

test(
  "ssh-5712-real.json：webhook→REST→HttpTriageM2 三段同锚；hostname 进案、FR-M2.4 归并对回放数据生效",
  async () => {
    const cb = await startCaseBackend();
    const ingest = await startIngest(cb.url);
    try {
      const m2 = new HttpTriageM2(cb.url);

      // ① ingest webhook 正门：响应 wire = 201 {alert_id, dedup}（FR-M1.1 单条）
      const post = await httpJson(
        ingest.url, "POST", "/api/v1/webhooks/alerts", readFixture("ssh-5712-real.json"),
      );
      expect(post.status).toBe(201);
      expect(post.json).toEqual({ alert_id: expect.any(String), dedup: false });
      const alertId = String(post.json.alert_id);

      // ② REST 存取 wire：case-backend mapAlert 形状逐字段（camelCase、tags 数组、
      //    不可信标记在 description、去重计数 occurrences）
      const stored = await httpJson(cb.url, "GET", `/api/v1/alerts/${alertId}`);
      expect(stored.status).toBe(200);
      expect(stored.json).toMatchObject({
        id: alertId,
        type: "wazuh_alert",
        source: "wazuh:centos7",
        sourceRef: "1682430696.3725",
        title: "sshd: brute force trying to get access to the system.",
        severity: 3,
        tlp: 2,
        pap: 2,
        status: "New",
        tags: ["group:syslog", "group:sshd", "group:authentication_failures", "mitre:T1110"],
        verdict: null,
        verdictAi: null,
        occurrences: 1,
      });
      expect(stored.json.description).toContain("sshd: brute force");
      expect(stored.json.description).toContain("[untrusted:true field:full_log]");
      expect(stored.json.description).toContain("Invalid user blimey from 18.18.18.18");

      // ② observables wire（票 30 新增 hostname 首位 + 继承 tlp=2）：
      //    [{hostname centos7, 不带 untrusted}, {ip, untrusted}, {other, untrusted}]
      const obs = stored.json.observables as {
        dataType: string; data: string; message: string; tlp: number; tags: string[];
      }[];
      expect(obs.map((o) => o.dataType)).toEqual(["hostname", "ip", "other"]);
      expect(obs[0]).toMatchObject({ data: "centos7", message: "from agent.name", tlp: 2, tags: [] });
      expect(obs[1]).toMatchObject({ data: "18.18.18.18", tlp: 2, tags: ["untrusted"] });
      expect(obs[2]).toMatchObject({ data: "blimey", tlp: 2, tags: ["untrusted"] });

      // ③ agent 消费 wire：HttpTriageM2.getAlert 的 AlertDto（triage flow 逐字段用它们：
      //    hostOf 认 observables 里的 hostname，kb_check 用 other/filename，verdict 写回认 id）
      const alert = await m2.getAlert(alertId);
      expect(alert).not.toBeNull();
      expect(alert!.id).toBe(alertId);
      expect(alert!.sourceRef).toBe("1682430696.3725");
      expect(alert!.title).toBe("sshd: brute force trying to get access to the system.");
      expect(alert!.severity).toBe(3);
      expect(alert!.status).toBe("New");
      expect(alert!.tags).toEqual([
        "group:syslog", "group:sshd", "group:authentication_failures", "mitre:T1110",
      ]);
      expect(alert!.verdict).toBeNull();
      expect(alert!.verdictAi).toBeNull();
      expect(alert!.description).toContain("[untrusted:true field:full_log]");
      expect(alert!.observables?.find((o) => o.dataType === "hostname")?.data).toBe("centos7");

      // ③ FR-M2.4 归并：回放流水线进来的告警按 hostname 真能归并（票 13 缺口闭合）
      expect(await m2.findActiveCases("centos7", 24)).toEqual([]);
      const { caseId } = await m2.createCase(alertId);
      const active = await m2.findActiveCases("centos7", 24);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(caseId);
      // case 标题 primary entity 也认 hostname observable（不再是 sourceRef 兜底）
      expect(active[0].title).toBe("[wazuh_alert] - centos7 - 2023-04-25");
    } finally {
      await ingest.close();
      await cb.close();
    }
  },
  30_000,
);

test(
  "vt-87105-malware-tlp-red.json：TLP 溯源进案——alert tlp=4 → case observables 全 tlp=4（enrich/02 类布景不再需 DB 直种）",
  async () => {
    const cb = await startCaseBackend();
    const ingest = await startIngest(cb.url);
    try {
      const m2 = new HttpTriageM2(cb.url);
      const post = await httpJson(
        ingest.url, "POST", "/api/v1/webhooks/alerts", readFixture("vt-87105-malware-tlp-red.json"),
      );
      expect(post.status).toBe(201);
      const alertId = String(post.json.alert_id);

      // 告警级：rule.groups 里的 tlp:red 标记 → tlp=4（默认 2 的硬编码退役）
      const alert = await httpJson(cb.url, "GET", `/api/v1/alerts/${alertId}`);
      expect(alert.json.tlp).toBe(4);
      expect(alert.json.tags).toContain("group:tlp:red");

      // observable 级：继承告警 tlp → 建 case 后 observables 全 tlp=4——
      // 这正是 M6 富化闸门的输入形状（票 15 的 tlp=4 数据此前只能直种）
      const { caseId } = await m2.createCase(alertId);
      const detail = await httpJson(cb.url, "GET", `/api/v1/cases/${caseId}`);
      expect(detail.json.tlp).toBe(4);
      const obs = detail.json.observables as { dataType: string; data: string; tlp: number }[];
      expect(obs.map((o) => o.dataType)).toEqual(["hostname", "filename", "hash"]);
      expect(obs.every((o) => o.tlp === 4)).toBe(true);
      expect(obs.find((o) => o.dataType === "hash")?.data).toBe(
        "c05640e21ec2b1b4b4101c1a67a1a3c8af7c7ae9b6b98f8b1b1f0e9a2d3c4b5a",
      );
    } finally {
      await ingest.close();
      await cb.close();
    }
  },
  30_000,
);
