import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const API = "http://127.0.0.1:8642";

export default defineConfig({
  plugins: [svelte()],
  server: { proxy: { "/api": API } },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
