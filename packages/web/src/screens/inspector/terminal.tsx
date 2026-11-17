import type { AgentView } from "@a12s-studio/contract/state";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { Asleep } from "./refusal.tsx";

// A fixed size that fits the inspector; the shell sees the same.
const ROWS = 24;
const COLS = 80;

/** A shell in the agent's computer, for as long as the tab is open. */
export function Terminal({ agent }: { agent: AgentView }) {
  const [session, setSession] = useState(0);
  const [ended, setEnded] = useState<string | null>(null);
  if (agent.presence === "asleep" || ended === "asleep") {
    return <Asleep agent={agent} what="Wake it to open a terminal." />;
  }
  return (
    <section className="inspector-section">
      <Screen key={session} agent={agent.id} onEnd={setEnded} />
      {ended !== null && (
        <div className="inspector-bar">
          <p className="inspector-quiet">{ended === "" ? "The terminal closed." : `The terminal closed (${ended}).`}</p>
          <button
            type="button"
            className="button"
            onClick={() => {
              setEnded(null);
              setSession((s) => s + 1);
            }}
          >
            Open again
          </button>
        </div>
      )}
    </section>
  );
}

function Screen({ agent, onEnd }: { agent: string; onEnd: (reason: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    // The page's own colours and type, light or dark, read once when the terminal opens.
    const style = getComputedStyle(element);
    const term = new XTerm({
      rows: ROWS,
      cols: COLS,
      fontFamily: style.fontFamily,
      fontSize: 12,
      theme: { background: style.backgroundColor, foreground: style.color, cursor: style.color },
    });
    term.open(element);
    const socket = new WebSocket(api.terminal(agent, ROWS, COLS));
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => term.write(new Uint8Array(event.data as ArrayBuffer));
    socket.onclose = (event) => onEnd(event.reason);
    const encoder = new TextEncoder();
    const typing = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    term.focus();
    return () => {
      typing.dispose();
      socket.onclose = null;
      socket.close();
      term.dispose();
    };
  }, [agent, onEnd]);
  return <div className="terminal-box" ref={box} />;
}
