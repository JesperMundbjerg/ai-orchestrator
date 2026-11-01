import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const ui = (path: string) => fileURLToPath(new URL(`src/ui/${path}`, import.meta.url));

const service = `http://127.0.0.1:${process.env.INBOX_PORT ?? 4870}`;

// In development Vite serves the UI and forwards the API; the service refuses other origins,
// so the proxy presents itself as the service's own origin.
const proxy = {
  target: service,
  changeOrigin: true,
  configure: (p: { on(event: "proxyReq", fn: (req: { setHeader(k: string, v: string): void }) => void): void }) =>
    p.on("proxyReq", (req) => req.setHeader("origin", service.replace("127.0.0.1", "localhost"))),
};

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  // The office view carries three.js in its own lazily loaded chunk of about 1 MB.
  // The page-comment widget is its own small entry (embed/comment.html), and its loader a plain script at a fixed name.
  build: {
    outDir: "../../dist", emptyOutDir: true, chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: { main: ui("index.html"), comment: ui("embed/comment.html"), loader: ui("embed/loader.ts") },
      output: { entryFileNames: (chunk) => (chunk.name === "loader" ? "embed/loader.js" : "assets/[name]-[hash].js") },
    },
  },
  server: { port: 4871, proxy: { "/api": proxy, "/files": proxy, "/uploads": proxy } },
});
