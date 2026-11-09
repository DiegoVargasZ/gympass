import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  server: {
    host: '0.0.0.0',
    watch: { ignored: ['**/output/**', '**/desktop-runtime/**', '**/data/**', '**/backups/**', '**/mobile/**'] },
  },
});
