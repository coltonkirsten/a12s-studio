import { OWNER_PORT } from "@a12s-studio/contract/names";
import { defineConfig } from "vite";

// The owner API accepts only requests addressed to itself: the proxy presents them as the app's own page would.
// FIXTURE_PORT points it at the fixture server instead, which a running Studio keeps off the owner port.
const OWNER = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? OWNER_PORT}`;

export default defineConfig({
  // ws: the terminal is a WebSocket under /api.
  server: { proxy: { "/api": { target: OWNER, changeOrigin: true, ws: true, headers: { origin: OWNER } } } },
});
