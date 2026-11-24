/**
 * Vite 客户端类型：`import "./index.css"` 等静态资源副作用导入的模块声明、
 * `import.meta.env` 类型均来自 `vite/client`。tsconfig 未 extends Vite 模板的
 * `tsconfig.app.json`，故在此显式声明（否则 `noUncheckedSideEffectImports` 会报 TS2307）。
 */
/// <reference types="vite/client" />
