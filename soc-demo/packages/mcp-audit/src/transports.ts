// MCP transport adapter（FR-M12.1，m12 卡 Seam：stdio/sse 各一）。
// 手写最小 JSON-RPC 握手：initialize → notifications/initialized → tools/list（翻页）。
// 不依赖官方 SDK：体检 CLI 要的是「拉清单」，几十行直连比引整包更可测（票 05 记录）。
import { spawn } from "node:child_process";
import readline from "node:readline";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: object;
}

export interface McpManifest {
  server: string;
  version?: string;
  transport: "stdio" | "http";
  tools: McpTool[];
}

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "soc-mcp-audit", version: "0.1.0" };

type JsonRpcResponse = {
  id: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
    tools?: McpTool[];
    nextCursor?: string;
  };
};

export function isHttpTarget(target: string): boolean {
  return /^https?:\/\//.test(target);
}

export async function listTools(target: string, timeoutMs: number): Promise<McpManifest> {
  return isHttpTarget(target) ? listToolsOverHttp(target, timeoutMs) : listToolsOverStdio(target, timeoutMs);
}

function withTimeout<T>(p: Promise<T>, ms: number, what = "target"): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timeout after ${ms}ms`)), ms)),
  ]);
}

// ---- stdio：spawn 命令，按行读 JSON-RPC ----
export function listToolsOverStdio(command: string, timeoutMs: number): Promise<McpManifest> {
  const [file, ...args] = command.trim().split(/\s+/);
  return withTimeout(
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
      child.on("error", reject);
      const pending = new Map<number, (r: JsonRpcResponse) => void>();
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.id === undefined) return;
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      });
      child.on("exit", () => reject(new Error(`server exited before handshake finished`)));
      const send = (obj: object) => child.stdin!.write(JSON.stringify(obj) + "\n");
      const call = (id: number, method: string, params: object): Promise<JsonRpcResponse["result"]> =>
        new Promise((res) => {
          pending.set(id, (msg) => res(msg.result));
          send({ jsonrpc: "2.0", id, method, params });
        });

      (async () => {
        const init = await call(1, "initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        let id = 2;
        do {
          const page = await call(id++, "tools/list", cursor ? { cursor } : {});
          tools.push(...(page?.tools ?? []));
          cursor = page?.nextCursor;
        } while (cursor);
        child.kill();
        child.stdin!.end();
        resolve({
          server: init?.serverInfo?.name ?? file,
          version: init?.serverInfo?.version,
          transport: "stdio",
          tools,
        });
      })().catch((e) => {
        child.kill();
        reject(e);
      });
    }),
    timeoutMs,
  );
}

// ---- http（streamable HTTP / SSE 双兼容）：POST JSON-RPC，响应 JSON 或 SSE 帧 ----
export async function listToolsOverHttp(url: string, timeoutMs: number): Promise<McpManifest> {
  return withTimeout(httpFlow(url), timeoutMs);
}

async function httpFlow(url: string): Promise<McpManifest> {
  const sessionId = await httpInitialize(url);
  await postRpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).catch(() => null);
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = (await postRpc(
      url,
      { jsonrpc: "2.0", id: 2 + tools.length, method: "tools/list", params: cursor ? { cursor } : {} },
      sessionId,
    )) as { tools?: McpTool[]; nextCursor?: string };
    tools.push(...(page?.tools ?? []));
    cursor = page?.nextCursor;
  } while (cursor);
  return { server: new URL(url).host, transport: "http", tools };
}

async function httpInitialize(url: string): Promise<string | undefined> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    }),
  });
  if (!res.ok) throw new Error(`initialize failed: HTTP ${res.status}`);
  await parseBody(res);
  return res.headers.get("mcp-session-id") ?? undefined;
}

async function postRpc(url: string, body: object, sessionId?: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`tools/list failed: HTTP ${res.status}`);
  return parseBody(res);
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    // SSE 帧：取最后一条 data: 的 JSON（tools/list 响应）
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const last = lines.at(-1)?.slice(5).trim();
    return last ? JSON.parse(last) : {};
  }
  return JSON.parse(text);
}
