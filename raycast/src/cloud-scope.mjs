import path from "node:path";
import { stream } from "./engine.mjs";

// One cache per refinement, never across explicit user actions: the Git index
// may have changed since the search index (or the twenty-file stage) was built.
export function currentCloudScope(root, signal) {
  const directories = new Map();
  return async (relative) => {
    if (!relative.startsWith(`src${path.sep}`)) return true;
    const directory = path.dirname(path.join(root, relative));
    if (!directories.has(directory)) directories.set(directory, (async () => {
      const tracked = new Set();
      try {
        await stream("/usr/bin/git", ["ls-files", "--cached", "-z"], directory, signal, name => tracked.add(name));
        signal.throwIfAborted();
        return tracked;
      } catch { signal.throwIfAborted(); return new Set(); }
    })());
    return (await directories.get(directory)).has(path.basename(relative));
  };
}
