import type { AgentView } from "@a12s-studio/contract/state";
import { useContext, useState } from "react";
import { api, Rev, useRead } from "../../api.ts";
import { HOME } from "../../logic/files.ts";
import { Problem } from "../../parts/problem.tsx";
import { Editor } from "./editor.tsx";
import { Refusal } from "./refusal.tsx";

const NOTES = `${HOME}/memory/notes.md`;

/** The role is part of the agent's instructions; the notes are the file it keeps for itself. */
export function Role({ agent }: { agent: AgentView }) {
  const rev = useContext(Rev);
  const settings = useRead(() => api.agent(agent.id), `${agent.id}:${rev}`);
  const [version, setVersion] = useState(0);
  const notes = useRead(() => api.file(agent.id, NOTES), `${agent.id}:${agent.presence}:${version}`);
  const saveNotes = (content: string) => api.putFile(agent.id, NOTES, { content, encoding: "utf-8" });
  const saved = () => setVersion((v) => v + 1);
  const text = notes.problem?.code === "not_found" ? "" : notes.data?.kind === "file" ? notes.data.content : null;

  return (
    <>
      <section className="inspector-section">
        {settings.data && (
          <Editor
            key={settings.data.role}
            label="Role"
            value={settings.data.role}
            save={(role) => api.patchAgent(agent.id, { role })}
          />
        )}
        <Problem problem={settings.problem} />
        <p className="inspector-quiet">Part of its instructions. A change applies at its next idle moment.</p>
      </section>
      <section className="inspector-section">
        {text === null ? (
          <Refusal agent={agent} problem={notes.problem} what="Wake it to read its notes." />
        ) : (
          <Editor key={text} label="Notes" value={text} save={saveNotes} saved={saved} mono />
        )}
        <p className="inspector-quiet">~/memory/notes.md, loaded when a session starts and after compaction.</p>
      </section>
    </>
  );
}
