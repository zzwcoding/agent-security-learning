// 票 37 验收①②的拓扑断言：compose profile observability 一键起 Langfuse + 默认链路零改动。
// 票 12/26 的 test_compose_topology.py 同类风格，但落点按票面准许放 agent 测试（vitest，
// CI 的 pnpm test 原地跑）——只读 docker-compose.yml 的静态事实 + 真 `docker compose
// config`（daemon 探测 skip 先例：票 16 msbProbe / 票 17 chromaSmokeProbe，CI 无 docker
// 显式 skip 不装绿）；「真容器能起 + trace 落库」由 scripts/langfuse-smoke-37.sh 真机验证。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const composeText = (): string => readFileSync(`${ROOT}docker-compose.yml`, "utf8");

/** 取顶层服务块（两空格键到下一个两空格键之间）——自家的 compose 文件形状固定，够用。 */
function serviceBlock(name: string): string {
  const lines = composeText().split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith("    ") || lines[end].trim() === "")) end += 1;
  return lines.slice(start, end).join("\n");
}

describe("票 37 静态拓扑：langfuse 双服务挂 profile observability（ADR 0001 承诺兑现）", () => {
  test("langfuse + langfuse-db 两个服务都存在且 profiles 含 observability", () => {
    for (const name of ["langfuse", "langfuse-db"]) {
      const block = serviceBlock(name);
      expect(block, `缺 ${name} 服务`).not.toBe("");
      const profiles = block.match(/profiles:[^\n]*/)?.[0] ?? "";
      expect(profiles, `${name} 缺 profiles`).toContain("profiles:");
      expect(profiles, `${name} profiles 未含 observability`).toContain("observability");
    }
  });

  test("官方镜像按 digest 钉（票 26/17 先例：latest 漂移不可接受），且不重建（ADR 0001：自写件不动镜像内部）", () => {
    for (const name of ["langfuse", "langfuse-db"]) {
      const image = serviceBlock(name).match(/image:\s*(\S+)/);
      expect(image, `${name} 缺 image`).not.toBeNull();
      expect(image?.[1] ?? "", `${name} 未按 sha256 digest 钉`).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(serviceBlock(name), `${name} 不许 build（官方镜像直接用）`).not.toMatch(/\n\s+build:/);
    }
    expect(serviceBlock("langfuse").match(/image:\s*(\S+)/)?.[1] ?? "").toContain("langfuse/langfuse");
  });

  test("agent 挂三把可选钥匙 env（存在才启用的旁路开关）：key 缺省空，HOST 缺省容器服务名", () => {
    const block = serviceBlock("agent");
    for (const key of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) {
      expect(block, `agent 缺 ${key} 穿透`).toMatch(new RegExp(`${key}:\\s*\\$\\{${key}:-\\}`));
    }
    expect(block).toMatch(/LANGFUSE_HOST:\s*\$\{LANGFUSE_HOST:-http:\/\/langfuse:3000\}/);
  });

  test("agent 不许 depends_on langfuse（会隐式激活 profile / 默认 up 被拖累）", () => {
    // depends_on 子键是六空格缩进的 `langfuse:`——env 里的 LANGFUSE_* 全大写不会误伤
    expect(serviceBlock("agent")).not.toMatch(/\n {6}langfuse:/);
  });
});

// ---------- 真 docker compose config 语义断言（daemon 可用才跑，否则显式 skip） ----------

function dockerOk(): boolean {
  try {
    return spawnSync("docker", ["info", "--format", "ok"], { timeout: 10_000, encoding: "utf8" })
      .stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

const dockerUp = dockerOk();
if (!dockerUp) {
  console.warn("[票 37 compose config 语义断言 skip] docker daemon 不可用——静态断言已跑，真机验证归 scripts/langfuse-smoke-37.sh");
}

describe.skipIf(!dockerUp)("票 37 compose config 语义（默认九服务不含 langfuse；开 profile 才含）", () => {
  const services = (extra: string[] = []): string[] =>
    spawnSync("docker", ["compose", "-f", `${ROOT}docker-compose.yml`, ...extra, "config", "--services"], {
      encoding: "utf8",
    }).stdout.trim().split("\n").sort();

  test("默认 config（不开 profile）：langfuse / langfuse-db 都不在，九服务原样", () => {
    const svcs = services();
    expect(svcs).not.toContain("langfuse");
    expect(svcs).not.toContain("langfuse-db");
    // 票面基线：默认一键起的九服务一个不能少（演示会话实测口径）
    expect(svcs).toEqual([
      "agent", "case-backend", "chroma", "contextforge", "gateway",
      "guards", "ingest", "openfga", "web",
    ]);
  });

  test("开 profile observability：langfuse / langfuse-db 进 config", () => {
    const svcs = services(["--profile", "observability"]);
    expect(svcs).toContain("langfuse");
    expect(svcs).toContain("langfuse-db");
  });
});
