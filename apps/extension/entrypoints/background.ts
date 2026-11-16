// background service worker —— 收件箱监听与编排中枢（技术方案 §6）

export default defineBackground((): void => {
  // M1 步骤 5 将接入：bookmarks.onCreated/onMoved 监听收件箱、右键收藏、pageCapture 编排
  browser.runtime.onInstalled.addListener(() => {
    console.log("[my-favorites] installed");
  });
});
