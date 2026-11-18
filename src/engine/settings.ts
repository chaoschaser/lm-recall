//
// Plugin settings layered over the file/env/default configuration.
//
// Precedence for every knob:
//   plugin settings -> vault.json -> LM_RECALL_VAULT (vaultPath only) -> defaults
//
// LM Studio always hands back a value for every settings field (its default
// when the user never touched it), so "the user set this" has to be read
// from the value itself:
//   - vaultPath, permanentFolder, inboxFolder: any non-blank text
//   - everything else: a valid value that differs from the compiled default
// A field left at its default therefore defers to vault.json. No LM Studio
// dependency here: the glue in ../settings.ts reads the fields and calls this.
//

import { homedir } from "node:os";
import { join } from "node:path";
import { HOMELAB_DEFAULTS, type HomelabConfig } from "./homelab";

/** What the plugin settings UI can hold. Every key is optional. */
export interface PluginSettings {
  vaultPath?: string;
  permanentFolder?: string;
  inboxFolder?: string;
  userSectionHeadings?: string[];
  maxEntities?: number;
  maxHopNotes?: number;
  maxFuzzyNotes?: number;
  totalMaxChars?: number;
}

const NUMERIC_SETTINGS = ["maxEntities", "maxHopNotes", "maxFuzzyNotes", "totalMaxChars"] as const;

/** "~" and "~/..." mean the home folder, as typed into a settings field. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `base` (vault.json / env / defaults) with the user's plugin settings on top. */
export function applySettings(base: HomelabConfig, settings: PluginSettings): HomelabConfig {
  const out: HomelabConfig = { ...base };

  const vaultPath = typeof settings.vaultPath === "string" ? settings.vaultPath.trim() : "";
  if (vaultPath) out.vaultPath = expandHome(vaultPath);

  const permanentFolder = typeof settings.permanentFolder === "string" ? settings.permanentFolder.trim() : "";
  if (permanentFolder) out.permanentFolder = permanentFolder;

  const inboxFolder = typeof settings.inboxFolder === "string" ? settings.inboxFolder.trim() : "";
  if (inboxFolder) out.inboxFolder = inboxFolder;

  if (Array.isArray(settings.userSectionHeadings)) {
    const headings = settings.userSectionHeadings
      .filter((h): h is string => typeof h === "string")
      .map((h) => h.trim())
      .filter(Boolean);
    if (headings.length && !sameList(headings, HOMELAB_DEFAULTS.userSectionHeadings)) {
      out.userSectionHeadings = headings;
    }
  }

  for (const key of NUMERIC_SETTINGS) {
    const v = settings[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v !== HOMELAB_DEFAULTS[key]) {
      out[key] = v;
    }
  }
  return out;
}
