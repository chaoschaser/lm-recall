import {
  type PromptPreprocessorController,
  type ChatMessage,
} from "@lmstudio/sdk";
import { recall, renderContext, notesInText, type HomelabConfig } from "./engine/homelab";
import { statusFor, STATUS_UNREADABLE, type StatusLine } from "./engine/status";

const FORCE = "@vault";   // re-add every relevant note, even ones already in the chat
const DISABLE = "@novault"; // add nothing to this message

let historyWarned = false;

/**
 * Notes this chat already holds, read from the context blocks in earlier
 * messages: relPath -> version. Later messages win, so a note re-added after
 * it changed counts at its newest version. Returns an empty map if the
 * history can't be read (then everything relevant is added, as a fallback).
 */
async function notesAlreadyInChat(ctl: PromptPreprocessorController): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  try {
    const history = await ctl.pullHistory();
    for (const msg of history.getMessagesArray()) {
      if (msg.getRole() !== "user") continue;
      for (const [path, version] of notesInText(msg.getText())) seen.set(path, version);
    }
  } catch (err) {
    if (!historyWarned) {
      historyWarned = true;
      console.warn("[lm-recall] could not read chat history; notes may repeat:", err);
    }
  }
  return seen;
}

/**
 * Show one status line in the chat. Reporting is a courtesy: if LM Studio
 * refuses it, the message must still go through.
 */
function report(ctl: PromptPreprocessorController, line: StatusLine | null): void {
  if (!line) return;
  try {
    ctl.createStatus({ status: line.status, text: line.text });
  } catch (err) {
    console.warn("[lm-recall] could not show status in chat:", err);
  }
}

/**
 * Build the prompt preprocessor. The config is read on every message (not
 * captured once) so a settings change applies to the next message.
 */
export function createPreprocessor(
  getConfig: (ctl: PromptPreprocessorController) => HomelabConfig,
) {
  // The empty-vault welcome is shown once per plugin run, not on every message.
  let welcomed = false;

  return async function preprocess(
    ctl: PromptPreprocessorController,
    userMessage: ChatMessage,
  ): Promise<string> {
    const original = userMessage.getText();

    if (original.includes(DISABLE)) {
      return original.replaceAll(DISABLE, "").trim();
    }

    const forced = original.includes(FORCE);
    const cleaned = forced ? original.replaceAll(FORCE, "").trim() : original;

    let cfg: HomelabConfig;
    let result;
    try {
      cfg = getConfig(ctl);
      const alreadyInChat = forced ? new Map<string, string>() : await notesAlreadyInChat(ctl);
      result = await recall(cleaned, cfg, { alreadyInChat });
    } catch (err) {
      console.error("[lm-recall] vault read failed:", err);
      report(ctl, { status: "error", text: STATUS_UNREADABLE });
      return cleaned;
    }

    console.log(
      `[lm-recall] vault=${cfg.vaultPath} (${result.vault}) forced=${forced} added=${result.notes.length}`,
      result.notes.map((n) => `${n.kind}:${n.relPath}`),
      result.skipped.length ? `already in chat: ${JSON.stringify(result.skipped)}` : "",
    );

    if (result.vault === "empty") {
      if (!welcomed) report(ctl, statusFor(result));
      welcomed = true;
    } else {
      report(ctl, statusFor(result));
    }

    if (result.notes.length === 0) return cleaned;
    return `${renderContext(result.notes)}\n\n${cleaned}`;
  };
}
