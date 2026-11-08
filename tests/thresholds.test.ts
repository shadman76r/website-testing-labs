import test from "node:test";
import assert from "node:assert/strict";
import { statusForThreshold, summarize } from "../src/lib/labs/shared";

test("lower-is-better thresholds distinguish pass, warning and fail", () => {
  assert.equal(statusForThreshold(700, 800, 1800), "PASS");
  assert.equal(statusForThreshold(1200, 800, 1800), "WARNING");
  assert.equal(statusForThreshold(2200, 800, 1800), "FAIL");
});

test("unavailable metrics are not checked, not failed", () => {
  assert.equal(statusForThreshold(Number.NaN, 800, 1800), "NOT_CHECKED");
});

test("result summary counts each result status accurately", () => {
  const summary = summarize([
    { id:"a",name:"A",status:"PASS",severity:"low",expected:"",actual:"" },
    { id:"b",name:"B",status:"FAIL",severity:"high",expected:"",actual:"" },
    { id:"c",name:"C",status:"WARNING",severity:"medium",expected:"",actual:"" },
    { id:"d",name:"D",status:"NOT_CHECKED",severity:"info",expected:"",actual:"" },
  ]);
  assert.deepEqual(summary, { total:4, passed:1, failed:1, warnings:1, notChecked:1 });
});
