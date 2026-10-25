import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy API calls to the local backend so the UI works fully offline on localhost.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.BACKEND_URL ?? "http://127.0.0.1:8000",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
