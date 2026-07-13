import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/health": API_TARGET,
      "/v1": API_TARGET
    }
  }
});
