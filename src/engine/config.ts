
//
// Machine-local configuration loader for lm-recall.
//
// This is the layer *under* the plugin settings (see ./settings.ts, which
// puts the user's LM Studio settings on top of RUNTIME_CONFIG per message).
//
// Resolution order for every knob:
//   1. vault.json      (plugin root; gitignored — machine-local, never travels)
//   2. HOMELAB_DEFAULTS (compiled-in defaults from ./homelab)
//
// vaultPath has one extra layer: the LM_RECALL_VAULT env var sits between
// them, so a shell override works when vault.json omits the path.
//
// Design rule: config failures degrade silently to defaults. The
// preprocessor fails open anyway; config loading must never be the thing
// that blocks a user's message. Missing file is the normal case on a
// fresh clone (or a fresh machine) and is not logged; a *present but
// broken* vault.json gets one warning line, then defaults win.
//

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOMELAB_DEFAULTS, type HomelabConfig } from "./homelab";

/**
 * The plugin root is the nearest directory at or above this file that holds
 * manifest.json. Searching (instead of a fixed number of "..") keeps it
 * correct whether this runs from src/engine, dist/engine, or a single bundled
 * file in .lmstudio/ — and regardless of the cwd lms was launched from.
 */
function findPluginRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "manifest.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(start, ".."); // last resort: the old fixed guess
}

const CONFIG_FILE = join(findPluginRoot(__dirname), "vault.json");

function readFileConfig(): Partial<HomelabConfig> {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      console.warn("[lm-recall] vault.json is not a JSON object — using defaults");
      return {};
    }
    return raw as Partial<HomelabConfig>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // File exists but is unreadable or invalid JSON — worth one line of noise.
      console.warn(
        "[lm-recall] vault.json present but unreadable — using defaults:",
        err instanceof Error ? err.message : err,
      );
    }
    return {};
  }
}

const fileConfig = readFileConfig();

/**
 * The file/env/default configuration; index.ts layers plugin settings on top.
 *
 * Unknown keys in vault.json are ignored (they're not part of the
 * HomelabConfig shape, and this is read-only input — stray keys never
 * reach the vault or the model).
 */
export const RUNTIME_CONFIG: HomelabConfig = {
  ...HOMELAB_DEFAULTS,
  ...fileConfig,
  // vaultPath precedence: vault.json -> env var -> compiled default ("").
  // (Explicit key placed after the spreads so it wins.)
  vaultPath:
    fileConfig.vaultPath
    ?? process.env.LM_RECALL_VAULT
    ?? HOMELAB_DEFAULTS.vaultPath,
};

console.log(
  `[lm-recall] config: ${existsSync(CONFIG_FILE) ? CONFIG_FILE : "no vault.json (defaults/env)"}`,
);
