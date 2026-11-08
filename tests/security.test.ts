import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, normalizeUrlForComparison } from "../src/lib/security/url";

test("rejects localhost and loopback targets", async () => {
  await assert.rejects(() => assertPublicHttpUrl("http://localhost"));
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1"));
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]"));
});

test("rejects unsupported protocols and non-standard ports", async () => {
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"));
  await assert.rejects(() => assertPublicHttpUrl("http://example.com:3000"));
});

test("rejects embedded credentials", async () => {
  await assert.rejects(() => assertPublicHttpUrl("https://user:pass@example.com"));
});

test("normalizes default URL comparison details", () => {
  assert.equal(
    normalizeUrlForComparison("https://Example.com/contact/?campaign=x#section"),
    "https://example.com/contact?campaign=x"
  );
});
