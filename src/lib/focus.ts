interface FocusLayer {
  element: HTMLElement;
  modal: () => boolean;
}

const layers: FocusLayer[] = [];
let order = 100;

const targets = (element: HTMLElement) => Array.from(element.querySelectorAll<HTMLElement>(
  'button, input, textarea, select, a[href], summary, [tabindex]:not([tabindex="-1"])',
)).filter(node => !node.matches(':disabled, [tabindex="-1"]') && !node.closest('[inert]') && node.getClientRects().length > 0);

// Shared by dialogs and the narrow inline drawer: only the top layer owns keys.
export function attachFocusLayer(element: HTMLElement, onClose: () => void, modal = () => true, backdrop?: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null;
  const layer = { element, modal };
  layers.push(layer);
  if (backdrop) backdrop.style.zIndex = String(++order);
  const focusFirst = () => (targets(element)[0] || element).focus();
  if (modal()) focusFirst();
  const keydown = (event: KeyboardEvent) => {
    if (layers.at(-1) !== layer || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if (event.key === "Tab" && modal()) {
      const items = targets(element), first = items[0], last = items.at(-1);
      if (!items.length || !element.contains(document.activeElement)) { event.preventDefault(); focusFirst(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const focusin = (event: FocusEvent) => {
    if (layers.at(-1) === layer && modal() && !element.contains(event.target as Node)) focusFirst();
  };
  window.addEventListener("keydown", keydown);
  window.addEventListener("focusin", focusin);
  return () => {
    const wasTop = layers.at(-1) === layer;
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    window.removeEventListener("keydown", keydown);
    window.removeEventListener("focusin", focusin);
    if (!wasTop) return;
    const next = layers.at(-1);
    if (previous?.isConnected && previous.getClientRects().length && (!next?.modal() || next.element.contains(previous))) previous.focus();
    else if (next) (targets(next.element)[0] || next.element).focus();
  };
}
