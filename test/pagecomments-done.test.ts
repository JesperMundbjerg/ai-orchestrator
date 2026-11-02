import test from "node:test";
import assert from "node:assert/strict";
import { PAGE_COMMENT_STATUSES, isDoneComment, type CommentVerdict, type PageCommentStatus } from "../src/shared/pagecomments.ts";

const done = (status: PageCommentStatus, verification: CommentVerdict | null = null) => isDoneComment({ status, verification });

test("a comment someone still has to act on is not done", () => {
  for (const s of ["held", "queued", "delivered", "working", "asked", "failed"] as const) assert.equal(done(s), false, s);
});

test("a fixed comment waits for the founder's check", () => {
  assert.equal(done("fixed"), false);
});

test("either verdict finishes a fixed comment, since still-wrong carries on in a follow-up", () => {
  assert.equal(done("fixed", "verified"), true);
  assert.equal(done("fixed", "still-wrong"), true);
});

test("declined and withdrawn comments are done", () => {
  assert.equal(done("declined"), true);
  assert.equal(done("withdrawn"), true);
});

test("every status is classified", () => {
  for (const s of PAGE_COMMENT_STATUSES) assert.equal(typeof done(s), "boolean");
});
