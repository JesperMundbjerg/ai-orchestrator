import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSettings, envFromPs, isOffice, parseEnvFile } from "../scripts/restart-office.ts";

test("office.env is KEY=VALUE lines; comments, export and quotes are allowed", () => {
  const vars = parseEnvFile(`# herdr for the live office
export HERDR_BIN_PATH=/opt/homebrew/bin/herdr

HERDR_SOCKET_PATH="/Users/me/.config/herdr/sessions/a b/herdr.sock"
not a line
=nokey
`);
  assert.deepEqual(vars, { HERDR_BIN_PATH: "/opt/homebrew/bin/herdr", HERDR_SOCKET_PATH: "/Users/me/.config/herdr/sessions/a b/herdr.sock" });
});

test("each herdr setting comes from the environment, else office.env, else the running office", () => {
  const running = envFromPs("node src/server/main.ts TERM=xterm HERDR_BIN_PATH=/run/herdr HERDR_SOCKET_PATH=/run/herdr.sock PWD=/x", ["HERDR_BIN_PATH", "HERDR_SOCKET_PATH"]);
  assert.deepEqual(running, { HERDR_BIN_PATH: "/run/herdr", HERDR_SOCKET_PATH: "/run/herdr.sock" });
  assert.deepEqual(chooseSettings({ env: { HERDR_BIN_PATH: "/env/herdr" }, file: { HERDR_BIN_PATH: "/file/herdr", HERDR_SOCKET_PATH: "/file.sock" }, running }), {
    settings: { HERDR_BIN_PATH: "/env/herdr", HERDR_SOCKET_PATH: "/file.sock" },
    missing: [],
  });
  assert.deepEqual(chooseSettings({ env: {}, file: {}, running }).settings, running);
});

test("a setting nobody has is named, rather than guessed", () => {
  const { missing } = chooseSettings({ env: { HERDR_BIN_PATH: "" }, file: { HERDR_SOCKET_PATH: "/s.sock" }, running: {} });
  assert.deepEqual(missing, ["HERDR_BIN_PATH"]);
});

test("only node running src/server/main.ts is taken for the office", () => {
  assert.equal(isOffice("node src/server/main.ts"), true);
  assert.equal(isOffice("/opt/homebrew/bin/node --watch /Users/me/review-inbox/src/server/main.ts"), true);
  assert.equal(isOffice("node node_modules/vite/bin/vite.js"), false);
  assert.equal(isOffice("python3 -m http.server 4870"), false);
  assert.equal(isOffice("node src/server/main.ts.bak"), false);
  assert.equal(isOffice(""), false);
});
