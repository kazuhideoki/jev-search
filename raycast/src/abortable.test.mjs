import test from "node:test";
import assert from "node:assert/strict";
import { abortable } from "./abortable.mjs";

test("abort releases an operation that never completes", async () => {
  const controller = new AbortController();
  const pending = abortable(controller.signal, () => new Promise(() => {}));
  const rejected = assert.rejects(pending, /deadline/);
  await Promise.resolve();
  controller.abort(Error("deadline"));
  await rejected;
});

test("late rejection after cancellation is consumed; pre-aborted work never starts", async () => {
  const controller = new AbortController();
  let rejectOperation;
  const pending = abortable(controller.signal, () => new Promise((_resolve, reject) => { rejectOperation = reject; }));
  const rejected = assert.rejects(pending, /abort/i);
  await Promise.resolve();
  controller.abort();
  await rejected;
  rejectOperation(Error("late IO error"));
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => abortable(controller.signal, () => assert.fail("must not start")), /abort/i);
});
