// m13 harness 单测 · gen-alert.mjs：sourceRef 全局唯一递增（防 INV-6 去重吃掉压测流量）
// + 结构对账真 fixture + mint/upsert 体形态。
import test from "node:test";
import assert from "node:assert/strict";
import { nextId, makeAlert, makeAlertPool, makeMintBody, makeUpsertBody, loadFixtureShape } from "../lib/gen-alert.mjs";

test("nextId：进程内全局唯一递增（一万发不撞）", () => {
  const seen = new Set();
  for (let i = 0; i < 10_000; i++) seen.add(nextId());
  assert.equal(seen.size, 10_000);
});

test("makeAlert：结构照抄真 fixture（rule.id/timestamp/data/full_log 都在），只换 id/timestamp/host", () => {
  const shape = loadFixtureShape("ssh-5712-real");
  const a = makeAlert({ host: "bench-host-x" });
  assert.equal(typeof a.rule.id, "string");
  assert.ok(!Number.isNaN(Date.parse(a.timestamp)));
  assert.equal(a.agent.name, "bench-host-x");
  assert.equal(typeof a.full_log, "string");
  // 结构字段集与真 fixture 一致（照抄不增不减）
  assert.deepEqual(Object.keys(a).sort(), Object.keys(shape).sort());
  assert.notEqual(a.id, shape.id); // id 已换成全局唯一 sourceRef
});

test("makeAlertPool：一池唯一 id（5000 发对账 INV-6 口径）", () => {
  const pool = makeAlertPool(5000);
  assert.equal(new Set(pool.map((a) => a.id)).size, 5000);
});

test("makeMintBody：task_ticket 六字段照 services/gateway/app.py 真代码（一字不增不减）", () => {
  const b = makeMintBody();
  assert.deepEqual(
    Object.keys(b).sort(),
    ["allowed_tools", "case_id", "jti", "run_id", "scope", "sub", "type"].sort(),
  );
  assert.equal(b.type, "task_ticket");
  assert.ok(Array.isArray(b.scope) && b.scope.length > 0);
  assert.ok(Array.isArray(b.allowed_tools) && b.allowed_tools.length > 0);
  // 逐次调用 jti 唯一
  assert.notEqual(makeMintBody().jti, makeMintBody().jti);
});

test("makeUpsertBody：M2 直写四必填（type/source/sourceRef/title）", () => {
  const b = makeUpsertBody();
  assert.deepEqual(Object.keys(b).sort(), ["source", "sourceRef", "title", "type"].sort());
  assert.notEqual(makeUpsertBody().sourceRef, makeUpsertBody().sourceRef);
});
