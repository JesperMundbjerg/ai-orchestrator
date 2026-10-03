// A crew member's write surface: the path globs its brief says it may change. A first mate checks a
// commit against them before landing, so a file touched outside the brief is named instead of slipping in.

/** A file a diff changed: its path and git's status letter (A, M, D, R, C, T…). */
export interface ChangedFile {
  path: string;
  status: string;
}

/** The globs of a `--writes` value: comma-separated, blanks dropped; repeat the flag for more. */
export function parseWrites(values: string[]): string[] {
  return values.flatMap((v) => v.split(",")).map((g) => g.trim()).filter(Boolean);
}

/**
 * A glob as a regular expression over repository paths: `**` spans any number of folders (none
 * too), `*` and `?` stay within one path part, and a trailing `/` means everything below it.
 */
export function globPattern(glob: string): RegExp {
  const g = glob.replace(/^\.\//, "").replace(/\/$/, "/**");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      const before = i === 0 || g[i - 1] === "/";
      const after = g[i + 2] === "/";
      if (before && after) { out += "(?:.*/)?"; i += 2; }
      else if (before && i + 2 === g.length && i > 0) { out = out.slice(0, -1) + "(?:/.*)?"; i += 1; }
      else { out += ".*"; i += 1; }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * The files `git diff --name-status -z -M` lists. A rename touches both paths (the old one is
 * deleted), so both are returned; a copy leaves its source alone, so only the copy is.
 */
export function changedFiles(nameStatusZ: string): ChangedFile[] {
  const parts = nameStatusZ.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const status = parts[i]!;
    const letter = status[0]!;
    if (letter === "R") {
      files.push({ path: parts[i + 1]!, status: "D" }, { path: parts[i + 2]!, status: "A" });
      i += 3;
    } else if (letter === "C") {
      files.push({ path: parts[i + 2]!, status: "A" });
      i += 3;
    } else {
      files.push({ path: parts[i + 1]!, status: letter });
      i += 2;
    }
  }
  return files;
}

/** The changed files no glob of the write surface covers, in diff order. */
export function strayFiles(files: ChangedFile[], globs: string[]): ChangedFile[] {
  const patterns = globs.map(globPattern);
  return files.filter((f) => !patterns.some((p) => p.test(f.path)));
}
