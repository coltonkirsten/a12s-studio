import type { WriteResult } from "@a12s-studio/contract/api";
import type { TeamView } from "@a12s-studio/contract/state";
import { useLayoutEffect, useRef, useState } from "react";
import { useAction } from "../api.ts";
import { addressee, insertMention, mentionAt } from "../logic/mention.ts";
import { displayName } from "../logic/names.ts";
import { Icon } from "./icons.tsx";
import { Dot } from "./presence.tsx";
import { Problem } from "./problem.tsx";

type Props = {
  team: TeamView;
  placeholder: string;
  /** `to` is the slug of the agent addressed with @, as the owner API takes it. */
  send: (body: string, to: string | undefined) => Promise<WriteResult>;
  sent?: (result: WriteResult) => void;
};

export function Composer({ team, placeholder, send, sent }: Props) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const placeCaret = useRef<number | null>(null);
  const action = useAction();

  const mention = mentionAt(text, caret);
  const choices = mention
    ? team.agents.filter(
        (a) => a.slug.startsWith(mention.query) || displayName(a.id).toLowerCase().startsWith(mention.query),
      )
    : [];
  const menu = mention && choices.length > 0 && dismissed !== mention.start ? mention : null;
  const toSlug = addressee(
    text,
    team.agents.map((a) => a.slug),
  );
  const to = team.agents.find((a) => a.slug === toSlug);

  // React resets the caret when it replaces the value; put it back after the mention before the next key arrives.
  useLayoutEffect(() => {
    if (placeCaret.current === null) return;
    field.current?.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  });

  function choose(slug: string): void {
    if (!mention) return;
    const next = insertMention(text, mention.start, caret, slug);
    setText(next.text);
    setCaret(next.caret);
    placeCaret.current = next.caret;
  }

  function submit(): void {
    const body = text.trim();
    if (!body || action.pending) return;
    action.run(
      () => send(body, to?.slug),
      (result) => {
        setText("");
        setCaret(0);
        sent?.(result);
      },
    );
  }

  return (
    <div className="composer">
      {menu && (
        <ul className="mention-menu">
          {choices.map((agent, i) => (
            <li key={agent.id}>
              <button
                type="button"
                className={i === pick % choices.length ? "mention-choice active" : "mention-choice"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(agent.slug);
                }}
              >
                <Dot presence={agent.presence} />
                <span className="mention-name">{displayName(agent.id)}</span>
                <span className="mention-role">{agent.roleLine}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {to && (
        <div className="composer-to">
          <span>To {displayName(to.id)}</span>
        </div>
      )}
      <div className={action.pending ? "composer-field pending" : "composer-field"}>
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={placeholder}
          readOnly={action.pending}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setPick(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (menu) {
              const chosen = choices[pick % choices.length];
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setPick((p) => p + (event.key === "ArrowDown" ? 1 : choices.length - 1));
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && chosen) {
                event.preventDefault();
                choose(chosen.slug);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(menu.start);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="send" title="Send" disabled={!text.trim() || action.pending} onClick={submit}>
          <Icon name="send" size={14} />
        </button>
      </div>
      <Problem problem={action.problem} />
    </div>
  );
}
