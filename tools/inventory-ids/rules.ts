// Category and rule tables for the identifier inventory.
//
// Order matters: rules run in table order and the first rule to claim a span
// owns it (scan.ts). Specific rules (TOC, saved variables, slash commands,
// comms, registrations) come first; broad ones (branding strings, comments,
// identifier fallbacks) come last. Adding a classifier = adding a row here.

import { CODE, STRING, type Token } from "./lex.ts";
import { argId, type Rule, type RuleCtx } from "./scan.ts";

export interface Category {
  id: string;
  /** Display number (1-13 follow the P1 brief; 14+ were added for residue). */
  num: number;
  title: string;
  /** What it means for a side-by-side install. */
  note: string;
}

export const CATEGORIES: readonly Category[] = [
  { id: "toc", num: 1, title: "Addon/TOC identity", note: "TOC file names and metadata. Folder/TOC name decides the addon name the client and other addons see." },
  { id: "savedvars", num: 2, title: "SavedVariables", note: "Declared saved-variable names and every access. Same names = both addons share (and overwrite) one saved table." },
  { id: "globals", num: 3, title: "Global table exports and reads", note: "Globals the addon writes or reads (static approximation). Same global name = last loaded addon wins." },
  { id: "guide-coupling", num: 4, title: "Guide-file coupling", note: "Guide files reaching the engine through globals (e.g. RXPGuides.RegisterGuide). Drives whether upstream guide files can stay unmodified." },
  { id: "frames", num: 5, title: "Named frames and XML", note: "Frame/template/mixin names. Named frames are globals; duplicates collide." },
  { id: "slash", num: 6, title: "Slash commands", note: "Slash commands; duplicates: one addon's command shadows the other's." },
  { id: "bindings", num: 7, title: "Key bindings", note: "Bindings.xml entries and BINDING_* globals." },
  { id: "comms", num: 8, title: "Addon comms", note: "Addon-message prefixes and channels. Same prefix = each addon receives the other's messages." },
  { id: "ace", num: 9, title: "LibStub / Ace registrations", note: "Names registered in shared libraries (AceAddon, AceLocale, AceConfig, LDB, LibDBIcon, AceGUI widget types)." },
  { id: "addon-folder", num: 10, title: "Hard-coded addon folder/name", note: "Interface\\AddOns\\<folder> paths, addon-name API calls, companion addon names." },
  { id: "branding", num: 11, title: "User-visible branding strings", note: "RestedXP/RXP in user-facing text (code, locale files, guide group names)." },
  { id: "urls", num: 12, title: "URLs and commercial strings", note: "Links and shop/purchase-style words in string literals; candidates for the strip list." },
  { id: "unclassified", num: 13, title: "Catch-all (unclassified)", note: "Raw RXP/RestedXP occurrences no rule claimed. Target: zero." },
  { id: "registries", num: 14, title: "Shared runtime registries", note: "AceEvent message names (one CallbackHandler shared by every AceEvent user, also forwarded to WeakAuras/ForeverAuras), StaticPopupDialogs keys, UISpecialFrames." },
  { id: "guide-markup", num: 15, title: "Guide text markup and cross-references", note: "cRXP_* colour tokens inside guide text and colour-table keys; #include/#next/#groupid references. Internal to the guide parser; no collision." },
  { id: "files", num: 16, title: "File and asset names", note: "Source/texture file names containing rxp (RXPGuides.lua, rxp_logo-64). Folder-relative; no collision." },
  { id: "comments", num: 17, title: "Comments", note: "Occurrences inside Lua/XML/TOC comments. No runtime effect." },
  { id: "internal", num: 18, title: "Internal identifiers", note: "Locals, parameters, table keys and fields on addon-private tables whose names contain rxp. No collision." },
];

const STRING_LIT = String.raw`(["'])(?<id>[^"'\r\n]*)\1`;

/** Emit argument n of the call whose "(" ends the match. */
function emitArg(n: number, detail?: string) {
  return (m: RegExpExecArray, ctx: RuleCtx) => {
    const s = ctx.arg(m.index + m[0].length - 1, n);
    if (s && s.text !== "nil") ctx.emit(s.start, s.end, argId(s), detail);
  };
}

const isOp = (t: Token | undefined, v: string) => !!t && t.type === "op" && t.value === v;

/** Is token i a table-constructor key ({ name = ... })? */
function isTableKey(ctx: RuleCtx, i: number): boolean {
  const a = ctx.lua!;
  const t = a.tokens;
  return a.braceDepth[i]! > 0 && isOp(t[i + 1], "=") && (isOp(t[i - 1], "{") || isOp(t[i - 1], ",") || isOp(t[i - 1], ";"));
}

/** Root name of a field chain ending at token i (a.b.c -> a). */
function chainRoot(tokens: Token[], i: number): Token | undefined {
  let k = i;
  while (isOp(tokens[k - 1], ".") || isOp(tokens[k - 1], ":")) {
    k -= 2;
    if (isOp(tokens[k], "]") || isOp(tokens[k], ")")) return undefined;
  }
  return tokens[k];
}

const RXP_NAME = /rxp|restedxp/i;

export const RULES: readonly Rule[] = [
  // ------------------------------------------------------------ 1 TOC identity
  {
    id: "toc-file-name",
    category: "toc",
    langs: ["toc"],
    run: (ctx) => {
      if (!ctx.f.path.includes("/")) ctx.emitMeta(ctx.f.path, "TOC file name (addon folder must match its base name)");
    },
  },
  {
    id: "toc-metadata",
    category: "toc",
    langs: ["toc"],
    re: /^##\s*(?<key>Title(?:-\w+)?|Notes(?:-\w+)?|Author|SavedVariables(?:PerCharacter)?|OptionalDeps|Dependencies|RequiredDeps|LoadWith|X-[\w-]+|Interface(?:-\w+)?|IconTexture|IconAtlas|AddonCompartment\w*)[ \t]*:[ \t]*(?<id>[^\r\n]*?)[ \t]*$/dgm,
    anchor: "any",
    pick: (m, ctx) => {
      const key = m.groups!.key!;
      const [vs] = m.indices!.groups!.id!;
      const value = m.groups!.id!;
      if (/^(SavedVariables|OptionalDeps|Dependencies|RequiredDeps|LoadWith)/.test(key)) {
        let off = 0;
        for (const part of value.split(",")) {
          const lead = part.length - part.trimStart().length;
          const name = part.trim();
          if (name) ctx.emit(vs + off + lead, vs + off + lead + name.length, name, `## ${key}`);
          off += part.length + 1;
        }
      } else ctx.emit(vs, vs + value.length || vs + 1, value, `## ${key}`);
    },
  },

  // ------------------------------------------------------------ 7 key bindings (before frames: Binding name= is not a frame)
  {
    id: "bindings-xml",
    category: "bindings",
    langs: ["xml"],
    hint: ["<binding"],
    run: (ctx) => {
      for (const a of ctx.attrs())
        if (/^Bindings?$/.test(a.tag) && /^(name|header|category)$/.test(a.attr) && a.value)
          ctx.emit(a.vstart, a.vend, a.value, `<${a.tag} ${a.attr}>`);
    },
  },
  {
    id: "binding-globals-computed",
    category: "bindings",
    langs: ["lua"],
    hint: ["binding_"],
    re: /\b_G\s*\[\s*(?<id>(["'])BINDING_(?:HEADER|NAME|CATEGORY)_\2\s*\.\.\s*[^\]\r\n]+?)\s*\]/dg,
    anchor: "code",
    norm: (s) => s.replace(/\s+/g, " "),
    detail: "BINDING_* global with a computed name",
  },
  { id: "binding-globals", category: "bindings", langs: ["lua", "xml"], hint: ["binding_"], re: /\b(?<id>BINDING_(?:HEADER|NAME|CATEGORY)_\w+)/dg },

  // ------------------------------------------------------------ 6 slash commands
  {
    id: "slash-global",
    category: "slash",
    langs: ["lua"],
    hint: ["slash_"],
    re: /\b(?<name>SLASH_\w+?)(?<n>\d*)\s*=\s*(?:(["'])(?<id>[^"']*)\3)?/dg,
    anchor: "code",
    pick: (m, ctx) => {
      const [a, b] = m.indices!.groups!.name!;
      ctx.emit(a, b + (m.groups!.n?.length ?? 0), m.groups!.name! + (m.groups!.n ?? ""), "SLASH_ global");
      const v = m.indices!.groups!.id;
      if (v) ctx.emit(v[0], v[1], m.groups!.id!, "slash command text");
    },
  },
  { id: "slashcmdlist", category: "slash", langs: ["lua"], hint: ["slashcmdlist"], re: /\bSlashCmdList\s*(?:\.\s*(?<id>\w+)|\[\s*(["'])(?<id2>[^"']*)\2\s*\])/dg, anchor: "code",
    pick: (m, ctx) => {
      const g = m.indices!.groups!.id ?? m.indices!.groups!.id2!;
      ctx.emit(g[0], g[1], m.groups!.id ?? m.groups!.id2!, "SlashCmdList key");
    },
  },
  { id: "ace-chat-command", category: "slash", langs: ["lua"], hint: ["registerchatcommand"], re: new RegExp(String.raw`\bRegisterChatCommand\s*\(\s*` + STRING_LIT, "dg"), anchor: "code", at: "string", norm: (s) => "/" + s, detail: "AceConsole RegisterChatCommand" },

  // ------------------------------------------------------------ 8 comms
  { id: "comm-prefix-field", category: "comms", langs: ["lua"], hint: ["commprefix"], re: new RegExp(String.raw`\b_?commPrefix\s*=\s*` + STRING_LIT, "dg"), anchor: "code", at: "string", detail: "comm prefix assignment" },
  {
    id: "comm-calls",
    category: "comms",
    langs: ["lua"],
    hint: ["comm", "addonmessage", "channel"],
    re: /\b(?<fn>RegisterAddonMessagePrefix|RegisterComm|SendCommMessage|SendAddonMessage(?:Logged)?|JoinChannelByName|JoinTemporaryChannel|JoinPermanentChannel|LeaveChannelByName)\s*\(/dg,
    anchor: "code",
    pick: (m, ctx) => emitArg(0, m.groups!.fn)(m, ctx),
  },

  // ------------------------------------------------------------ 2 saved variables
  { id: "acedb-new", category: "savedvars", langs: ["lua"], hint: ["acedb"], files: (f) => f.status !== "library", re: /(?:AceDB-3\.0["']\s*\)|\bAceDB)\s*:\s*New\s*\(/dg, anchor: "notComment", pick: emitArg(0, "AceDB:New") },
  {
    id: "savedvar-access",
    category: "savedvars",
    langs: ["lua", "xml"],
    run: (ctx) => {
      const names = ctx.tree.savedVars;
      if (!names.length) return;
      const re = new RegExp(String.raw`\b(${names.join("|")})\b`, "g");
      for (const m of ctx.f.src.matchAll(re)) {
        const at = m.index;
        if (ctx.region[at] !== CODE && ctx.region[at] !== STRING) continue;
        // a field of the same name on another table is not the saved variable (but _G.X is)
        const before = ctx.f.src.slice(Math.max(0, at - 8), at);
        if (ctx.region[at] === CODE && /[.:]\s*$/.test(before) && !/_G\s*\.\s*$/.test(before)) continue;
        const after = ctx.f.src.slice(at + m[0].length, at + m[0].length + 4);
        const kind = ctx.region[at] === STRING ? "string" : /^\s*=[^=]/.test(after) ? "write" : "read";
        ctx.emit(at, at + m[0].length, m[0], kind);
      }
    },
  },

  // ------------------------------------------------------------ 9 LibStub / Ace registrations
  { id: "ace-newaddon", category: "ace", langs: ["lua"], hint: ["newaddon"], re: /:\s*NewAddon\s*\(/dg, anchor: "code",
    pick: (m, ctx) => {
      const paren = m.index + m[0].length - 1;
      const a0 = ctx.arg(paren, 0);
      const a1 = ctx.arg(paren, 1);
      // NewAddon("Name", ...) or NewAddon(tbl, "Name", ...)
      const nameArg = a0 && /^["']/.test(a0.text) ? a0 : a1;
      if (nameArg) ctx.emit(nameArg.start, nameArg.end, argId(nameArg), "AceAddon NewAddon name");
    },
  },
  { id: "ace-newmodule", category: "ace", langs: ["lua"], hint: ["newmodule"], re: /:\s*NewModule\s*\(/dg, anchor: "code", pick: emitArg(0, "AceAddon NewModule (scoped to the addon object)") },
  { id: "libstub-newlibrary", category: "ace", langs: ["lua"], hint: ["newlibrary"], re: /:\s*NewLibrary\s*\(/dg, anchor: "code", pick: emitArg(0, "LibStub NewLibrary") },
  { id: "acelocale", category: "ace", langs: ["lua"], hint: ["acelocale"], re: /AceLocale-3\.0["']\s*\)\s*:\s*(?<fn>NewLocale|GetLocale)\s*\(/dg, anchor: "notComment", pick: (m, ctx) => emitArg(0, `AceLocale ${m.groups!.fn}`)(m, ctx) },
  { id: "aceconfig", category: "ace", langs: ["lua"], hint: ["registeroptionstable", "addtoblizoptions"], re: /:\s*(?<fn>RegisterOptionsTable|AddToBlizOptions)\s*\(/dg, anchor: "code", pick: (m, ctx) => emitArg(0, `AceConfig ${m.groups!.fn}`)(m, ctx) },
  { id: "ldb-object", category: "ace", langs: ["lua"], hint: ["newdataobject"], re: /:\s*NewDataObject\s*\(/dg, anchor: "code", pick: emitArg(0, "LibDataBroker NewDataObject") },
  { id: "dbicon", category: "ace", langs: ["lua"], hint: ["dbicon"], re: /\b\w*DBIcon\w*\s*:\s*(?<fn>Register|Show|Hide|IsRegistered|Lock|Unlock|Refresh|GetMinimapButton)\s*\(/dg, anchor: "code", pick: (m, ctx) => emitArg(0, `LibDBIcon ${m.groups!.fn}`)(m, ctx) },
  { id: "acegui-widget-type", category: "ace", langs: ["lua"], hint: ["version"], re: new RegExp(String.raw`\blocal\s+Type\s*,\s*Version\s*=\s*` + STRING_LIT, "dg"), anchor: "code", at: "string", detail: "AceGUI widget type (shared AceGUI registry; version-gated)" },
  {
    id: "acegui-calls",
    category: "ace",
    langs: ["lua"],
    hint: ["acegui"],
    re: /\bAceGUI\s*:\s*(?<fn>RegisterWidgetType|RegisterLayout|Create)\s*\(/dg,
    anchor: "code",
    pick: (m, ctx) => {
      const s = ctx.arg(m.index + m[0].length - 1, 0);
      if (!s) return;
      // Create() of stock AceGUI widgets (Label, Frame, ...) is not a registration; report addon widget types only
      if (m.groups!.fn === "Create" && !RXP_NAME.test(s.text)) return;
      ctx.emit(s.start, s.end, argId(s), `AceGUI ${m.groups!.fn}`);
    },
  },

  {
    id: "acegui-type-literal",
    category: "ace",
    langs: ["lua"],
    hint: ["rxp"],
    re: new RegExp(STRING_LIT, "dg"),
    at: "string",
    pick: (m, ctx) => {
      const [s, e] = m.indices!.groups!.id!;
      if (ctx.region[s] === STRING && ctx.tree.widgetTypes.has(m.groups!.id!)) ctx.emit(s, e, m.groups!.id!, "AceGUI widget type name passed as a value");
    },
  },

  // ------------------------------------------------------------ 14 shared runtime registries
  {
    id: "ace-messages",
    category: "registries",
    langs: ["lua"],
    hint: ["message", "sendevent"],
    re: /[.:]\s*(?<fn>SendEvent|QueueMessage|SendMessage|RegisterMessage|UnregisterMessage)\s*\(/dg,
    anchor: "code",
    pick: (m, ctx) => {
      const paren = m.index + m[0].length - 1;
      // addon.SendEvent(self, msg) / addon.SendMessage(self, msg): skip the explicit self
      let s = ctx.arg(paren, 0);
      if (s && s.text === "self" && ctx.f.src[m.index] === ".") s = ctx.arg(paren, 1);
      if (s && s.text !== "..." && s.text !== "nil") ctx.emit(s.start, s.end, argId(s), `AceEvent ${m.groups!.fn}`);
    },
  },
  { id: "message-prefix", category: "registries", langs: ["lua"], hint: ["messageprefix"], re: new RegExp(String.raw`\bmessagePrefix\s*=\s*` + STRING_LIT, "dg"), anchor: "code", at: "string", detail: "AceEvent message-name prefix" },
  { id: "static-popup", category: "registries", langs: ["lua"], hint: ["staticpopup"], re: new RegExp(String.raw`\bStaticPopupDialogs\s*\[\s*` + STRING_LIT, "dg"), anchor: "code", at: "string", detail: "StaticPopupDialogs key" },
  { id: "static-popup-show", category: "registries", langs: ["lua"], hint: ["staticpopup_show"], re: /\bStaticPopup_Show\s*\(/dg, anchor: "code", pick: emitArg(0, "StaticPopup_Show") },
  { id: "ui-special-frames", category: "registries", langs: ["lua"], hint: ["uispecialframes"], re: /\btinsert\s*\(\s*(?:_G\s*\.\s*)?UISpecialFrames\s*,/dg, anchor: "code",
    pick: (m, ctx) => {
      const s = ctx.arg(ctx.f.src.lastIndexOf("(", m.index + m[0].length), 1);
      if (s) ctx.emit(s.start, s.end, argId(s), "UISpecialFrames entry");
    },
  },

  { id: "popup-helpers", category: "registries", langs: ["lua"], hint: ["popupnotification", "confirmchoice"], re: /[.:]\s*(?<fn>PopupNotification|ConfirmChoice)\s*\(/dg, anchor: "code", pick: (m, ctx) => emitArg(0, `StaticPopupDialogs key via addon.comms:${m.groups!.fn}`)(m, ctx) },
  { id: "macro-name-field", category: "registries", langs: ["lua"], hint: ["macroname"], re: new RegExp(String.raw`\b\w*[mM]acroName\s*=\s*` + STRING_LIT, "dg"), anchor: "code", at: "string", detail: "macro name (account/character macro slots are shared by all addons)" },
  { id: "macro-api", category: "registries", langs: ["lua"], hint: ["macro"], re: /\b(?<fn>CreateMacro|EditMacro|DeleteMacro|GetMacroIndexByName|GetMacroInfo)\s*\(/dg, anchor: "code", pick: (m, ctx) => emitArg(0, `macro API ${m.groups!.fn}`)(m, ctx) },

  // ------------------------------------------------------------ 10 addon folder / name
  {
    id: "addons-path-concat",
    category: "addon-folder",
    langs: ["lua"],
    hint: ["addons"],
    re: /(?<id>interface(?:\\\\|\/)+addons(?:\\\\|\/)+)(["'])\s*\.\.\s*(?<expr>[\w.]+)/dgi,
    at: "string",
    pick: (m, ctx) => {
      const [a] = m.indices!.groups!.id!;
      const [, e] = m.indices!.groups!.expr!;
      ctx.emit(a, e, "Interface/AddOns/\" .. " + m.groups!.expr!, "path built from a variable (follows the folder name)");
    },
  },
  {
    id: "addons-path-literal",
    category: "addon-folder",
    langs: ["lua", "xml", "toc"],
    hint: ["addons"],
    re: /interface(?:\\\\|\\|\/)+addons(?:\\\\|\\|\/)+[^"'\s<>|:]+/dgi,
    at: "notComment",
    pick: (m, ctx) => {
      const full = m[0];
      const norm = full.replace(/\\\\|\\/g, "/");
      const dir = norm.slice(0, norm.lastIndexOf("/") + 1);
      ctx.emit(m.index, m.index + full.length, dir, norm);
    },
  },
  { id: "addon-api", category: "addon-folder", langs: ["lua"], hint: ["addon"], re: /\b(?<fn>GetAddOnMetadata|IsAddOnLoaded|LoadAddOn|EnableAddOn|DisableAddOn|GetAddOnInfo|IsAddOnLoadOnDemand|GetAddOnEnableState|DoesAddOnExist)\s*\(/dg, anchor: "code", pick: (m, ctx) => emitArg(0, m.groups!.fn)(m, ctx) },
  { id: "addon-name-compare", category: "addon-folder", langs: ["lua"], hint: ["addonname"], re: new RegExp(String.raw`\baddonName\s*[=~]=\s*` + STRING_LIT, "dg"), anchor: "code", at: "string", detail: "addonName comparison" },
  { id: "companion-addon", category: "addon-folder", langs: ["lua", "xml"], hint: ["rxpguides_"], re: /(?<![\w])(?<id>RXPGuides_\w+)/dg, at: "string", detail: "companion addon name" },

  // ------------------------------------------------------------ 5 frames and XML
  {
    id: "createframe",
    category: "frames",
    langs: ["lua"],
    hint: ["createframe"],
    re: /\bCreateFrame\s*\(/dg,
    anchor: "code",
    pick: (m, ctx) => {
      const paren = m.index + m[0].length - 1;
      const name = ctx.arg(paren, 1);
      if (name && name.text !== "nil") {
        const lit = /^(["'])([^"']*)\1$/.exec(name.text);
        const kind = lit ? (lit[2]!.startsWith("$parent") ? "$parent-relative name" : "literal name") : "computed name (expression)";
        ctx.emit(name.start, name.end, argId(name), `CreateFrame ${kind}`);
      }
      const tpl = ctx.arg(paren, 3);
      if (tpl) {
        const lit = /^(["'])([^"']*)\1$/.exec(tpl.text);
        if (lit && (RXP_NAME.test(lit[2]!) || ctx.tree.xmlTemplates.has(lit[2]!))) ctx.emit(tpl.start, tpl.end, lit[2]!, "CreateFrame template (addon XML template)");
      }
    },
  },
  {
    id: "xml-names",
    category: "frames",
    langs: ["xml"],
    hint: ["name=", "inherits=", "mixin="],
    run: (ctx) => {
      for (const a of ctx.attrs()) {
        if (/^(Script|Include|Binding|Bindings)$/.test(a.tag) || !a.value) continue;
        if (a.attr === "name") ctx.emit(a.vstart, a.vend, a.value, a.value.includes("$") ? `<${a.tag}> $parent-relative name` : `<${a.tag}> name`);
        else if (a.attr === "inherits") for (const t of a.value.split(",")) { const v = t.trim(); const o = a.value.indexOf(v); if (v && (RXP_NAME.test(v) || ctx.tree.xmlTemplates.has(v))) ctx.emit(a.vstart + o, a.vstart + o + v.length, v, `<${a.tag}> inherits`); }
        else if (/^(mixin|secureMixin)$/.test(a.attr)) ctx.emit(a.vstart, a.vend, a.value, `<${a.tag}> ${a.attr}`);
        else if (/^(parentKey|parentArray|relativeKey)$/.test(a.attr) && RXP_NAME.test(a.value)) ctx.emit(a.vstart, a.vend, a.value, `<${a.tag}> ${a.attr} (frame-local key)`);
      }
    },
  },
  { id: "named-regions", category: "frames", langs: ["lua"], hint: ["create"], re: /:\s*(?<fn>CreateTexture|CreateFontString|CreateMaskTexture|CreateLine|CreateAnimationGroup)\s*\(/dg, anchor: "code",
    pick: (m, ctx) => {
      const s = ctx.arg(m.index + m[0].length - 1, 0);
      if (s && s.text !== "nil" && /^["']/.test(s.text)) ctx.emit(s.start, s.end, argId(s), `${m.groups!.fn} name (named regions are globals)`);
    },
  },
  { id: "frame-name-variable", category: "frames", langs: ["lua"], hint: ["framename"], re: new RegExp(String.raw`\b\w*[fF]rameName\s*=\s*` + STRING_LIT, "dg"), anchor: "code", at: "string",
    pick: (m, ctx) => {
      const [s, e] = m.indices!.groups!.id!;
      if (RXP_NAME.test(m.groups!.id!)) ctx.emit(s, e, m.groups!.id!, "frame name held in a variable (used with _G[...] / CreateFrame)");
    },
  },
  { id: "click-binding-string", category: "bindings", langs: ["lua"], hint: ["click "], re: /(["'])(?<id>CLICK [\w$]+:\w+)\1/dg, at: "string", detail: "CLICK binding command naming a frame" },
  { id: "acegui-layout", category: "ace", langs: ["lua"], hint: ["setlayout"], re: /:\s*SetLayout\s*\(/dg, anchor: "code",
    pick: (m, ctx) => {
      const s = ctx.arg(m.index + m[0].length - 1, 0);
      if (s && RXP_NAME.test(s.text)) ctx.emit(s.start, s.end, argId(s), "AceGUI layout name (shared AceGUI registry)");
    },
  },
  { id: "frame-name-string-concat", category: "frames", langs: ["lua"], hint: ["rxp"], re: /(["'])(?<id>[A-Za-z_]*RXP\w*%?\w*)\1\s*(?:\.\.|\)\s*:\s*format)/dg, at: "string", detail: "name built by concatenation/format with an RXP prefix" },

  // ------------------------------------------------------------ 4 guide coupling
  {
    id: "guide-globals",
    category: "guide-coupling",
    langs: ["lua"],
    files: (f) => f.isGuide,
    aggregate: false,
    run: (ctx) => {
      const a = ctx.lua!;
      const t = a.tokens;
      for (let i = 0; i < t.length; i++) {
        const tok = t[i]!;
        if (tok.type !== "name") continue;
        if (!(ctx.tree.addonGlobals.has(tok.value) || RXP_NAME.test(tok.value))) continue;
        if (isOp(t[i - 1], ".") || isOp(t[i - 1], ":") || a.locals.has(tok.value) || isTableKey(ctx, i)) continue;
        let end = tok.end;
        let id = tok.value;
        if ((isOp(t[i + 1], ".") || isOp(t[i + 1], ":")) && t[i + 2]?.type === "name") {
          end = t[i + 2]!.end;
          id = `${tok.value}.${t[i + 2]!.value}`;
        }
        ctx.emit(tok.start, end, id, "global used by a guide file");
      }
    },
  },

  {
    // guide files that reach the engine through the private addon table (local _, addon = ...) instead of a global
    id: "guide-private-table",
    category: "guide-coupling",
    langs: ["lua"],
    files: (f) => f.isGuide,
    hint: ["addon"],
    re: /\baddon(?<chain>(?:\s*[.:]\s*[A-Za-z_]\w*)+)\s*\(/dg,
    anchor: "code",
    pick: (m, ctx) => {
      const end = m.index + m[0].length - 1;
      ctx.emit(m.index, end, "addon" + m.groups!.chain!.replace(/\s+/g, ""), "call through the addon's private table (from `...`), not a global");
    },
  },

  // ------------------------------------------------------------ 3 globals (structural)
  {
    id: "global-writes",
    category: "globals",
    langs: ["lua"],
    files: (f) => f.status !== "library",
    run: (ctx) => {
      for (const w of ctx.lua!.writes) {
        if (w.kind === "field" && !(ctx.tree.addonGlobals.has(w.name) || RXP_NAME.test(w.id))) continue; // next rule
        ctx.emit(w.start, w.end, w.id, w.kind === "field" ? `write: field of addon global ${w.name}` : `write: global ${w.kind === "_G" ? "via _G" : w.kind}`);
      }
    },
  },
  {
    // field writes on Blizzard/other globals (StaticPopupDialogs[...], ChatFrameUtil.X): shared state
    id: "global-field-writes",
    category: "globals",
    langs: ["lua"],
    files: (f) => f.status !== "library",
    aggregate: true,
    run: (ctx) => {
      for (const w of ctx.lua!.writes)
        if (w.kind === "field" && !(ctx.tree.addonGlobals.has(w.name) || RXP_NAME.test(w.id)))
          ctx.emit(w.start, w.end, w.id, `write: field of non-addon global ${w.name}`);
    },
  },
  {
    id: "global-G-access",
    category: "globals",
    langs: ["lua"],
    hint: ["_g"],
    re: /\b_G\s*(?:\.\s*(?<a>\w+)|\[\s*(?<b>(["'])[^"']*\3(?:\s*\.\.[^\]]+)?|[^\]]+)\s*\])/dg,
    anchor: "code",
    pick: (m, ctx) => {
      const name = m.groups!.a ?? m.groups!.b!;
      const span = m.indices!.groups!.a ?? m.indices!.groups!.b!;
      const lit = /^(["'])([^"']*)\1$/.exec(name);
      const key = lit ? lit[2]! : name;
      if (!(ctx.tree.addonGlobals.has(key) || RXP_NAME.test(name) || ctx.tree.savedVars.includes(key))) return;
      const [s, e] = lit ? [span[0] + 1, span[1] - 1] : span;
      ctx.emit(s, e, lit || m.groups!.a ? key : `_G[${name}]`, lit || m.groups!.a ? "read via _G" : "read via _G (computed name)");
    },
  },
  {
    id: "global-reads",
    category: "globals",
    langs: ["lua"],
    files: (f) => f.status !== "library",
    run: (ctx) => {
      const a = ctx.lua!;
      const t = a.tokens;
      for (let i = 0; i < t.length; i++) {
        const tok = t[i]!;
        if (tok.type !== "name" || !ctx.tree.addonGlobals.has(tok.value)) continue;
        if (isOp(t[i - 1], ".") || isOp(t[i - 1], ":") || isOp(t[i - 1], "::") || a.locals.has(tok.value) || isTableKey(ctx, i)) continue;
        ctx.emit(tok.start, tok.end, tok.value, `read (defined in ${ctx.tree.addonGlobals.get(tok.value)})`);
      }
    },
  },

  // ------------------------------------------------------------ 12 URLs (before markup: URLs in guide text contain ab_channel=RestedXP)
  { id: "urls", category: "urls", langs: ["lua", "xml", "toc"], hint: ["http"], re: /https?:\/\/[^\s"'<>|\]]+/dg, at: "notComment",
    pick: (m, ctx) => {
      const host = /^https?:\/\/([^/?#]+)/i.exec(m[0])?.[1]?.toLowerCase() ?? m[0];
      ctx.emit(m.index, m.index + m[0].length, host, m[0].length > 200 ? m[0].slice(0, 200) + "…" : m[0]);
    },
    aggregate: true,
  },

  // ------------------------------------------------------------ 15 guide markup and references
  { id: "guide-colour-token", category: "guide-markup", langs: ["lua"], hint: ["crxp_"], re: /(?<![A-Za-z0-9])(?<id>cRXP_[A-Za-z]*_?)/dg, at: "string", aggregate: true, detail: "guide text colour token" },
  { id: "guide-colour-key", category: "guide-markup", langs: ["lua"], hint: ["rxp_"], re: /(["'])(?<id>RXP_(?:[A-Z]+|\[A-Z\]\+)_)\1/dg, at: "string", detail: "guide text colour table key (or the pattern matching them)" },
  {
    id: "guide-directives",
    category: "guide-markup",
    langs: ["lua"],
    files: (f) => f.isGuide,
    hint: ["rxp"],
    re: /^[ \t]*(?:--)?(?<key>#\w+|\.\w+)[ \t]+(?<id>[^\r\n]*?(?:restedxp|rxp)[^\r\n]*?)[ \t]*$/dgim,
    at: "string",
    aggregate: true,
    pick: (m, ctx) => {
      const key = m.groups!.key!.toLowerCase();
      const [s, e] = m.indices!.groups!.id!;
      if (ctx.region[s] !== STRING) return;
      const visible = key === "#group" || key === "#subgroup" || key === "#displayname";
      // only guide-structure directives; step text (.link, .goto ...) is left to later rules
      if (!visible && !/^(#include|#next|#groupid|#name|#defaultfor|\.clicknext|#questguide|#chapter)$/.test(key)) return;
      if (visible) {
        if (ctx.emit(s, e, m.groups!.id!, `${key} (visible guide group name)`)) ctx.recategorize?.("branding");
        return;
      }
      ctx.emit(s, e, m.groups!.id!, `${key} (cross-reference to a group/guide name)`);
    },
  },

  // ------------------------------------------------------------ 16 file and asset names
  { id: "source-file-names", category: "files", langs: ["lua", "xml", "toc"], hint: ["rxp"], re: /(?<![\w])(?<id>[\w\\/.-]*\b\w*RXP\w*\.(?:lua|xml|toc))\b/dgi, at: "any", detail: "source file name" },
  {
    id: "asset-names",
    category: "files",
    langs: ["lua", "xml"],
    hint: ["rxp"],
    re: /(?<![\w])(?<id>rxp[\w-]*)/dg,
    at: "string",
    pick: (m, ctx) => {
      const [s, e] = m.indices!.groups!.id!;
      if (ctx.region[s] !== STRING) return;
      if (ctx.tree.assetNames.has(m.groups!.id!.toLowerCase())) ctx.emit(s, e, m.groups!.id!, "texture/asset file base name");
    },
  },

  // ------------------------------------------------------------ 12 commercial words (strings)
  {
    id: "commercial-words",
    category: "urls",
    langs: ["lua", "xml"],
    re: /\b(?<id>restedxp\.com|discord(?:\.gg|app\.com)?|patreon|paypal|premium|purchase[sd]?|shop|store|subscri(?:be|ption)|donat(?:e|ion)s?|buy|upgrade[sd]?)\b/dgi,
    at: "string",
    aggregate: true,
    files: (f) => !f.isGuide,
    norm: (s) => s.toLowerCase(),
  },
  { id: "commercial-words-guides", category: "urls", langs: ["lua"], files: (f) => f.isGuide, re: /\b(?<id>restedxp\.com|discord(?:\.gg|app\.com)?|patreon|paypal|premium|purchase[sd]?|subscri(?:be|ption)|donat(?:e|ion)s?)\b/dgi, at: "string", aggregate: true, norm: (s) => s.toLowerCase() },

  // ------------------------------------------------------------ 11 branding strings
  {
    id: "branding-strings",
    category: "branding",
    langs: ["lua", "xml", "toc"],
    hint: ["rxp", "rested"],
    re: /(?<id>Rested[ -]?XP|\bRXP(?:G|Guides)?\b)/dgi,
    at: "string",
    aggregate: true,
    pick: (m, ctx) => {
      const [s, e] = m.indices!.groups!.id!;
      if (ctx.region[s] !== STRING) return;
      // identifier = the whole string literal when short, else the word in context
      let a = s;
      let b = e;
      while (a > 0 && ctx.region[a - 1] === STRING) a--;
      while (b < ctx.region.length && ctx.region[b] === STRING) b++;
      const lit = ctx.f.src.slice(a, b).replace(/^(\[=*\[|["'])|(\]=*\]|["'])$/g, "").replace(/\s+/g, " ").trim();
      const id = lit.length <= 100 ? lit : `…${ctx.f.src.slice(Math.max(a, s - 30), Math.min(b, e + 30)).replace(/\s+/g, " ")}…`;
      ctx.emit(s, e, id, `brand word "${m[0]}" in a string literal`);
    },
  },
  // keys of addon-private tables / per-profile settings (no collision)
  { id: "private-table-keys", category: "internal", langs: ["lua"], hint: ["enabledframes", "frameposition"],
    re: /(?:\benabledFrames\s*\[\s*(?<k>(["'])[^"']*\2)|[.:]\s*(?:LoadFramePosition|SaveFramePosition)\s*\(\s*(?<p>(["'])[^"']*\4))/dg,
    anchor: "code",
    pick: (m, ctx) => {
      const g = m.indices!.groups!.k ?? m.indices!.groups!.p!;
      const text = ctx.f.src.slice(g[0] + 1, g[1] - 1);
      ctx.emit(g[0] + 1, g[1] - 1, text, m.groups!.k ? "key in addon.enabledFrames" : "frame-position key in the addon's settings profile");
    },
  },
  // ------------------------------------------------------------ 17 comments
  { id: "comments", category: "comments", langs: ["lua", "xml", "toc"], hint: ["rxp", "restedxp"], re: /[\w-]*(?:restedxp|rxp)[\w-]*/dgi, anchor: "comment", at: "comment", aggregate: true },

  // ------------------------------------------------------------ 18 / 3 remaining identifier tokens with rxp
  {
    id: "rxp-identifiers",
    category: "internal",
    langs: ["lua"],
    hint: ["rxp"],
    run: (ctx) => {
      const a = ctx.lua!;
      const t = a.tokens;
      for (let i = 0; i < t.length; i++) {
        const tok = t[i]!;
        if (tok.type !== "name" || !RXP_NAME.test(tok.value)) continue;
        if (isOp(t[i - 1], ".") || isOp(t[i - 1], ":")) {
          const root = chainRoot(t, i);
          const rootIsLocal = !root || root.type !== "name" || a.locals.has(root.value) || root.value === "self";
          if (rootIsLocal) ctx.emit(tok.start, tok.end, tok.value, "field/method on a local table");
          else emitAs(ctx, "globals", tok.start, tok.end, tok.value, `field on global ${root.value}`);
        } else if (isTableKey(ctx, i)) ctx.emit(tok.start, tok.end, tok.value, "table constructor key");
        else if (a.locals.has(tok.value)) ctx.emit(tok.start, tok.end, tok.value, "local/parameter");
        else emitAs(ctx, "globals", tok.start, tok.end, tok.value, "global (not declared local in this file)");
      }
    },
  },
];

/**
 * Emit under a different category than the running rule. Used by the
 * identifier fallback, whose decision (internal vs global) is per token.
 */
function emitAs(ctx: RuleCtx, category: string, s: number, e: number, id: string, detail: string): void {
  const ok = ctx.emit(s, e, id, detail);
  if (ok) ctx.recategorize?.(category);
}

