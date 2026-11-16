import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

function App() {
  return (
    <main className="mx-auto max-w-2xl p-10">
      <h1 className="text-2xl font-semibold">my-favorites</h1>
      <p className="mt-2 text-muted-foreground text-sm">
        Web 管理台骨架（M1 后续接入登录/管理/导航站配置）
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
