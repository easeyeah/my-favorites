import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: "my-favorites — 智能书签导航",
    description: "AI 整理书签，生成你的个人导航主页",
    // 品牌图标：透明底 + 图形撑满（母版 assets/brand/svg/icon-extension-transparent.svg，2026-11-20 用户反馈改造：白底方块不融合、图形小一圈）
    icons: {
      "16": "/icon/16.png",
      "32": "/icon/32.png",
      "48": "/icon/48.png",
      "128": "/icon/128.png",
    },
    permissions: ["bookmarks", "activeTab", "contextMenus", "storage", "unlimitedStorage", "scripting", "tabs", "pageCapture"],
    // 快速收藏快捷键（原型 02：Ctrl+Shift+S）
    commands: {
      "quick-save": {
        suggested_key: { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
        description: "快速收藏当前页（AI 即时建议归位）",
      },
    },
    // M1：本地自建服务端固定放行；云端/NAS 自定义 origin 走 optional_host_permissions（M2）
    host_permissions: ["http://localhost:3000/*", "http://127.0.0.1:3000/*", "http://localhost:3007/*", "http://127.0.0.1:3007/*"],
  },
});
