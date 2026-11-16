import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: "my-favorites — 智能书签导航",
    description: "AI 整理书签，生成你的个人导航主页",
    permissions: ["bookmarks", "activeTab", "contextMenus", "storage", "unlimitedStorage"],
    // dev 时放开本地服务端访问（技术方案 §8.1）
    host_permissions:
      process.env["WXT_DEV"] === "1" ? ["http://localhost:3000/*"] : [],
  },
});
