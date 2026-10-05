import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: { main: 'index.html', spectate: 'spectate.html', replay: 'replay.html', studio: 'studio.html', leaderboard: 'leaderboard.html' },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
