import "@fontsource-variable/manrope";
import "@fontsource-variable/newsreader";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, setDensity, setTextScale, textScale } from "./lib/display";

applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
setTextScale(textScale());
setDensity(localStorage.getItem("ai-proxy-density") || "comfortable");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
