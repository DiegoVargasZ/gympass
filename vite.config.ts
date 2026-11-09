import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    // Piso de compatibilidad: Chrome/Edge 109 y Firefox 115 ESR son las ultimas
    // versiones que instalan en Windows 7 y 8.1. Fijarlas aqui hace que esbuild
    // transpile cualquier sintaxis posterior en vez de romper en esos equipos.
    target: ['chrome109', 'edge109', 'firefox115', 'safari15'],
    cssTarget: ['chrome109', 'edge109', 'firefox115', 'safari15'],
  },
  server: {
    host: '0.0.0.0',
    watch: { ignored: ['**/output/**', '**/desktop-runtime/**', '**/data/**', '**/backups/**', '**/mobile/**'] },
  },
});
