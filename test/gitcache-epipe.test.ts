import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRunner } from "../src/server/gitcache.ts";

// A git read that takes no input exits before anyone writes to its stdin. That write fails with EPIPE, which
// must never fail the read or crash the office (an unhandled 'error' event on the pipe did both).
test("a git that exits before its stdin is written does not fail the read", async () => {
  // `git --version` never reads its input, so a large input is still being written when it has exited.
  const input = "x".repeat(4 * 1024 * 1024);
  const reads = await Promise.all(Array.from({ length: 20 }, () => defaultRunner({ cwd: process.cwd(), args: ["--version"], input })));
  for (const out of reads) assert.match(out, /^git version /);
});

test("a git that fails still says so", async () => {
  await assert.rejects(defaultRunner({ cwd: process.cwd(), args: ["no-such-command-xyz"] }), /no-such-command-xyz/);
});
