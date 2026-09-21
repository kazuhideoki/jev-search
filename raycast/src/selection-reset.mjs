/**
 * Give Raycast time to install new rows before requesting their first item.
 * Native updates are batched; this is a settling delay, not a readiness signal.
 * A user's intervening selection always takes precedence.
 * @param {string | undefined} firstId
 * @param {(id: string) => void} select
 */
export function scheduleSelectionReset(firstId, select) {
  let pending = firstId !== undefined;
  const timer = pending ? setTimeout(() => {
    if (!pending) return;
    pending = false;
    select(firstId);
  }, 100) : undefined;
  const cancel = () => { pending = false; clearTimeout(timer); };
  return {
    cancel,
    /** @param {string | null} id */
    observe(id) {
      // Empty/initial selection notifications are part of installing the rows.
      if (id !== null && id !== firstId) cancel();
    },
  };
}
