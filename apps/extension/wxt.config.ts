import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: "my-favorites — 智能书签导航",
    description: "AI 整理书签，生成你的个人导航主页",
    permissions: ["bookmarks", "activeTab", "contextMenus", "storage", "unlimitedStorage", "sidePanel"],
    // M1：本地自建服务端固定放行；云端/NAS 自定义 origin 走 optional_host_permissions（M2）
    host_permissions: ["http://localhost:3000/*", "http://127.0.0.1:3000/*", "http://localhost:3007/*", "http://127.0.0.1:3007/*"],
  },
});
