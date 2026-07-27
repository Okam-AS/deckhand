import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The viewer is served by the deckhand server under /s/<shareId>. The real
// streaming client lands in Phase 1 (after the transport spike); this is the
// scaffold shell.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
