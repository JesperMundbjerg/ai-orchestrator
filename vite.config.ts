import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  build: { outDir: "../../dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { port: 4871, proxy: { "/api": proxy, "/files": proxy, "/uploads": proxy } },
});
