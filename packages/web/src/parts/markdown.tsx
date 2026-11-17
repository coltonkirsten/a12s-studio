import { Markdown as Render } from "markdown-to-jsx/react";
import { markdownOptions, streamingOptions } from "../logic/markdown.ts";

/** An agent's words, drawn as markdown (build-spec 7.6). `streaming`: the text is still being written. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <Render options={streaming ? streamingOptions : markdownOptions}>{text}</Render>
    </div>
  );
}
