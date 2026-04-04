import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In local dev, /api/spy?apikey=X&lookback=Y is proxied to this handler.
      // Vercel handles it automatically in production via the api/spy.js file.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
