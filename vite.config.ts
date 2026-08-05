import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    vue({
      template: {
        transformAssetUrls: false,
      },
    }),
  ],
  server: {
    allowedHosts: ['localhost', '127.0.0.1'],
  },
})
