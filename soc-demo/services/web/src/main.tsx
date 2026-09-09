// @ant-design/v5-patch-for-react-19：antd v5 官方的 React 19 兼容补丁
// （静态 message/Modal 等底层用的 ReactDOM 渲染口在 React 19 被移除，补丁接管）。
import "@ant-design/v5-patch-for-react-19";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
