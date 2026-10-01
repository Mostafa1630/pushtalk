import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the Vite server proxies /api (HTTP + WebSocket) to the
// backend, so the browser talks to a single origin exactly like in Docker,
// where nginx does the same job.
const backend = process.env.VITE_BACKEND_URL ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: true, ws: true } },
  },
  preview: {
    port: 8080,
    proxy: { "/api": { target: backend, changeOrigin: true, ws: true } },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
