import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: { trace: "off", channel: "msedge" },
  workers: 1, // server 端口共享，禁并行
  reporter: "list",
});
