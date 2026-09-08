// m4 分诊 worker · KB 检索面内存 stub（票 13；真 KB = 票 17 chroma 容器）。
//
// m4 卡依赖：m7 检索面本票用内存 stub。INV-5：只有 approved 状态的 KBEntry 进检索面
// ——stub 里的条目按「已入库的 approved 条目」手写，结构上没有未审核条目可漏。
// 种子 = PRD §5.10 env_fact 的 client_env 思路：内网资产、服务器命名、已知变更登记——
// 「KB 优先核验」（FR-M4.2）：先查内部事实再谈外部 IOC。
import type { KbHit } from "./prompt.js";

export interface KbLookupParams {
  host?: string;
  path?: string;
  user?: string;
}

export interface TriageKb {
  lookup(params: KbLookupParams): Promise<KbHit[]>;
}

interface SeedEntry extends KbHit {
  matches(p: KbLookupParams): boolean;
}

const hostIs = (h: string) => (p: KbLookupParams) => p.host === h;

export class MemoryKb implements TriageKb {
  private readonly entries: SeedEntry[] = [
    {
      kind: "asset",
      title: "内网资产：centos7",
      body: "内网 Linux 服务器（client_env 资产清单在册）。",
      matches: hostIs("centos7"),
    },
    {
      kind: "asset",
      title: "内网资产：web-01",
      body: "内网 Web 服务器（client_env 资产清单在册）。",
      matches: hostIs("web-01"),
    },
    {
      kind: "user_list",
      title: "用户清单：backup/deploy",
      body: "合法服务账号：backup、deploy（交互登录应走个人账号）。",
      matches: (p) => p.user === "backup" || p.user === "deploy",
    },
    {
      kind: "known_change",
      title: "变更登记 CHG-1042：web-01 /etc/cron.d/db-backup",
      body: "2026-04 计划内变更：root 在 web-01 /etc/cron.d/db-backup 部署定时备份任务（变更单 CHG-1042，duty_lead 已批准）。syscheck 报该文件新增为预期行为。",
      matches: (p) => p.host === "web-01" && p.path === "/etc/cron.d/db-backup",
    },
  ];

  async lookup(params: KbLookupParams): Promise<KbHit[]> {
    return this.entries
      .filter((e) => e.matches(params))
      .map(({ kind, title, body }) => ({ kind, title, body }));
  }
}
