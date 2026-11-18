import { promises as fs } from "node:fs";
import * as path from "node:path";

/* ---------- Frontmatter: tolerant hand-rolled parser ----------
 * Handles: `key: value`, `key: [a, b]`, quoted strings, bare scalars,
 * and block lists — `- item` lines, indented OR flush at column zero
 * (the real vault uses column-zero, standard YAML style).
 * Returns {} when no frontmatter block is present. */
export interface Frontmatter {
  [key: string]: string | string[];
}

/** A lone, unquoted wikilink: `[[3 - Containers/ct-110|Downloader]]`.
 * Starts with "[" and ends with "]" but is a scalar, not a flow list. */
const LONE_WIKILINK = /^\[\[[^\[\]]*\]\]$/;

/** Strip one matching pair of surrounding quotes. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Split the inside of a YAML flow list on top-level commas only:
 * commas inside quotes or inside [[wikilinks]] / nested brackets are
 * kept. `a, "b, c", [[x|y]]` -> ["a", "b, c", "[[x|y]]"].
 */
function splitFlowList(inner: string): string[] {
  const items: string[] = [];
  let buf = "";
  let quote: string | null = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "[") {
      depth++;
      buf += ch;
    } else if (ch === "]") {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (ch === "," && depth === 0) {
      items.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  items.push(buf);
  return items.map(unquote).filter((s) => s.length > 0);
}

export function parseFrontmatter(raw: string): Frontmatter {
  const fm: Frontmatter = {};
  if (!raw.startsWith("---")) return fm;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return fm;
  const block = raw.slice(4, end); // skip opening "---\n"
  let currentKey: string | null = null;
  // YAML block scalar in progress (`summary: >-` / `notes: |`): its
  // indented lines are collected, then folded (>) or kept as lines (|).
  let scalar: { key: string; folded: boolean; lines: string[] } | null = null;
  const flushScalar = () => {
    if (!scalar) return;
    const text = scalar.folded
      ? scalar.lines.map((l) => l.trim()).join(" ").replace(/\s+/g, " ")
      : scalar.lines.map((l) => l.replace(/^\s{1,2}/, "")).join("\n");
    if (text.trim()) fm[scalar.key] = text.trim();
    scalar = null;
  };

  // Strip a trailing \r per line: with CRLF files the last frontmatter
  // line keeps its \r (the closing "\n---" is the split point), and `.`
  // does not match \r — so the last key was silently dropped.
  for (const line of block.split(/\r?\n/).map((l) => l.replace(/\r$/, ""))) {
    if (scalar) {
      if (line.trim() === "" || /^\s/.test(line)) {
        scalar.lines.push(line);
        continue;
      }
      flushScalar();
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      let val = kv[2].trim();
      currentKey = key;
      if (/^[|>][+-]?\d?$/.test(val)) {
        scalar = { key, folded: val.startsWith(">"), lines: [] };
        continue;
      }
      if (val.length === 0) {
        fm[key] = []; // block list header — items may follow
        continue;
      }
      if (val.startsWith("[") && val.endsWith("]") && !LONE_WIKILINK.test(val)) {
        fm[key] = splitFlowList(val.slice(1, -1));
      } else {
        val = val.replace(/^["']|["']$/g, "");
        if (val.length > 0) fm[key] = val;
      }
      continue;
    }
    // v2.1 FIX: \s* (not \s+) — list items may sit at column zero
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && currentKey !== null) {
      const arr = Array.isArray(fm[currentKey])
        ? (fm[currentKey] as string[])
        : [];
      arr.push(li[1].trim().replace(/^["']|["']$/g, ""));
      fm[currentKey] = arr;
    }
  }
  flushScalar();
  return fm;
}

/** Body = everything below the closing frontmatter `---`. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  return raw.slice(end + 4);
}

/* ---------- Vault walking ---------- */
export interface VaultFile {
  absPath: string;
  relPath: string;
  raw: string;
  fm: Frontmatter;
  body: string;
}

export interface WalkOptions {
  /** Substring filters on the vault-relative path; file is skipped if any matches (case-insensitive). */
  excludeNamePatterns?: string[];
  maxFileBytes: number;
}

/** Skipped folders besides dot-folders (.obsidian, .git, .trash, ...), which walk() always skips. */
const EXCLUDE_DIRS = ["node_modules"];

export async function walkVault(
  vaultPath: string,
  opts: WalkOptions,
): Promise<VaultFile[]> {
  const files: Array<{ absPath: string; relPath: string }> = [];
  await walk(vaultPath, vaultPath, files, opts, 0);

  const out: VaultFile[] = [];
  for (const f of files) {
    let stat;
    try {
      stat = await fs.stat(f.absPath);
    } catch {
      continue;
    }
    if (stat.size > opts.maxFileBytes) continue;
    let raw: string;
    try {
      raw = await fs.readFile(f.absPath, "utf-8");
    } catch {
      continue;
    }
    out.push({
      absPath: f.absPath,
      relPath: f.relPath,
      raw,
      fm: parseFrontmatter(raw),
      body: stripFrontmatter(raw),
    });
  }
  return out;
}

async function walk(
  dir: string,
  base: string,
  out: Array<{ absPath: string; relPath: string }>,
  opts: WalkOptions,
  depth: number,
): Promise<void> {
  if (depth > 8) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || EXCLUDE_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, out, opts, depth + 1);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const rel = path.relative(base, full).replaceAll("\\", "/");
      const patterns = opts.excludeNamePatterns ?? [];
      if (patterns.some((p) => rel.toLowerCase().includes(p.toLowerCase()))) {
        continue;
      }
      out.push({ absPath: full, relPath: rel });
    }
  }
}

/* ---------- Excerpting ---------- */
/** Extract every [[wiki-link]] target from a string (deduped). */
export function extractWikiLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    out.add(m[1].trim());
  }
  return [...out];
}

/**
 * v2.2: Strip syncer reference blocks from a body, in BOTH forms the
 * vault uses:
 *   1. HTML-comment markers (actual form emitted by pve_sync /
 *      opnsense_sync): <!-- pve-sync:begin:references --> …
 *      <!-- pve-sync:end:references -->  — including any
 *      > [!info]- callouts inside the span.
 *   2. Code-fence form (legacy/alternate): ```pve-sync … ```
 * Marker token = the lane namespace ("pve-sync", "opnsense-sync").
 */
export function stripMarkerFences(body: string, tokens: string[]): string {
  let out = body;
  for (const raw of tokens) {
    const token = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // HTML-comment marker form (vault reality). A span must START at a
    // `begin` marker: a stray `end` marker must never anchor a match, or
    // everything between it and a later block's `end` (user text) would
    // be stripped. Unpaired markers are left in place, never guessed at.
    out = out.replace(
      new RegExp(
        `<!--\\s*${token}:begin:[^>]*-->[\\s\\S]*?<!--\\s*${token}:end:[^>]*-->\\s*`,
        "g",
      ),
      "",
    );
    // code-fence form (kept for compatibility)
    out = out.replace(
      new RegExp("```" + token + "\\s*\\n[\\s\\S]*?\\n```\\s*", "g"),
      "",
    );
  }
  return out;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on",
  "for", "with", "is", "are", "was", "were", "be", "it", "this", "that",
  "i", "you", "we", "they", "my", "your", "our", "me", "do", "does",
  "can", "could", "should", "would", "will", "what", "which", "how",
  "why", "when", "where", "as", "by", "from", "not", "no", "about",
  "into", "than", "then", "there", "here", "have", "has", "had",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}
