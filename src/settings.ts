//
// The plugin's settings in LM Studio, and how they are read back.
//
//   - global (one value for every chat): where the vault is, its inbox and
//     promoted-notes folders, and which sections of a note are quoted first
//   - per chat: how much is added to a message
//
// Defaults mirror HOMELAB_DEFAULTS on purpose: a field left at its default
// defers to vault.json (see engine/settings.ts).
//

import { createConfigSchematics, type BaseController } from "@lmstudio/sdk";
import { HOMELAB_DEFAULTS } from "./engine/homelab";
import type { PluginSettings } from "./engine/settings";

export const globalConfigSchematics = createConfigSchematics()
  .field(
    "vaultPath",
    "string",
    {
      displayName: "Vault folder",
      subtitle: "Full path to the folder that holds your notes. Leave empty to use vault.json or LM_RECALL_VAULT.",
      placeholder: "/home/you/Obsidian/Vault",
    },
    "",
  )
  .field(
    "permanentFolder",
    "string",
    {
      displayName: "Folder for promoted notes",
      subtitle: "Folder inside the vault where promote saves permanent notes. Leave empty for Zettels (or vault.json).",
      placeholder: "Zettels",
    },
    "",
  )
  .field(
    "inboxFolder",
    "string",
    {
      displayName: "Inbox folder",
      subtitle: "Folder inside the vault where recall saves new notes. Leave empty for 00 - Inbox (or vault.json).",
      placeholder: "00 - Inbox",
    },
    "",
  )
  .field(
    "userSectionHeadings",
    "stringArray",
    {
      displayName: "Sections quoted first",
      subtitle: "Headings (## Notes, ## Runbook, ...) whose text is moved to the front of each note.",
    },
    [...HOMELAB_DEFAULTS.userSectionHeadings],
  )
  .build();

export const configSchematics = createConfigSchematics()
  .field(
    "maxEntities",
    "numeric",
    {
      displayName: "Named notes per message",
      subtitle: "Most notes added because the message names them (id, title or alias).",
      int: true, min: 0, max: 10,
      slider: { min: 0, max: 10, step: 1 },
    },
    HOMELAB_DEFAULTS.maxEntities,
  )
  .field(
    "maxHopNotes",
    "numeric",
    {
      displayName: "Linked notes per message",
      subtitle: "Most notes added because a found note links to them.",
      int: true, min: 0, max: 10,
      slider: { min: 0, max: 10, step: 1 },
    },
    HOMELAB_DEFAULTS.maxHopNotes,
  )
  .field(
    "maxFuzzyNotes",
    "numeric",
    {
      displayName: "Keyword matches per message",
      subtitle: "Most notes added by keyword search when the message names no note.",
      int: true, min: 0, max: 10,
      slider: { min: 0, max: 10, step: 1 },
    },
    HOMELAB_DEFAULTS.maxFuzzyNotes,
  )
  .field(
    "totalMaxChars",
    "numeric",
    {
      displayName: "Size of the added notes (characters)",
      subtitle: "Upper limit for everything added to one message. Lower it for models with a small context.",
      int: true, min: 500, max: 40000,
      slider: { min: 500, max: 40000, step: 500 },
    },
    HOMELAB_DEFAULTS.totalMaxChars,
  )
  .build();

let settingsWarned = false;

/**
 * The settings as LM Studio holds them right now. Read on every message so a
 * change applies to the next one. If they can't be read, the answer is "no
 * settings": vault.json and the defaults still apply, the message goes through.
 */
export function readSettings(ctl: Pick<BaseController, "getPluginConfig" | "getGlobalPluginConfig">): PluginSettings {
  const out: PluginSettings = {};
  const read = (fill: () => void): void => {
    try {
      fill();
    } catch (err) {
      if (!settingsWarned) {
        settingsWarned = true;
        console.warn("[lm-recall] could not read plugin settings; using vault.json / defaults:", err);
      }
    }
  };
  read(() => {
    const global = ctl.getGlobalPluginConfig(globalConfigSchematics);
    out.vaultPath = global.get("vaultPath");
    out.permanentFolder = global.get("permanentFolder");
    out.inboxFolder = global.get("inboxFolder");
    out.userSectionHeadings = global.get("userSectionHeadings");
  });
  read(() => {
    const chat = ctl.getPluginConfig(configSchematics);
    out.maxEntities = chat.get("maxEntities");
    out.maxHopNotes = chat.get("maxHopNotes");
    out.maxFuzzyNotes = chat.get("maxFuzzyNotes");
    out.totalMaxChars = chat.get("totalMaxChars");
  });
  return out;
}
