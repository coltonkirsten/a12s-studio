import { defineConfig } from "vite";

// The owner API accepts only requests addressed to itself: the proxy presents them as the app's own page would.
const OWNER = "http://127.0.0.1:7400";

export default defineConfig({
  server: { proxy: { "/api": { target: OWNER, changeOrigin: true, headers: { origin: OWNER } } } },
});
