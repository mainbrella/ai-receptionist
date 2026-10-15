import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: { input: { app: resolve("index.html"), login: resolve("login.html") } },
  },
});
