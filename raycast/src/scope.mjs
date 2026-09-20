import { readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { allowed, stream } from "./engine.mjs";

/** Build a local-only allowlist. src uses Git's tracked index, not all repo files. */
export async function personalScope(
  home,
  signal,
  { rgPath = "/opt/homebrew/bin/rg" } = {},
) {
  home = await realpath(home);
  const files = new Set(),
    roots = new Set(),
    gitFiles = [],
    errors = [],
    groups = {};
  const add = (absolute, group) => {
    const relative = path.relative(home, absolute);
    if (!allowed(relative) || signal.aborted) return;
    if (group !== "git-tracked" && (relative === "src" || relative.startsWith("src" + path.sep))) return;
    if (!files.has(relative)) {
      files.add(relative);
      groups[group] = (groups[group] || 0) + 1;
    }
  };
  const exists = async (p) => {
    try {
      return await lstat(p);
    } catch (e) {
      if (e.code !== "ENOENT")
        errors.push(`${path.relative(home, p)}: ${e.code}`);
      return null;
    }
  };
  const repositories = [];
  const list = async (directory, options) => {
    try { return await readdir(directory, options); }
    catch (e) {
      if (e.code !== "ENOENT") errors.push(`${path.relative(home, directory)}: ${e.code}`);
      return [];
    }
  };
  async function discover(directory) {
    if (signal.aborted) return;
    if (await exists(path.join(directory, ".git"))) {
      repositories.push(directory);
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (e) {
      errors.push(`${path.relative(home, directory)}: ${e.code}`);
      return;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !["node_modules", "vendor", "build", "dist"].includes(entry.name)
      )
        await discover(path.join(directory, entry.name));
  }
  const src = path.join(home, "src");
  if ((await exists(src))?.isDirectory()) await discover(src);
  if (repositories.length) roots.add(src);
  let index = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (index < repositories.length && !signal.aborted) {
        const repo = repositories[index++];
        try {
          await stream(
            "/usr/bin/git",
            ["ls-files", "--cached", "-z"],
            repo,
            signal,
            (p) => gitFiles.push(path.join(repo, p)),
          );
        } catch (e) {
          errors.push(`git: ${path.relative(home, repo)}: ${e.message}`);
        }
      }
    }),
  );
  for (const file of gitFiles) {
    if (signal.aborted) break;
    const stat = await exists(file);
    if (
      stat?.isFile() &&
      !stat.isSymbolicLink() &&
      (await realpath(file)) === file
    )
      add(file, "git-tracked");
  }
  const folders = [
    [path.join(home, "Downloads"), "downloads"],
    [path.join(home, "マイドライブ"), "my-drive"],
  ];
  const storage = path.join(home, "Library/CloudStorage");
  for (const entry of await list(storage, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.startsWith("GoogleDrive-")) {
      const base = path.join(storage, entry.name);
      for (const child of await list(base))
        if (["マイドライブ", "My Drive"].includes(child.normalize("NFC")))
          folders.push([path.join(base, child), "google-drive"]);
    }
  const mobile = path.join(home, "Library/Mobile Documents");
  for (const entry of await list(mobile, { withFileTypes: true }))
    if (entry.isDirectory())
      folders.push([
        path.join(
          mobile,
          entry.name,
          ...(entry.name === "com~apple~CloudDocs" ? [] : ["Documents"]),
        ),
        "icloud",
      ]);
  for (const [folder, group] of folders) {
    if (signal.aborted) break;
    const stat = await exists(folder);
    if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) continue;
    const canonical = await realpath(folder);
    const fromSrc = path.relative(src, canonical);
    if (
      canonical === home || path.relative(home, canonical).startsWith("..") ||
      // A document-root alias must not bypass the Git-only boundary under src.
      fromSrc === "" || (!path.isAbsolute(fromSrc) && fromSrc !== ".." && !fromSrc.startsWith(".." + path.sep)) ||
      [...roots].some((r) => r.normalize("NFC") === canonical.normalize("NFC"))
    )
      continue;
    roots.add(canonical);
    try {
      await stream(
        rgPath,
        [
          "--no-config",
          "--files",
          "--null",
          "--no-hidden",
          "--no-follow",
          "--no-require-git",
          "--glob",
          "!**/node_modules/**",
          "--glob",
          "!**/vendor/**",
          "--glob",
          "!**/dist/**",
          "--glob",
          "!**/build/**",
          "--glob",
          "!.env*",
        ],
        canonical,
        signal,
        (p) => add(path.join(canonical, p), group),
      );
    } catch (e) {
      errors.push(`${group}: ${e.message}`);
    }
  }
  const directories = roots.size;
  const spotlightRoots = [...roots].filter(
    (r) => !r.startsWith(mobile + path.sep),
  );
  if ([...roots].some((r) => r.startsWith(mobile + path.sep)))
    spotlightRoots.push(mobile);
  return {
    files,
    roots: spotlightRoots,
    directories,
    groups,
    repositories: repositories.length,
    errors,
    incomplete: signal.aborted,
  };
}
