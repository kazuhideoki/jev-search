import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function assertUnusedRun(out) {
  for (const name of ["run-started.json", "requests.jsonl", "results.jsonl", "results.json"]) {
    const exists = await stat(path.join(out, name)).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) throw Error("Run already started; use a new output directory for an intentional repeat");
  }
}

export async function reserveRun(out) {
  await assertUnusedRun(out);
  await writeFile(path.join(out, "run-started.json"), JSON.stringify({ startedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
}
