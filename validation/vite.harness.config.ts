import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

const repo = fileURLToPath(new URL("..", import.meta.url));
const harness = fileURLToPath(new URL("./fill-diagram/", import.meta.url));

/** Local-only page for ProcessDiagramWidget. Proxies /api to the synthetic server. */
export default defineConfig({
  root: harness,
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  plugins: [react(), tailwindcss(), tsconfigPaths({ projects: [fileURLToPath(new URL("../tsconfig.json", import.meta.url))] })],
  server: {
    host: "127.0.0.1",
    port: 5198,
    strictPort: true,
    fs: { allow: [repo] },
    proxy: {
      "/api": { target: "http://127.0.0.1:5197", changeOrigin: true },
    },
  },
});
