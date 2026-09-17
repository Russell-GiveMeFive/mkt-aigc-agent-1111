import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:8788',
      '/files': 'http://localhost:8788',
    },
  },
})
