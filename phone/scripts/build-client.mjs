// Bundle the PWA into public/. Two entry points: the app (an ES module) and the
// service worker, which must be a classic script: register("/sw.js") without
// {type: "module"} rejects any file containing import or export statements.
import { build } from "esbuild";
import sveltePlugin from "esbuild-svelte";

const out = process.env.HELM_CLIENT_OUT ?? "public";
const common = { bundle: true, target: ["es2022", "safari16"], sourcemap: true, logLevel: "info" };
// css: "external" keeps component styles out of the JS; public/app.css stays the only stylesheet.
await build({ ...common, format: "esm", entryPoints: ["src/client/main.ts"], outfile: `${out}/app.js`, plugins: [sveltePlugin({ compilerOptions: { css: "external" } })] });
await build({ ...common, format: "iife", entryPoints: ["src/client/sw.ts"], outfile: `${out}/sw.js` });
