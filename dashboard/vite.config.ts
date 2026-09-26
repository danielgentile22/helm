import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const API = "http://127.0.0.1:8642";

export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: { $lib: new URL("./src/lib", import.meta.url).pathname } },
  server: { proxy: { "/api": API } },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // The worker has to land at the root under a stable name, because its scope is the
      // directory it is served from and a hashed name would leave the old one registered.
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        sw: new URL("./src/sw.ts", import.meta.url).pathname,
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
