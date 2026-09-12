import { afterEach, expect, test } from "vitest";
import { buildApp } from "./app.js";

// 票 68：@fastify/under-pressure 过载卸载装配（框架红线票）——开关纪律与 jiaotu
// JIAOTU_GATEWAY_URL 同款：UNDER_PRESSURE=on 才注册，env 缺省/其他值 = 零注册 =
// 默认形态逐字节不变。测试只打公开 seam（buildApp + /healthz + 插件自带 /status），
// 不摸插件内部；超阈用「极小假阈值」（heapUsed=1 字节，任何进程必超）在 unit 级
// 触发 503，不等真负载。插件压力读数按采样周期刷新（官方缺省 sampleInterval=1000ms，
// README：sampleInterval defaults to 1000 on Node ≥11.10.0），on 态断言先等一轮采样。

const SAMPLE_WAIT_MS = 1200;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// env 保存/恢复：开关与阈值只在单测试进程内生效，绝不漏出（approval-gateway.test.ts 同款）
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});
const setEnv = (k: string, v: string | undefined): void => {
  savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

test("UNDER_PRESSURE 未设/off/其他值 = 零注册零 shedding（默认形态逐字节不变）", async () => {
  // 阈值 env 即使误设成「必超」的假值，off 态也必须无插件、无卸载
  setEnv("UNDER_PRESSURE_MAX_HEAP_USED_BYTES", "1");
  for (const value of [undefined, "off", "OFF", "on "]) {
    setEnv("UNDER_PRESSURE", value);
    const app = buildApp();
    await app.ready(); // off 态 ready 后也无插件——「零注册」对账到插件装载完成之后
    expect(app.hasPlugin("@fastify/under-pressure"), `UNDER_PRESSURE=${value ?? "<unset>"}`).toBe(false);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode, `UNDER_PRESSURE=${value ?? "<unset>"} 不得 shed`).toBe(200);
    await app.close();
  }
});

test("UNDER_PRESSURE=on + 极小假阈值 → 插件 503 卸载（自带语义：Retry-After 头）", async () => {
  setEnv("UNDER_PRESSURE", "on");
  setEnv("UNDER_PRESSURE_MAX_HEAP_USED_BYTES", "1"); // 1 字节：进程一起即超
  const app = buildApp();
  await app.ready(); // register 在 ready 时落位，之后 hasPlugin 才反映真实装配
  expect(app.hasPlugin("@fastify/under-pressure")).toBe(true); // 框架红线：真 register
  await wait(SAMPLE_WAIT_MS); // 等第一轮采样（ready 后才起 1000ms 定时器），压力读数生效
  const res = await app.inject({ method: "GET", url: "/healthz" });
  expect(res.statusCode).toBe(503);
  expect(String(res.headers["retry-after"])).toBe("10"); // 插件缺省 retryAfter=10
  await app.close();
});

test("UNDER_PRESSURE=on 阈值 env 可覆盖：抬高假阈值不 shed，/status 暴露插件指标", async () => {
  setEnv("UNDER_PRESSURE", "on");
  setEnv("UNDER_PRESSURE_MAX_HEAP_USED_BYTES", "1099511627776"); // 1 TiB：不触发
  const app = buildApp();
  await app.ready();
  await wait(SAMPLE_WAIT_MS); // 先让插件采到一轮真实读数
  const health = await app.inject({ method: "GET", url: "/healthz" });
  expect(health.statusCode).toBe(200); // 覆盖后的高阈值不卸载
  // 插件自带 /status（exposeStatusRoute）：健康应答带四项指标——bench 的 eventLoopDelay 观察口
  const status = await app.inject({ method: "GET", url: "/status" });
  expect(status.statusCode).toBe(200);
  const body = status.json() as Record<string, number | string>;
  expect(body.status).toBe("ok");
  expect(Number(body.heapUsed)).toBeGreaterThan(0);
  expect(Number(body.rssBytes)).toBeGreaterThan(0);
  expect(Number(body.eventLoopDelay)).toBeGreaterThanOrEqual(0);
  await app.close();
});
