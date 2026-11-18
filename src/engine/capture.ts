//
// Capture and promote (Phase 3c): the only code in lm-recall that writes.
//
// What it may write, and nothing else:
//   - a new inbox note in 00 - Inbox/            (recall)
//   - a new permanent zettel in cfg.permanentFolder (promote)
//   - after a successful promote, it moves the inbox note it promoted (one
//     of its own: managed_by: lm-recall) into the vault's .trash/ folder
//
// Rules (Claude.MD, "Vault rules"):
//   1. Create-only: an existing target filename is refused and reported.
//   2. Atomic: temp sibling, then link/rename into place.
//   3. A failed write returns the full note text so nothing is lost; no
//      retry; no absolute paths or stack traces in what the user sees.
//   4. promote acts only on inbox notes with managed_by: lm-recall.
//   Never deletes a note outright: the only unlinks are of our own temp
//   files and of an inbox note's original once its copy is in .trash/.
//   Links are only ever written to notes that exist.
//
// No LM Studio dependency: src/tools.ts wraps these as tools.
//

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { extractWikiLinks, walkVault, type VaultFile } from "./core";
import { findNote, stemOf, titleOf, type HomelabConfig } from "./homelab";

export const INBOX_FOLDER = "00 - Inbox";
const MANAGED_BY = "lm-recall";
const NONE_IDENTIFIED = "(none identified)";

/** What a tool call hands back to the model. */
export interface CaptureResult {
  ok: boolean;
  /** Text for the model; it relays this to the user. Never an absolute path. */
  message: string;
  /** Vault-relative path of the note written (ok only). */
  relPath?: string;
}

/* ---------------- small helpers ---------------- */

const pad = (n: number): string => String(n).padStart(2, "0");

/** YYYYMMDDHHmm in local time: the zettel id. */
function timestampId(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] {
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}

/**
 * A title that is safe as a filename and inside a [[link]]: no path
 * separators, no characters Obsidian or Windows refuse, no leading dot
 * (hidden file), one line, at most 80 characters.
 */
export function cleanTitle(raw: unknown): string {
  return str(raw)
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .slice(0, 80)
    .trim();
}

/**
 * The permanent folder as a vault-relative path, or null if it would leave
 * the vault (absolute, "..", drive letter) or is empty.
 */
export function safeFolder(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter((p) => p && p !== ".");
  if (!parts.length || /^([a-zA-Z]:|\/)/.test(raw.trim()) || parts.some((p) => p === ".." || p.startsWith("."))) {
    return null;
  }
  return parts.join("/");
}

/** Text of a `## heading` section in a note body, or "". */
function section(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

async function readVault(cfg: HomelabConfig): Promise<VaultFile[] | null> {
  if (!cfg.vaultPath) return null;
  try {
    await fs.readdir(cfg.vaultPath);
  } catch {
    return null;
  }
  return walkVault(cfg.vaultPath, { maxFileBytes: 512 * 1024 });
}

/** Turn references into [[links]] to notes that exist; the rest are reported back. */
function resolveLinks(refs: string[], files: VaultFile[], exclude: Set<VaultFile> = new Set()) {
  const links: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const f = findNote(ref, files);
    if (!f) unknown.push(ref);
    else if (!exclude.has(f)) {
      const link = `[[${stemOf(f)}]]`;
      if (!links.includes(link)) links.push(link);
    }
  }
  return { links, unknown };
}

const VAULT_ERROR =
  "Couldn't read the vault, so nothing was saved. Check the vault folder in lm-recall's settings.";

function failedWrite(content: string): CaptureResult {
  return {
    ok: false,
    message:
      "Couldn't save the note to the vault. Show the user the full note below so nothing is lost, " +
      "and tell them it was not saved:\n\n" + content,
  };
}

/* ---------------- writing ---------------- */

type CreateOutcome = "created" | "exists";

/**
 * Create `relPath` in the vault with `content`, never replacing a file.
 * Writes a temp sibling, then hard-links it into place (atomic, and fails
 * if the target exists). Filesystems without hard links fall back to an
 * existence check + rename. Throws on any other failure.
 */
async function createFile(vaultPath: string, relPath: string, content: string): Promise<CreateOutcome> {
  const abs = join(vaultPath, relPath);
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
  try {
    try {
      await fs.link(tmp, abs);
      return "created";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") return "exists";
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code ?? "")) throw err;
      try {
        await fs.access(abs);
        return "exists";
      } catch {
        await fs.rename(tmp, abs);
        return "created";
      }
    }
  } finally {
    await fs.unlink(tmp).catch(() => undefined); // our own temp file only
  }
}

const TRASH_FOLDER = ".trash";

/**
 * Move a note into the vault's .trash/ folder (where Obsidian's own delete
 * puts files): recoverable, and invisible to Obsidian and to lm-recall.
 * Never replaces a file already in .trash: a taken name gets " 1", " 2", ...
 * Hard link + unlink of the original, or exists-check + rename where hard
 * links are unsupported. Returns the vault-relative path in .trash.
 */
async function moveToTrash(vaultPath: string, relPath: string): Promise<string> {
  const src = join(vaultPath, relPath);
  const trash = join(vaultPath, TRASH_FOLDER);
  await fs.mkdir(trash, { recursive: true });
  const stem = basename(relPath).replace(/\.md$/i, "");
  for (let n = 0; n < 100; n++) {
    const name = `${n ? `${stem} ${n}` : stem}.md`;
    const dest = join(trash, name);
    try {
      await fs.link(src, dest);
      await fs.unlink(src); // the original; its content now lives in .trash
      return `${TRASH_FOLDER}/${name}`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") continue;
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code ?? "")) throw err;
      try {
        await fs.access(dest);
        continue;
      } catch {
        await fs.rename(src, dest);
        return `${TRASH_FOLDER}/${name}`;
      }
    }
  }
  throw new Error("no free name in .trash");
}

/* ---------------- recall: capture into the inbox ---------------- */

function inboxNoteText(p: {
  title: string; date: string; project: string; whatHappened: string; whyItMatters: string; links: string[];
}): string {
  const parts = [
    "---",
    `managed_by: ${MANAGED_BY}`,
    "---",
    `# ${p.title}`,
    "",
    "## Date",
    p.date,
    "",
    "## Project",
    p.project || "unknown",
    "",
    "## What happened",
    p.whatHappened,
    "",
    "## Why it matters",
    p.whyItMatters,
  ];
  if (p.links.length) parts.push("", "## Links", ...p.links.map((l) => `- ${l}`));
  return parts.join("\n") + "\n";
}

/**
 * Save a new inbox note. Params as the model sends them: title, project,
 * what_happened, why_it_matters, links (references to existing notes).
 */
export async function captureNote(
  cfg: HomelabConfig,
  params: Record<string, unknown>,
  now: Date = new Date(),
): Promise<CaptureResult> {
  const title = cleanTitle(params.title);
  const whatHappened = str(params.what_happened);
  const whyItMatters = str(params.why_it_matters);
  const missing = [!title && "title", !whatHappened && "what_happened", !whyItMatters && "why_it_matters"].filter(Boolean);
  if (missing.length) {
    return { ok: false, message: `Nothing was saved: ${missing.join(", ")} missing. Ask the user for it, then try again.` };
  }

  const files = await readVault(cfg);
  const { links, unknown } = files ? resolveLinks(strList(params.links), files) : { links: [], unknown: [] };
  const relPath = `${INBOX_FOLDER}/${timestampId(now)} ${title}.md`;
  const content = inboxNoteText({
    title, date: isoDate(now), project: str(params.project), whatHappened, whyItMatters, links,
  });
  if (!files) return { ok: false, message: `${VAULT_ERROR}\n\nThe note, so nothing is lost:\n\n${content}` };

  let outcome: CreateOutcome;
  try {
    outcome = await createFile(cfg.vaultPath, relPath, content);
  } catch (err) {
    console.error("[lm-recall] capture write failed:", err);
    return failedWrite(content);
  }
  if (outcome === "exists") {
    return {
      ok: false,
      message: `Not saved: a note named "${basename(relPath)}" is already in the inbox, and lm-recall never overwrites notes. ` +
        "Ask the user for a different title.",
    };
  }
  const skipped = unknown.length
    ? ` These links were left out because no such note exists: ${unknown.join(", ")}.`
    : "";
  return { ok: true, relPath, message: `Saved to ${relPath}.${skipped}` };
}

/* ---------------- promote: inbox note -> permanent zettel ---------------- */

/**
 * Tags as Obsidian accepts them: no leading #, spaces become -, only
 * letters, digits, _ - / kept, at least one non-digit, lower-cased,
 * de-duplicated, at most 8.
 */
export function cleanTags(raw: unknown): string[] {
  const out: string[] = [];
  for (const t of strList(raw)) {
    const tag = t.replace(/^#+/, "").trim().replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_\-/]/gu, "").replace(/^[-/]+|[-/]+$/g, "").toLowerCase();
    if (tag && !/^\d+$/.test(tag) && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 8);
}

/**
 * One line, at most 200 characters, safe inside single-quoted YAML: a ' is
 * written as the typographic ’ (single-quoted YAML has no escapes, and the
 * vault's own frontmatter readers don't unescape '').
 */
export function cleanSummary(raw: unknown): string {
  return str(raw).replace(/\s+/g, " ").replace(/'/g, "\u2019").slice(0, 200).trim();
}

export function zettelText(p: {
  title: string; idea: string; whyItMatters: string; connected: string[]; captured: string; project: string;
  tags?: string[]; summary?: string;
}): string {
  const fm: string[] = [];
  if (p.tags?.length) fm.push(`tags: [${p.tags.join(", ")}]`);
  if (p.summary) fm.push(`summary: '${p.summary}'`);
  const project = p.project && p.project.toLowerCase() !== "unknown" ? `, project: ${p.project}` : "";
  return [
    ...(fm.length ? ["---", ...fm, "---"] : []),
    `# ${p.title}`,
    "",
    "## The idea",
    p.idea,
    "",
    "## Why it matters",
    p.whyItMatters,
    "",
    "## Connected to",
    ...(p.connected.length ? p.connected.map((l) => `- ${l}`) : [NONE_IDENTIFIED]),
    "",
    "## Source",
    `Captured in LM Studio${p.captured ? ` on ${p.captured}` : ""}${project}.`,
  ].join("\n") + "\n";
}

/** The inbox note `ref` names: by filename, title or id. */
function findInboxNote(ref: string, files: VaultFile[]): { note?: VaultFile; error?: string } {
  const inbox = files.filter((f) => f.relPath.startsWith(`${INBOX_FOLDER}/`));
  const want = ref.replace(/\.md$/i, "").replace(/^\[\[|\]\]$/g, "").trim().toLowerCase();
  const matches = inbox.filter((f) =>
    stemOf(f).toLowerCase() === want ||
    titleOf(f).toLowerCase() === want ||
    stemOf(f).toLowerCase().startsWith(`${want} `)); // the id alone
  if (!matches.length) {
    const anywhere = findNote(ref, files);
    if (anywhere && !inbox.includes(anywhere)) {
      return { error: `"${ref}" is not an inbox note. Only notes saved with recall (in ${INBOX_FOLDER}) can be promoted.` };
    }
    return { error: `No inbox note called "${ref}" was found.` };
  }
  if (matches.length > 1) {
    return { error: `More than one inbox note matches "${ref}": ${matches.map(stemOf).join("; ")}. Ask the user which one.` };
  }
  return { note: matches[0] };
}

/**
 * Promote an inbox note. Params as the model sends them: note (which inbox
 * note), title, idea, why_it_matters, connected_to, tags, summary (both
 * optional: written as frontmatter only when given). Missing text falls back
 * to the inbox note's own sections; connected_to adds to its links.
 */
export async function promoteNote(
  cfg: HomelabConfig,
  params: Record<string, unknown>,
  now: Date = new Date(),
): Promise<CaptureResult> {
  const ref = str(params.note);
  if (!ref) return { ok: false, message: "Nothing was promoted: say which inbox note to promote." };
  const folder = safeFolder(cfg.permanentFolder);
  if (!folder || folder === INBOX_FOLDER) {
    return { ok: false, message: "Nothing was promoted: the permanent folder in lm-recall's settings must be a folder inside the vault, other than the inbox." };
  }

  const files = await readVault(cfg);
  if (!files) return { ok: false, message: VAULT_ERROR };
  const { note, error } = findInboxNote(ref, files);
  if (!note) return { ok: false, message: `Nothing was promoted: ${error}` };
  if (note.fm.managed_by !== MANAGED_BY) {
    return { ok: false, message: `Nothing was promoted: "${stemOf(note)}" was not created by lm-recall, so lm-recall won't touch it.` };
  }
  if (note.fm.promoted_to !== undefined) { // marked by lm-recall before inbox notes moved to .trash
    return { ok: false, message: `Nothing was promoted: "${stemOf(note)}" was already promoted to ${String(note.fm.promoted_to)}.` };
  }

  const title = cleanTitle(params.title) || cleanTitle(titleOf(note));
  const idea = str(params.idea) || section(note.body, "What happened");
  const whyItMatters = str(params.why_it_matters) || section(note.body, "Why it matters");
  if (!title || !idea || !whyItMatters) {
    return { ok: false, message: "Nothing was promoted: the zettel needs a title, the idea and why it matters. Ask the user for them." };
  }
  const refs = [...extractWikiLinks(section(note.body, "Links")), ...strList(params.connected_to)];
  const { links, unknown } = resolveLinks(refs, files, new Set([note]));

  const stem = `${timestampId(now)} ${title}`;
  const relPath = `${folder}/${stem}.md`;
  const content = zettelText({
    title, idea, whyItMatters, connected: links,
    captured: section(note.body, "Date"), project: section(note.body, "Project"),
    tags: cleanTags(params.tags), summary: cleanSummary(params.summary),
  });

  let outcome: CreateOutcome;
  try {
    outcome = await createFile(cfg.vaultPath, relPath, content);
  } catch (err) {
    console.error("[lm-recall] promote write failed:", err);
    return failedWrite(content);
  }
  if (outcome === "exists") {
    return {
      ok: false,
      message: `Not promoted: a note named "${stem}.md" already exists in ${folder}, and lm-recall never overwrites notes. Ask the user for a different title.`,
    };
  }

  // Only now, with the zettel safely written, does the inbox note go.
  let moved = "";
  try {
    moved = await moveToTrash(cfg.vaultPath, note.relPath);
  } catch (err) {
    console.error("[lm-recall] could not move inbox note to .trash:", err);
  }
  const skipped = unknown.length ? ` Left out as links because no such note exists: ${unknown.join(", ")}.` : "";
  const inbox = moved
    ? ` The inbox note was moved to the vault's ${TRASH_FOLDER} folder (recoverable from there).`
    : " The inbox note could not be moved to .trash and is still in the inbox; the user can delete it in Obsidian.";
  return { ok: true, relPath, message: `Promoted to ${relPath}.${inbox}${skipped}` };
}
