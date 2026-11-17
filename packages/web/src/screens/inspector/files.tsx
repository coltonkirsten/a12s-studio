import type { FileView } from "@a12s-studio/contract/api";
import type { AgentView } from "@a12s-studio/contract/state";
import { useState } from "react";
import { api, useRead } from "../../api.ts";
import { crumbs, fileSize, HOME } from "../../logic/files.ts";
import { Editor } from "../../parts/editor.tsx";
import { Refusal } from "./refusal.tsx";

/** The agent's home drive: folders to open, text files to read and edit. */
export function Files({ agent }: { agent: AgentView }) {
  const [path, setPath] = useState(HOME);
  const [version, setVersion] = useState(0);
  const file = useRead(() => api.file(agent.id, path), `${agent.id}:${path}:${agent.presence}:${version}`);
  const shown = file.data?.path === path ? file.data : null;

  return (
    <section className="inspector-section">
      <nav className="crumbs" aria-label="Folder">
        {crumbs(path).map((step) => (
          <button key={step.path} type="button" disabled={step.path === path} onClick={() => setPath(step.path)}>
            {step.name}
          </button>
        ))}
      </nav>
      <Refusal agent={agent} problem={file.problem} what="Wake it to see its files." />
      {shown?.kind === "dir" && <Folder dir={shown} open={setPath} />}
      {shown?.kind === "file" && <FileText agent={agent} file={shown} saved={() => setVersion((v) => v + 1)} />}
    </section>
  );
}

function Folder({ dir, open }: { dir: FileView & { kind: "dir" }; open: (path: string) => void }) {
  const entries = [...dir.entries].sort(
    (a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name),
  );
  if (entries.length === 0) return <p className="inspector-quiet">This folder is empty.</p>;
  return (
    <ul className="entries">
      {entries.map((entry) => (
        <li key={entry.name}>
          <button type="button" className="entry" onClick={() => open(`${dir.path}/${entry.name}`)}>
            <span className={`entry-name entry-${entry.kind}`}>{entry.name}</span>
            <span className="entry-size">{entry.kind === "dir" ? "Folder" : fileSize(entry.size)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function FileText({ agent, file, saved }: { agent: AgentView; file: FileView & { kind: "file" }; saved: () => void }) {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  if (file.encoding === "base64") {
    return <p className="inspector-quiet">{`${name} is not text (${fileSize(file.size)}), so it is not shown.`}</p>;
  }
  if (file.truncated) {
    return (
      <>
        <p className="inspector-quiet">{`Only the start of ${name} is shown (${fileSize(file.size)} in all).`}</p>
        <pre className="file-text">{file.content}</pre>
      </>
    );
  }
  return (
    <Editor
      key={file.content}
      label={`${name} · ${fileSize(file.size)}`}
      value={file.content}
      save={(content) => api.putFile(agent.id, file.path, { content, encoding: "utf-8" })}
      saved={saved}
      mono
    />
  );
}
