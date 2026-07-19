import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts'],
    // Windows 上限制并发并使用线程池，避免高核心机器的 fork worker 偶发退出。
    pool: 'threads',
    maxWorkers: 4,
  },
})
