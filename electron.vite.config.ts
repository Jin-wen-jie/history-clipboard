import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].js"
        }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
});
