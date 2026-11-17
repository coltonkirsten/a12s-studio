import type { AgentView } from "@a12s-studio/contract/state";
import { useState } from "react";
import { api, useRead } from "../../api.ts";
import { HOME } from "../../logic/files.ts";
import { Editor } from "../../parts/editor.tsx";
import { Versions } from "../../parts/versions.tsx";
import { Refusal } from "./refusal.tsx";

const NOTES = `${HOME}/memory/notes.md`;

/** The role, which the owner and the team's lead write; the notes, the file the agent keeps for itself. */
export function Role({ agent }: { agent: AgentView }) {
  const [version, setVersion] = useState(0);
  const notes = useRead(() => api.file(agent.id, NOTES), `${agent.id}:${agent.presence}:${version}`);
  const saveNotes = (content: string) => api.putFile(agent.id, NOTES, { content, encoding: "utf-8" });
  const saved = () => setVersion((v) => v + 1);
  const text = notes.problem?.code === "not_found" ? "" : notes.data?.kind === "file" ? notes.data.content : null;

  return (
    <>
      <section className="inspector-section">
        <Versions
          id={agent.id}
          label="Role"
          load={(before) => api.role(agent.id, before)}
          save={(role) => api.patchAgent(agent.id, { role })}
        />
        <p className="inspector-quiet">You and the team's lead write it. A change arrives with its next message.</p>
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
