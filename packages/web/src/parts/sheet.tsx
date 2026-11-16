import { type ReactNode, useEffect, useRef } from "react";

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop">
      <button type="button" className="sheet-dismiss" aria-label="Close" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={title} ref={card}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
