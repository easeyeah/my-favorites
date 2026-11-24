/**
 * 静态资源 / 构建环境类型声明。
 *
 * `import "./panel.css"` 这类副作用导入由 WXT（Vite）在构建期处理，类型来自 `vite/client` 的
 * `declare module "*.css"`。WXT 默认把它注入生成的 `.wxt/wxt.d.ts`，但本仓库的 tsconfig 既没有
 * extends `.wxt/tsconfig.json`，也没有把 `.wxt/wxt.d.ts` 纳入 include，于是严格诊断
 * （`noUncheckedSideEffectImports`，新版编辑器默认开启）会把所有 CSS 导入报成 TS2307。
 *
 * `apps/extension` 自身不依赖 vite（pnpm 严格 node_modules），所以经 wxt 的导出取同一份类型。
 */
/// <reference types="wxt/vite-builder-env" />
