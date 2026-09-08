import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "map-v2"),
  base: "/map-v2/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "public/map-v2"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
