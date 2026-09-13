// 票 94：web vitest 收尾期 Unhandled Error（ReferenceError: window is not defined）治本面。
//
// 源链：react-dom@19.2 延迟提交（IMMEDIATE_COMMIT）把 passive effects 排进 Normal 优先级
// scheduler 回调，回调首行 `schedulerEvent = window.event`（react-dom-client.development.js:17920，
// ImmediatePriority 的 processRootScheduleInImmediateTask 同走此路）；scheduler@0.27 在**模块求值时**
// 捕获 Node 的 setImmediate（localSetImmediate → performWorkUntilDeadline）。文件跑完 jsdom 环境
// teardown 摘掉 window 后，队列里残留的 Immediate 一点火就 ReferenceError——unhandled error 非零
// 使 vitest 退出码 1，把用例全过的绿跑挂红（间歇：immediate 在 teardown 前点火则无事）。
//
// 修法（票面方向二，setup 级清 pending immediates）：包一层 setImmediate/clearImmediate 记
// pending 句柄，**只在文件收尾（afterAll，环境 teardown 之前）清空**。断言已在用例内完成，
// 收尾期残留的渲染活不参与任何用例结果；scheduler 实例按测试文件隔离，收尾后不再有人排程。
//
// 为什么**不做** afterEach 级清空：scheduler 的 host 回调是「点火→跑完→复位 isMessageLoopRunning」
// 的循环活，中途 clearImmediate 掉 pending flush 回调会把标志位永远卡在 true，此后整个文件的
// scheduleCallback 全部静默失排（实测单跑 pages.test.tsx 红 23/26，页面 fetch 后永不渲染）——
// 用例之间让 immediate 自然跑完（window 还在，与修复前行为逐字节一致），只收尾清一次。
//
// 本文件必须在 setupFiles **首位**：setup.ts 首行的 antd patch import 会连带求值
// react-dom→scheduler，句柄追踪装晚了就追不到 scheduler 已捕获的那份 setImmediate。
// 领地纪律：只动 vitest setup，零生产源码改动；既有用例一条不删不改。
// 注：vi.useFakeTimers/useRealTimers（sse.test.ts）安装/卸载时保存与还原的是本 wrapper，语义不受影响。

import { afterAll } from "vitest";

interface HostImmediates {
  setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  clearImmediate: (handle: unknown) => void;
}

const host = globalThis as unknown as Partial<HostImmediates>;
const rawSetImmediate = host.setImmediate;
const rawClearImmediate = host.clearImmediate;

if (rawSetImmediate && rawClearImmediate) {
  const pending = new Set<unknown>();

  host.setImmediate = (callback, ...args) => {
    const handle = rawSetImmediate((...a) => {
      pending.delete(handle); // 到点即焚：已跑掉的不算 pending
      callback(...a);
    }, ...args);
    pending.add(handle);
    return handle;
  };

  host.clearImmediate = (handle) => {
    pending.delete(handle);
    rawClearImmediate(handle);
  };

  // 文件收尾（所有用例与钩子跑完、jsdom teardown 之前）清空队列：排进队列但没跑到的
  // 渲染活不再点火——post-teardown 的 window is not defined 从根上无队可入。
  afterAll(() => {
    for (const handle of pending) rawClearImmediate(handle);
    pending.clear();
  });
}
