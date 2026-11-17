import { OWNER_PORT } from "@a12s-studio/contract/names";
import { defineConfig } from "vite";

// The owner API accepts only requests addressed to itself: the proxy presents them as the app's own page would.
// FIXTURE_PORT points it at the fixture server instead, which a running Studio keeps off the owner port.
const OWNER = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? OWNER_PORT}`;

export default defineConfig({
  server: { proxy: { "/api": { target: OWNER, changeOrigin: true, headers: { origin: OWNER } } } },
});
