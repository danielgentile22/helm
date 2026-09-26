import "./styles/tokens.css";
import "./styles/shell.css";
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");
if (target === null) throw new Error("helm dashboard: no #app element to mount into");

mount(App, { target });

// Safari ignores the viewport meta's zoom lock in a browser tab, so the pinch gesture is
// refused here as well. Double-tap zoom is off through touch-action in shell.css.
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });

// Production only.
// `npm run dev` is not complicated by caching.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js", { type: "module" });
}
