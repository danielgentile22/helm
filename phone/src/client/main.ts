/**
 * The PWA. State is: the route, the signed-in label, the thread list, and for
 * an open thread the pure fold of its events plus the attach state. Everything
 * on screen is a function of that.
 */

import { mount } from "svelte";
import { HelmClient } from "./api";
import App from "./App.svelte";
import { LABEL } from "./label";
import { swRegistration } from "./push";

const api = new HelmClient({ baseUrl: "", label: LABEL });

void swRegistration().catch(() => null);

const target = document.getElementById("app")!;
target.replaceChildren();
mount(App, { target, props: { api } });

// Safari ignores the viewport meta's zoom lock in a browser tab, so the pinch gesture is
// refused here too. Double-tap zoom is off through touch-action in app.css.
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
