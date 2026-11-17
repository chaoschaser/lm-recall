//
// The one line lm-recall shows in the chat after looking at the vault.
//
// Pure text decisions, no LM Studio dependency: the preprocessor hands the
// result to ctl.createStatus(). Rules: never a file path, never a stack
// trace, and nothing at all when the vault is fine but no note matched.
//

import type { RecallResult } from "./homelab";

export interface StatusLine {
  status: "done" | "error";
  text: string;
}

/** Titles listed by name before the rest is summed up as "and N more". */
const MAX_TITLES = 6;

export const STATUS_UNREADABLE =
  "Couldn't read your vault — message sent without notes. Check the vault folder in lm-recall's settings.";
export const STATUS_UNSET =
  "No vault is set — message sent without notes. Set the vault folder in lm-recall's settings.";
export const STATUS_EMPTY =
  "Welcome to lm-recall. Your vault has no notes yet — once it does, the relevant ones are added to your messages.";

export function statusFor(result: RecallResult): StatusLine | null {
  if (result.vault === "unreadable") return { status: "error", text: STATUS_UNREADABLE };
  if (result.vault === "unset") return { status: "error", text: STATUS_UNSET };
  if (result.vault === "empty") return { status: "done", text: STATUS_EMPTY };

  const n = result.notes.length;
  if (n === 0) return null;
  const titles = result.notes.slice(0, MAX_TITLES).map((note) => note.title);
  const more = n - titles.length;
  const list = more > 0 ? `${titles.join(", ")} and ${more} more` : titles.join(", ");
  return { status: "done", text: `Added ${n} ${n === 1 ? "note" : "notes"}: ${list}` };
}
