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

/** iOS opens a home screen app at the start URL of the manifest the page had when it was
 *  added, so the helm icon always opens `/`. A phone that last showed the desk goes back to
 *  it on a cold launch; leaving the desk (a long press) clears the choice. */
const DESK_KEY = "helm.desk";
const standalone =
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
function remembered(): boolean {
  try {
    return localStorage.getItem(DESK_KEY) === "1";
  } catch {
    return false;
  }
}

const path = location.pathname.replace(/\/+$/, "");
if (path === "" && standalone && remembered()) {
  location.replace("/desk");
} else if (path === "/desk") {
  try {
    localStorage.setItem(DESK_KEY, "1");
  } catch {
    // Private mode: the desk still works, it is just not reopened on a cold launch.
  }
  becomeDesk();
  mount(Desk, { target });
} else {
  mount(App, { target });
}

registerWorker();
