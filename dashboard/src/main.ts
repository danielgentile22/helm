import { mount } from "svelte";
import App from "./App.svelte";
import Desk from "./desk/Desk.svelte";
import { registerWorker } from "./lib/push";

const target = document.getElementById("app");
if (target === null) throw new Error("helm dashboard: no #app element to mount into");

/** `/desk` is its own home screen app: its own manifest, so Add to Home Screen from there
 *  opens straight into it, always dark, and no tab bar. */
function becomeDesk(): void {
  document.documentElement.classList.add("desk-page");
  document.title = "helm desk";
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", "/desk.webmanifest");
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", "desk");
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", "#000000");
}

if (location.pathname.replace(/\/+$/, "") === "/desk") {
  becomeDesk();
  mount(Desk, { target });
} else {
  mount(App, { target });
}

registerWorker();
