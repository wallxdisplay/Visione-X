import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Mirrors the Hosting rewrite so /api works against the Functions emulator in dev.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5001/demo-visione-x/asia-south1/api',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
  },
});
