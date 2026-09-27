// The service and the Vite UI together: http://127.0.0.1:4871 (the UI proxies /api to the service).

import { spawn, type ChildProcess } from "node:child_process";

const children: ChildProcess[] = [
  spawn(process.execPath, ["--watch", "src/server/main.ts"], { stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => code && stop());
