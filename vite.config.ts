import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const petHtmlPath = fileURLToPath(new URL("./pet.html", import.meta.url));
const PET_PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self' ipc: http://ipc.localhost",
  "img-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'none'",
  "worker-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "manifest-src 'none'",
].join("; ");

const petProductionCspPlugin = {
  name: "pet-production-csp",
  apply: "build",
  transformIndexHtml: {
    order: "pre",
    handler(_html, context) {
      if (
        normalize(context.filename).toLowerCase() !==
        normalize(petHtmlPath).toLowerCase()
      ) {
        return;
      }

      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: PET_PRODUCTION_CSP,
          },
          injectTo: "head-prepend",
        },
      ];
    },
  },
} satisfies Plugin;
// 注入 package.json 版本号到前端代码（设置面板 / 自动更新弹窗用）。
// vite 不会自动暴露 npm_package_version，要 build-time 读取再 define。
const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [petProductionCspPlugin, react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        pet: petHtmlPath,
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
