// read-savedvars: turn a WoW SavedVariables file into JSON (see parse.ts for
// the value mapping). Used to read /wf selftest results, later /wf dump and
// the field log, after Don reloads the game.
//
//   npm run savedvars -- <file.lua>                     print every variable as JSON
//   npm run savedvars -- <file.lua> --var WayfinderData print one variable
//   npm run savedvars -- <file.lua> --json out.json     write JSON to a file
//   npm run savedvars -- --latest <dir> [--var ...] [--json ...]
//        <dir> is the account SavedVariables folder (or the account folder
//        that contains it); picks the newer of Wayfinder.lua and
//        Wayfinder.lua.bak there and says which on stderr.
//
// Exit codes: 0 ok, 1 parse/IO error or unknown variable, 2 usage.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSavedVariables, toJsonText } from "./parse.ts";

export const ADDON_FILE = "Wayfinder.lua";

/** The Wayfinder SavedVariables file in an account SavedVariables folder, or undefined. */
export function pickLatest(dir: string): string | undefined {
  const folders = [dir, join(dir, "SavedVariables")];
  for (const folder of folders) {
    const candidates = [join(folder, ADDON_FILE), join(folder, `${ADDON_FILE}.bak`)]
      .filter((p) => existsSync(p) && statSync(p).isFile())
      .map((p) => ({ p, t: statSync(p).mtimeMs }));
    if (!candidates.length) continue;
    // Newest wins; on a tie the live file (listed first) wins.
    candidates.sort((a, b) => b.t - a.t);
    return candidates[0]!.p;
  }
  return undefined;
}

export interface Args {
  file?: string;
  latest?: string;
  variable?: string;
  json?: string;
}

export function parseArgs(argv: string[]): Args | string {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--var") args.variable = next();
      else if (a === "--json") args.json = next();
      else if (a === "--latest") args.latest = next();
      else if (a.startsWith("--")) return `unknown option ${a}`;
      else if (args.file) return `more than one input file (${args.file}, ${a})`;
      else args.file = a;
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (!args.file && !args.latest) return "give a SavedVariables file or --latest <dir>";
  if (args.file && args.latest) return "give either a file or --latest <dir>, not both";
  return args;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(`read-savedvars: ${args}`);
    console.error("usage: npm run savedvars -- <file.lua> | --latest <dir>  [--var Name] [--json out.json]");
    return 2;
  }
  let file = args.file;
  if (args.latest) {
    file = pickLatest(args.latest);
    if (!file) {
      console.error(`read-savedvars: no ${ADDON_FILE} in ${args.latest} or its SavedVariables folder`);
      return 1;
    }
    console.error(`read-savedvars: reading ${file}`);
  }
  const vars = parseSavedVariables(readFileSync(file!, "utf8"));
  let out: unknown = vars;
  if (args.variable) {
    if (!(args.variable in vars)) {
      console.error(`read-savedvars: no variable ${args.variable} (found: ${Object.keys(vars).join(", ") || "none"})`);
      return 1;
    }
    out = vars[args.variable];
  }
  const text = `${toJsonText(out)}\n`;
  if (args.json) {
    writeFileSync(args.json, text);
    console.error(`read-savedvars: wrote ${args.json}`);
  } else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`read-savedvars: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
