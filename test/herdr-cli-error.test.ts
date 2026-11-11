import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPane } from "../src/cli/pane.ts";

test("inbox pane reports how herdr failed, never the command line", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-cli-error-"));
  const saved = { bin: process.env.HERDR_BIN_PATH, pane: process.env.HERDR_PANE_ID };
  t.after(() => {
    for (const [key, value] of [["HERDR_BIN_PATH", saved.bin], ["HERDR_PANE_ID", saved.pane]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.HERDR_PANE_ID = "wX:p1";
  const cases: Array<{ script: string; expected: string }> = [
    { script: "exit 4", expected: "herdr pane layout exited with code 4 without saying why" },
    { script: `echo '{"error":{"message":"pane wX:p1 not found"}}'\nexit 1`, expected: "herdr: pane wX:p1 not found" },
    { script: "kill -KILL $$", expected: "herdr pane layout was ended by SIGKILL without saying why" },
  ];
  for (const [i, c] of cases.entries()) {
    const bin = join(dir, `herdr-${i}`);
    writeFileSync(bin, `#!/bin/sh\n${c.script}\n`);
    chmodSync(bin, 0o755);
    process.env.HERDR_BIN_PATH = bin;
    const secretDir = join(dir, "private project");
    await assert.rejects(openPane(secretDir), (err: Error) => {
      assert.equal(err.message, c.expected);
      assert.ok(!err.message.includes("Command failed") && !err.message.includes(bin) && !err.message.includes(secretDir));
      return true;
    });
  }
});
