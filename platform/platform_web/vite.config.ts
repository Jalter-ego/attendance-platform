import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target:
          loadEnv(mode, process.cwd(), '').PLATFORM_API_TARGET ||
          'http://127.0.0.1:5001',
        changeOrigin: true,
      },
    },
  },
}));
