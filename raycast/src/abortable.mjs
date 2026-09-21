// Filesystem/provider operations may ignore AbortSignal. Stop awaiting them while
// retaining rejection handlers, so late completion cannot update the caller.
export function abortable(signal, operation) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
