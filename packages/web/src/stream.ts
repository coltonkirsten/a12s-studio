import type { LiveText, StudioState } from "@a12s-studio/contract/state";
import { useEffect, useState } from "react";
import { appendLive } from "./logic/live.ts";

const RETRY_MS = [500, 1000, 2000, 5000];

/** The server's pushed state for the open thread. The browser holds nothing else. */
export function useStudio(thread: string | null): { state: StudioState | null; connected: boolean } {
  const [state, setState] = useState<StudioState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    function connect(): void {
      source = new EventSource(thread ? `/api/stream?thread=${encodeURIComponent(thread)}` : "/api/stream");
      source.onopen = () => {
        failures = 0;
        setConnected(true);
      };
      source.addEventListener("state", (event) => setState(JSON.parse(event.data) as StudioState));
      source.addEventListener("live", (event) => {
        const live = JSON.parse(event.data) as LiveText;
        setState((s) => (s ? appendLive(s, live) : s));
      });
      source.onerror = () => {
        setConnected(false);
        // EventSource retries a dropped connection itself; it gives up only on an HTTP error, so retry that here.
        if (source?.readyState !== EventSource.CLOSED) return;
        retry = setTimeout(connect, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
        failures += 1;
      };
    }

    connect();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [thread]);

  return { state, connected };
}
