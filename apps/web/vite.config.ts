import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
        // dev 下与生产同源形态对齐：管理台经同一 origin 访问 API/登录/公开页，
        // 代理到本地自建端（docker compose dev 已在 3000）。
        // 用正则精确匹配：短前缀（如 "/s"）会把 /src/* 模块请求一并代理走
        proxy: {
            '^/api/': 'http://127.0.0.1:3000',
            '^/auth/': 'http://127.0.0.1:3000',
            '^/s/': 'http://127.0.0.1:3000',
            '^/healthz$': 'http://127.0.0.1:3000',
        },
    },
})
