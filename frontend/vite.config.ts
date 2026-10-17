import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    // Same origin as in production, where Nginx serves /api (ADR 0002): no CORS to configure.
    // API_URL points to another backend (another port, a test database).
    proxy: {
      '/api': process.env.API_URL ?? 'http://127.0.0.1:3000',
    },
  },
})
