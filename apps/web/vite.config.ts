import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
