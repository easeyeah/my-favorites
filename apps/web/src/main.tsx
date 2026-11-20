/** my-favorites Web 管理台入口（F6.2）：自建端单容器自带，打开服务端地址即是管理台 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
