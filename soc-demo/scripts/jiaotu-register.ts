// 一次性布景（狗粮票 57，CONTEXT.md「狗粮接入」）：把 soc-demo 注册成椒图（agentjiaotu）
// 的第一个外部 client。只走椒图公开正门 /api/v1/agents——与真实注册同一扇门（椒图侧
// register_agent 审计留痕），不是身份账旁路；注册即发 api_key，明文仅本次响应出现一次
// （椒图库里只存 hash，丢了只能换名重注册）。幂等：按名查重（GET /api/v1/agents?q=<name>
// 后精确匹配 name，同椒图 seed-demo 口径），已存在则跳过注册、不动 .env。
// 产出：JIAOTU_API_KEY upsert 进仓库根 .env（已 gitignore），agent_id 打印到 stdout——
// 椒图焚毁口 Bearer 鉴权（identity/index.ts /internal/tickets/:jti/burn）与票 58 审批
// 对接都吃这把 key。网关不可达大声抛错，绝不静默。
// 用法：pnpm jiaotu:register [--url http://127.0.0.1:8080] [--name soc-demo]
//   重名不冲突是椒图语义（唯一性在 agent_id）：.env 里 key 丢了就换个 --name 重注册。
// 分账模式（狗粮票 18·Q4 裁决，M2#9）：pnpm jiaotu:register --workers [--url …]
//   对 triage/investigation/knowledge/chat 四个 worker 各注册 soc-demo-<worker>，
//   api_key 分别 upsert 进 .env 的 JIAOTU_API_KEY_<WORKER大写>（幂等按名查重同上）；
//   每 worker 注册完立即落盘（中途网故障不丢已到手的明文）。分账键全不设 = 单键模式
//   （服务级 JIAOTU_API_KEY，llm-client.ts 的回落链），行为与现状逐字节一致。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface RegisterOptions {
  /** 椒图公开面根地址；默认 env JIAOTU_GATEWAY_URL，再默认本机 8080（椒图 GATEWAY_PORT 缺省值） */
  baseUrl?: string;
  /** 注册名（幂等键）；默认 soc-demo */
  name?: string;
  /** 椒图 agent 的 scope 是身份描述性元数据（执行鉴权吃票面 scope，不是这里）；
   *  按 soc-demo 对椒图的三件事描述。 */
  scope?: string[];
  /** 归属人 */
  owner?: string;
  /** .env 落盘路径；默认仓库根 .env */
  envFile?: string;
  /** fetch 注入缝（测试替身）；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface RegisterResult {
  /** true = 本次注册；false = 按名查重命中已存在，跳过 */
  created: boolean;
  agentId: string;
  /** api_key 明文，仅 created=true 时出现一次（丢失只能换名重注册） */
  apiKeyOnce?: string;
}

/** 仓库根 .env（脚本在 scripts/ 下，向上一级）；已 gitignore 不入库 */
const DEFAULT_ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

// ---------- 分账模式（狗粮票 18·Q4）：四 worker 各一椒图身份 ----------

/** 分账 worker 名单（狗粮裁决 Q4：triage/investigation/knowledge/chat 各一 agent）。
 *  与 services/agent/src/llm-client.ts 的 JIAOTU_WORKERS 同一口径——脚本保持独立
 *  （scripts 不在模块图内，边界闸 R4），两端由 jiaotu-register.test.ts 契约锁咬合。 */
export const JIAOTU_WORKERS = ["triage", "investigation", "knowledge", "chat"] as const;

export type JiaotuWorker = (typeof JIAOTU_WORKERS)[number];

/** worker → .env 分账键名（triage → JIAOTU_API_KEY_TRIAGE）。与 llm-client.ts 的
 *  jiaotuWorkerEnvKey 同一推导式（消费端出站鉴权吃同一名字），契约锁同上。 */
export function jiaotuWorkerEnvKey(worker: string): string {
  return `JIAOTU_API_KEY_${worker.toUpperCase()}`;
}

/** 分账注册（幂等按名查重沿用既有先查后建）：四 worker 各注册 soc-demo-<worker>，
 *  created=true 的立即把明文 upsert 进 envFile 对应分账键（逐 worker 落盘，中途失败
 *  不丢已到手 key）。scope/owner 用缺省——对椒图的三件事与归属人不因 worker 而异。 */
export async function registerJiaotuWorkers(
  opts: Omit<RegisterOptions, "name"> = {},
): Promise<Record<JiaotuWorker, RegisterResult>> {
  const results = {} as Record<JiaotuWorker, RegisterResult>;
  for (const worker of JIAOTU_WORKERS) {
    const result = await registerJiaotuAgent({ ...opts, name: `soc-demo-${worker}` });
    if (result.created && result.apiKeyOnce !== undefined) {
      upsertEnvKey(
        opts.envFile ?? DEFAULT_ENV_FILE,
        jiaotuWorkerEnvKey(worker),
        result.apiKeyOnce,
        `狗粮票 18：椒图网关 ${worker} worker 分账 api_key（scripts/jiaotu-register.ts 写入，明文仅此一次）`,
      );
    }
    results[worker] = result;
  }
  return results;
}

/** upsert 单键：已有该键行 = 整行替换；没有 = 追加到文件尾（带注释行）；文件不存在 = 新建 */
export function upsertEnvKey(envFile: string, key: string, value: string, note?: string): void {
  const line = `${key}=${value}`;
  if (!existsSync(envFile)) {
    writeFileSync(envFile, `${note ? `# ${note}\n` : ""}${line}\n`, "utf8");
    return;
  }
  const content = readFileSync(envFile, "utf8");
  const keyLine = new RegExp(`^${key}=.*$`, "m");
  if (keyLine.test(content)) {
    writeFileSync(envFile, content.replace(keyLine, line), "utf8");
    return;
  }
  const glue = content.endsWith("\n") || content === "" ? "" : "\n";
  writeFileSync(envFile, `${content}${glue}${note ? `# ${note}\n` : ""}${line}\n`, "utf8");
}

export async function registerJiaotuAgent(opts: RegisterOptions = {}): Promise<RegisterResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? process.env.JIAOTU_GATEWAY_URL ?? "http://127.0.0.1:8080")
    .replace(/\/+$/, "");
  const name = opts.name ?? "soc-demo";

  // 网络层异常带上下文大声抛（裸的 "fetch failed" 在布景现场无从排查，同 seed-demo 口径）
  const call = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      return await doFetch(url, init);
    } catch (error) {
      throw new Error(`jiaotu 注册失败：请求 ${url} 不可达（${error instanceof Error ? error.message : String(error)}）`);
    }
  };

  // 先查后建（幂等）：列表公开面按名称/agent_id 子串过滤，回包再精确匹配 name——
  // 重启重跑不再吐新 key（椒图重名不冲突，唯一性在 agent_id）
  const listRes = await call(`${baseUrl}/api/v1/agents?q=${encodeURIComponent(name)}`);
  if (!listRes.ok) {
    throw new Error(`jiaotu 注册失败：GET /api/v1/agents → HTTP ${listRes.status}`);
  }
  const list = (await listRes.json()) as { agents: Array<{ agent_id: string; name: string }> };
  const existing = list.agents.find((a) => a.name === name);
  if (existing !== undefined) {
    return { created: false, agentId: existing.agent_id };
  }

  const createRes = await call(`${baseUrl}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      scope: opts.scope ?? ["任务票申领", "票据焚毁", "LLM 出站"],
      owner: opts.owner ?? "soc-demo 数字员工",
    }),
  });
  if (createRes.status !== 201) {
    throw new Error(`jiaotu 注册失败：POST /api/v1/agents → HTTP ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { agent_id: string; api_key: string };
  return { created: true, agentId: created.agent_id, apiKeyOnce: created.api_key };
}

// 只在直接执行时进 main（被 import 时不动，同 replay.ts 口径）；pnpm jiaotu:register 从仓库根调用
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  try {
    if (has("--workers")) {
      // 分账模式（狗粮票 18·Q4）：四 worker 各一 agent，key 各落各的分账键
      const results = await registerJiaotuWorkers({ baseUrl: get("--url") });
      for (const worker of JIAOTU_WORKERS) {
        const r = results[worker];
        if (r.created && r.apiKeyOnce !== undefined) {
          console.log(`[jiaotu] soc-demo-${worker} 已注册：agent_id=${r.agentId}`);
          console.log(`[jiaotu] ${jiaotuWorkerEnvKey(worker)} 已写入 ${DEFAULT_ENV_FILE}`);
        } else {
          console.log(`[jiaotu] agent「soc-demo-${worker}」已存在（${r.agentId}），跳过注册，.env 未改动`);
        }
      }
      console.log("[jiaotu] 分账键全不设 = 单键模式（JIAOTU_API_KEY 服务级身份，行为与现状一致）");
    } else {
      const result = await registerJiaotuAgent({
        baseUrl: get("--url"),
        name: get("--name"),
      });
      if (result.created && result.apiKeyOnce !== undefined) {
        upsertEnvKey(
          DEFAULT_ENV_FILE,
          "JIAOTU_API_KEY",
          result.apiKeyOnce,
          "狗粮票 57：椒图网关 agent api_key（scripts/jiaotu-register.ts 写入，明文仅此一次）",
        );
        console.log(`[jiaotu] soc-demo agent 已注册：agent_id=${result.agentId}`);
        console.log(`[jiaotu] JIAOTU_API_KEY 已写入 ${DEFAULT_ENV_FILE}`);
      } else {
        console.log(`[jiaotu] agent「${get("--name") ?? "soc-demo"}」已存在（${result.agentId}），跳过注册，.env 未改动`);
        console.log("[jiaotu] api_key 明文只在注册时出现一次：.env 里没有可用的 key 就换 --name 重注册");
      }
    }
  } catch (error) {
    console.error(`[jiaotu] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
