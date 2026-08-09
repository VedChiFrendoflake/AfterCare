import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The app resolves its API base to same-origin "/api" unless VITE_API_BASE_URL is
// set (see src/services/config.ts). In production Vercel rewrites that path to the
// API service; the dev server needs the same rewrite, or `pnpm dev` has no backend
// to find and silently drops to local mode, where no recovery plan is generated.
//
// Point VITE_DEV_API_PROXY at a locally-run API (`pnpm dev:api`, port 3001) or at
// the deployed service when you don't have AI keys locally.
export default defineConfig(({ mode }) => {
  // loadEnv, not process.env: Vite exposes .env files on import.meta.env, and the
  // config file itself never sees them otherwise.
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget =
    env.VITE_DEV_API_PROXY ?? process.env.VITE_DEV_API_PROXY ?? "http://localhost:3001";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    build: { outDir: "dist", sourcemap: true },
  };
});
