import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The viewer is served by the deckhand server under /s/<shareId>.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
