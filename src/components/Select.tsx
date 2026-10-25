import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";

// A real select owns form values/change events; the visible list keeps keyboard
// focus on its trigger, including inside the application's modal focus layers.
export function Select({ children, className = "", style, id, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const generated = useId(), listId = `${generated}-options`;
  const native = useRef<HTMLSelectElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 200, maxHeight: 280 });
  const [options, setOptions] = useState<Array<{value: string; label: string; disabled: boolean}>>([]);
  const [label, setLabel] = useState("选择选项");
  const typed = useRef({ text: "", at: 0 });
  useLayoutEffect(() => {
    const element = native.current;
    if (!element) return;
    setOptions(Array.from(element.options, option => ({ value: option.value, label: option.label, disabled: option.disabled || !!option.closest("optgroup:disabled") })));
    const parentLabel = element.closest("label");
    const text = Array.from(parentLabel?.childNodes || []).filter(node => node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && !node.contains(element))).map(node => node.textContent).join(" ");
    setLabel(props["aria-label"] || text?.trim() || props.title || "选择选项");
  }, [children, props["aria-label"], props.title]);
  const selected = options.findIndex(option => option.value === String(props.value ?? native.current?.value ?? ""));
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const close = () => setOpen(false);
  const choose = (index: number) => {
    const element = native.current, option = options[index];
    if (!element || !option || option.disabled || props.disabled) return;
    // React receives the actual native select event, preserving existing handlers.
    element.value = option.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    close(); trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || !rect.width || props.disabled) { close(); return; }
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      const height = Math.min(300, Math.max(below, above));
      const useAbove = below < Math.min(220, options.length * 40 + 12) && above > below;
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth-width-12)), top: useAbove ? Math.max(12, rect.top-height-5) : rect.bottom+5, width, maxHeight: Math.max(80, useAbove ? height : Math.min(300, below)) });
    };
    const dismiss = (event: Event) => { if (!trigger.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) close(); };
    const visibility = () => { if (document.hidden) close(); };
    const scroll = (event: Event) => { if (!list.current?.contains(event.target as Node)) close(); };
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => !entry.isIntersecting)) close(); });
    if (trigger.current) observer.observe(trigger.current);
    place(); window.addEventListener("resize", place); document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", scroll, true); window.addEventListener("blur", close); document.addEventListener("visibilitychange", visibility);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("scroll", scroll, true); window.removeEventListener("blur", close); document.removeEventListener("visibilitychange", visibility); };
  }, [open, props.disabled, options.length]);
  useEffect(() => { if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  return <span className="select-control" style={style}>
    <select {...props} id={undefined} ref={native} hidden aria-hidden="true" tabIndex={-1}>{children}</select>
    <button id={id || generated} type="button" ref={trigger} className={`select-trigger ${className}`} disabled={props.disabled} role="combobox" aria-label={label}
      aria-expanded={open} aria-controls={open ? listId : undefined} aria-haspopup="listbox" aria-required={props.required} aria-invalid={props["aria-invalid"]}
      aria-activedescendant={open && enabled.includes(active) ? `${listId}-${active}` : undefined} title={props.title || options[selected]?.label}
      onClick={event => { event.preventDefault(); setActive(selected >= 0 ? selected : enabled[0] ?? 0); setOpen(value => !value); }} onBlur={close}
      onKeyDown={event => {
        if (event.isPropagationStopped() || event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(); return; }
        const index = open ? active : selected;
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); setOpen(true);
          const at = enabled.indexOf(index);
          const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) : enabled[Math.max(0, Math.min(enabled.length-1, at+(event.key === "ArrowDown" ? 1 : -1)))];
          if (next !== undefined) setActive(next);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); event.stopPropagation(); if (open) choose(active); else { setActive(selected >= 0 ? selected : enabled[0] ?? 0); setOpen(true); }
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          typed.current = {text: (Date.now()-typed.current.at > 700 ? "" : typed.current.text)+event.key.toLocaleLowerCase(), at: Date.now()};
          const found = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(typed.current.text));
          if (found >= 0) { event.preventDefault(); setActive(found); setOpen(true); }
        }
      }}><span>{options[selected]?.label || (options.length ? "请选择" : "暂无可选项")}</span><ChevronDown size={14} aria-hidden="true" /></button>
    {open && createPortal(<div id={listId} ref={list} role="listbox" aria-label={label} className="select-menu" style={position} onMouseDown={event => event.preventDefault()}>
      {!options.length && <div className="select-empty">暂无可选项</div>}
      {options.map((option, index) => <div key={`${index}:${option.value}`} id={`${listId}-${index}`} data-index={index} role="option" aria-selected={index === selected} aria-disabled={option.disabled} className={`select-option ${index === active ? "highlighted" : ""}`}
        onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={event => { event.preventDefault(); event.stopPropagation(); choose(index); }}>
        <span>{option.label}</span>{index === selected && <Check size={14} aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </span>;
}
