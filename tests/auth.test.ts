import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, verifySessionToken } from "../src/lib/auth";

test("session token validates only inside its lifetime", () => {
  const now = 1_800_000_000;
  const token = createSessionToken(now);
  assert.equal(verifySessionToken(token, now + 10), true);
  assert.equal(verifySessionToken(token, now + 60 * 60 * 13), false);
  assert.equal(verifySessionToken(`${token}x`, now + 10), false);
});
