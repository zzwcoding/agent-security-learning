// 组件测试入口：antd v5 × React 19 官方兼容补丁（与 main.tsx 同一 import）
import "@ant-design/v5-patch-for-react-19";

// jsdom 没实现的浏览器 API 打桩：antd 的响应式断点（matchMedia）与表格自适应
// 测量（ResizeObserver）在组件测试里需要。已有原生实现时不动（??=）。
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

window.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
