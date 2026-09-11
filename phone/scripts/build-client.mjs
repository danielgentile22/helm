// Bundle the PWA into public/. Two entry points: the app and the service worker.
import { build } from "esbuild";

const common = { bundle: true, format: "esm", target: ["es2022", "safari16"], sourcemap: true, logLevel: "info" };
await build({ ...common, entryPoints: ["src/client/app.ts"], outfile: "public/app.js" });
await build({ ...common, entryPoints: ["src/client/sw.ts"], outfile: "public/sw.js" });
