// File-system helpers shared by the check tools.

import { readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".tools"]);

/** Every file below root as a forward-slash relative path (actual on-disk case). */
export function listFiles(root: string, skipDirs: ReadonlySet<string> = SKIP_DIRS): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(join(dir, e.name), r);
      } else out.push(r);
    }
  };
  walk(root, "");
  return out.sort();
}

/** Normalise a WoW/Windows-style path: "\" -> "/", resolve "." and "..". Returns null if it escapes the root. */
export function normalizePath(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Convert a glob to a RegExp over forward-slash paths.
 * Supports "**" (any number of segments), "*" (within a segment), "?" and {a,b}.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) throw new Error(`unclosed { in glob ${glob}`);
      re += "(?:" + glob.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")";
      i = end;
    } else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
