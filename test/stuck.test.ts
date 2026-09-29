import assert from "node:assert/strict";
import { test } from "node:test";
import { whyStuck } from "../src/shared/stuck.ts";
import type { WorldAgent } from "../src/shared/types.ts";

const agent = (name: string, waitingOnYou: boolean) => ({ name, waitingOnYou }) as WorldAgent;

test("a blocked team says whether it waits for your answer or is stuck at a prompt", () => {
  assert.equal(whyStuck([agent("Tom", true)]), "Tom waits for your answer");
  assert.equal(whyStuck([agent("Tom", false)]), "Tom is stuck at a prompt");
  assert.equal(whyStuck([agent("Tom", true), agent("Ida", false), agent("Noah", false)]), "Tom waits for your answer; Ida and Noah are stuck at a prompt");
});
