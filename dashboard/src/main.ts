import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");
if (target === null) throw new Error("helm dashboard: no #app element to mount into");

mount(App, { target });
