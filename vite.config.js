import { defineConfig } from "vite";

// Relative base so the build works wherever it is hosted.
export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: "127.0.0.1",
  },
});
