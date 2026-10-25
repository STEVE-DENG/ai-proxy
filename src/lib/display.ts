import { useEffect, useState } from "react";

export function textScale() {
  const value = Number(localStorage.getItem("ai-proxy-text-scale") || 1);
  return Number.isFinite(value) ? Math.min(2, Math.max(1, value)) : 1;
}

export function setTextScale(value: number) {
  const next = Math.min(2, Math.max(1, value));
  localStorage.setItem("ai-proxy-text-scale", String(next));
  document.documentElement.style.setProperty("--text-scale", String(next));
  window.dispatchEvent(new Event("ai-proxy-display"));
}

export function useRowHeight() {
  const measure = () => Math.round((localStorage.getItem("ai-proxy-density") === "compact" ? 30 : 38) * textScale());
  const [height, setHeight] = useState(measure);
  useEffect(() => {
    const update = () => setHeight(measure());
    window.addEventListener("ai-proxy-display", update);
    return () => window.removeEventListener("ai-proxy-display", update);
  }, []);
  return height;
}

export function setDensity(value: string) {
  localStorage.setItem("ai-proxy-density", value);
  document.documentElement.dataset.density = value;
  window.dispatchEvent(new Event("ai-proxy-display"));
}

export type Theme = "system" | "light" | "dark";
export function themePreference(): Theme {
  const value = localStorage.getItem("ai-proxy-theme");
  return value === "light" || value === "dark" ? value : "system";
}
export function setTheme(value: Theme) {
  localStorage.setItem("ai-proxy-theme", value);
  applyTheme();
  window.dispatchEvent(new Event("ai-proxy-display"));
}
export function applyTheme() {
  const preference = themePreference();
  const resolved = preference === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}
export function useTheme() {
  const [theme, update] = useState(themePreference);
  useEffect(() => {
    const refresh = () => update(themePreference());
    window.addEventListener("ai-proxy-display", refresh);
    return () => window.removeEventListener("ai-proxy-display", refresh);
  }, []);
  return { theme, setTheme };
}
