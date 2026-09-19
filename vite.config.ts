import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  base: "./",
  test: {
    // Only the extension's own tests. Without this the root runner also picks up
    // `server/tests/**`, which double-runs the backend suite and makes its HTTP
    // fixture fight over a fixed port.
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "server/**", "dist/**"]
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/popup.html"),
        content: resolve(__dirname, "src/content/content.ts"),
        background: resolve(__dirname, "src/background/background.ts")
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "content") {
            return "content.js";
          }
          if (chunkInfo.name === "background") {
            return "background.js";
          }
          return "assets/[name].js";
        },
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "hud.css") {
            return "hud.css";
          }
          return "assets/[name][extname]";
        }
      }
    }
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "src/manifest.json",
          dest: "."
        },
        {
          src: "src/content/hud.css",
          dest: "."
        },
        {
          src: "src/icons/*",
          dest: "icons"
        }
      ]
    })
  ]
});
