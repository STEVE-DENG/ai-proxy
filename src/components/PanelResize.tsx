import { useLayoutEffect, useRef, useState } from "react";

export function PanelResize({ name, variable, initial, reverse = false }: { name: string; variable: string; initial: number; reverse?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `ai-proxy-panel:${variable}`;
  const [value, setValue] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return saved >= 12 && saved <= 55 ? saved : initial;
  });
  const apply = (next: number) => setValue(Math.min(55, Math.max(12, next)));
  useLayoutEffect(() => {
    const container = ref.current?.parentElement?.parentElement;
    container?.style.setProperty(variable, `${value}%`);
    localStorage.setItem(key, String(value));
  }, [value, variable, key]);
  return <div ref={ref} className={`panel-resize ${reverse ? "reverse" : ""}`} role="separator" aria-label={name} aria-orientation="vertical" aria-valuenow={Math.round(value)} aria-valuemin={12} aria-valuemax={55} tabIndex={0}
    onDoubleClick={() => apply(initial)}
    onKeyDown={event => {
      if (event.key === "Home") { event.preventDefault(); apply(initial); }
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); apply(value + (event.key === "ArrowRight" ? 2 : -2) * (reverse ? -1 : 1)); }
    }}
    onPointerDown={event => { if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); } }}
    onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const rect = ref.current?.parentElement?.parentElement?.getBoundingClientRect();
      if (rect) apply((reverse ? rect.right - event.clientX : event.clientX - rect.left) / rect.width * 100);
    }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} title="拖动调整面板；方向键微调，Home 或双击恢复默认" />;
}
