import { defineConfig } from 'vite'

// 本地 dev 用 '/'，生产构建（部署到 GitHub Pages）用 '/stETH-monitor/'
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/stETH-monitor/' : '/',
  server: {
    port: 5173,
    host: true
  }
}))
