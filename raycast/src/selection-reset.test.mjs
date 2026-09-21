import test from "node:test";
import assert from "node:assert/strict";
import { scheduleSelectionReset } from "./selection-reset.mjs";

test("new results select the first row after native updates settle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selected = [];
  const reset = scheduleSelectionReset("first", (id) => selected.push(id));
  reset.observe(null);
  reset.observe("first");
  t.mock.timers.tick(99);
  assert.deepEqual(selected, []);
  t.mock.timers.tick(1);
  assert.deepEqual(selected, ["first"]);
});

test("navigation during the settling window wins over the pending reset", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selected = [];
  const reset = scheduleSelectionReset("first", (id) => selected.push(id));
  t.mock.timers.tick(50);
  reset.observe("second");
  t.mock.timers.tick(100);
  assert.deepEqual(selected, []);
});

test("cancelled or replaced searches and refinement cannot apply an old reset", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selected = [];
  const old = scheduleSelectionReset("old", (id) => selected.push(id));
  old.cancel();
  scheduleSelectionReset("new", (id) => selected.push(id));
  t.mock.timers.tick(100);
  assert.deepEqual(selected, ["new"]);
});

test("the same top result can be selected again, and empty results do not select", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selected = [];
  for (const first of ["first", "first", undefined]) {
    scheduleSelectionReset(first, (id) => selected.push(id));
    t.mock.timers.tick(100);
  }
  assert.deepEqual(selected, ["first", "first"]);
});
