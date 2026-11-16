const PATHS = {
  tray: "M3 10.5 5 4.5h10l2 6v4.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 10.5h4.5a2.5 2.5 0 0 0 5 0H17",
  plus: "M10 4.5v11M4.5 10h11",
  compose: "M9 4.5H5.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11M8.5 11.5l.5-2.5 6-6 2 2-6 6z",
  chevron: "M8 5.5 12.5 10 8 14.5",
  back: "M12 4.5 6.5 10l5.5 5.5",
  more: "M5 10h.01M10 10h.01M15 10h.01",
  send: "M10 15.5v-11M5.5 9 10 4.5 14.5 9",
  close: "M6 6l8 8M14 6l-8 8",
  clip: "M13.5 7.5 8 13a2 2 0 0 1-3-3l6-6a3.2 3.2 0 0 1 4.5 4.5l-6 6",
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
