import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Proxied so the browser talks to one origin and no CORS config is
    // needed in development.
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: true } },
  },
});
