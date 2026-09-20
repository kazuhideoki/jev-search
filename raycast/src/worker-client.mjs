import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export async function resolveNode(custom) {
  const candidates = custom ? [custom] : [
    ...(path.basename(process.execPath) === "node" ? [process.execPath] : []),
    "/opt/homebrew/bin/node", "/usr/local/bin/node", path.join(homedir(), ".local/share/mise/shims/node"),
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  throw Error("Node.jsが見つかりません。拡張設定のNode.js Pathに実行ファイルを指定してください。");
}

/** The Raycast process receives only at most 100 results, never the full index. */
export async function startLocalWorker({ script, root, cachePath, rgPath, nodePath, onEvent }) {
  const executable = await resolveNode(nodePath);
  console.info(`[Jev Search] local worker runtime: ${executable}`);
  const child = spawn(executable, ["--max-old-space-size=512", script, root, cachePath, rgPath], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let tail = "", diagnostic = "", disposed = false;
  const notify = (event) => { if (!disposed) onEvent(event); };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    tail += chunk;
    if (tail.length > 2 * 1024 * 1024) { tail = ""; child.kill(); notify({ event: "error", operation: "index", message: "検索プロセスの応答が大きすぎます" }); return; }
    const lines = tail.split("\n"); tail = lines.pop();
    for (const line of lines) if (line) {
      try { notify(JSON.parse(line)); } catch { notify({ event: "error", operation: "index", message: "検索プロセスの応答が不正です" }); }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-2000); });
  child.on("error", () => notify({ event: "error", operation: "index", message: "検索プロセスを起動できませんでした。Node.js Pathを確認してください。" }));
  child.on("exit", (code, signal) => {
    if (!disposed) {
      console.error(`[Jev Search] worker exited: ${code ?? signal}\n${diagnostic}`);
      notify({ event: "error", operation: "index", message: `検索プロセスが終了しました (${code ?? signal})。コマンドを開き直してください。` });
    }
  });
  child.stdin.on("error", () => {});
  const exited = new Promise((resolve) => child.once("close", resolve));
  return {
    exited,
    send(request) {
      if (disposed || !child.stdin.writable || child.exitCode !== null || child.signalCode !== null) return false;
      child.stdin.write(JSON.stringify(request) + "\n");
      return true;
    },
    dispose() { if (disposed) return; disposed = true; child.stdin.end(); child.kill("SIGTERM"); },
  };
}
