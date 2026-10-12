import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.KINETIC_API ?? 'http://127.0.0.1:4200';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: { '/api': api, '/t/': api, '/u/': api, '/oauth': api, '/healthz': api },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
