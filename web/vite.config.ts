import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the SAME Express server (server.ts serves web/dist as static files),
// so in production there's no CORS to deal with. In dev, proxy API calls to the
// real server process so `vite dev` and `npm run server` can run side by side.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/sessions": "http://127.0.0.1:4177",
      "/health": "http://127.0.0.1:4177",
    },
  },
});
