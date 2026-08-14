import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Tauri's devUrl must stay in sync with the Vite server. `strictPort`
  // prevents Vite from silently choosing another port and breaking the
  // native window's development connection.
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/.worktrees/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    globals: true,
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
