// lm-recall behaviour tests. Run with: npm test
// (builds with tsc, then runs these against dist/ and the sample vault in
// test/fixtures/vault). Uses only Node's built-in test runner.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { parseFrontmatter, stripMarkerFences } = require("../dist/engine/core.js");
const { recall, renderContext, notesInText, HOMELAB_DEFAULTS } = require("../dist/engine/homelab.js");

const VAULT = path.join(__dirname, "fixtures", "vault");
const OWD = "Zettels/202611171254 Dive certification.md";
const REEF = "Zettels/202611101030 Reef survey project.md";
const SAFETY = "Zettels/202611120915-safety-stop-procedure.md";
const SKIPPER = "Zettels/202610020815.md";
const FIRSTAID = "Zettels/202609141130 First aid.md";
const CERTS = "Zettels/Certifications.md";
const MEDIA = "3 - Containers/ct-101.md";
const HV2 = "1 - Nodes/node-hv2.md";
const NAS = "4 - Storage/storage-nas.md";
const VLAN40 = "5 - Networks/net-vlan40.md";

async function ask(message, overrides = {}, opts = {}) {
  const { notes, skipped } = await recall(message, { ...HOMELAB_DEFAULTS, vaultPath: VAULT, ...overrides }, opts);
  const note = (p) => notes.find((n) => n.relPath === p);
  return { notes, skipped, paths: notes.map((n) => n.relPath), note };
}

/** Simulate a chat: the context block an earlier answer to `message` added. */
async function chatAfter(message) {
  const { notes } = await ask(message);
  return notesInText(`${renderContext(notes)}\n\n${message}`);
}

/* ---------------- frontmatter parser ---------------- */

test("parser: flow lists split on top-level commas only", () => {
  const fm = parseFrontmatter('---\naliases: [Mediastack, mediastack, "old, name"]\ntags: [a,b]\n---\n');
  assert.deepEqual(fm.aliases, ["Mediastack", "mediastack", "old, name"]);
  assert.deepEqual(fm.tags, ["a", "b"]);
});

test("parser: a lone unquoted wikilink is one value, a list of them is a list", () => {
  const fm = parseFrontmatter(
    "---\nconnects_to: [[3 - Containers/ct-110|X]]\nroutes_for: [[[a|A]], [[b|B]]]\nempty: []\n---\n",
  );
  assert.equal(fm.connects_to, "[[3 - Containers/ct-110|X]]");
  assert.deepEqual(fm.routes_for, ["[[a|A]]", "[[b|B]]"]);
  assert.deepEqual(fm.empty, []);
});

test("parser: CRLF files keep their last key", () => {
  const fm = parseFrontmatter("---\r\nid: ct/101\r\nname: Mediaserver\r\n---\r\nbody");
  assert.equal(fm.id, "ct/101");
  assert.equal(fm.name, "Mediaserver");
});

test("parser: block lists, indented or flush", () => {
  const fm = parseFrontmatter("---\nvlans:\n- 20\n  - '30'\nname: x\n---\n");
  assert.deepEqual(fm.vlans, ["20", "30"]);
  assert.equal(fm.name, "x");
});

test("parser: YAML block scalars (folded > and literal |)", () => {
  const fm = parseFrontmatter(
    "---\nsummary: >-\n  line one\n  line two\nnotes: |\n  a\n  b\nafter: yes\n---\n",
  );
  assert.equal(fm.summary, "line one line two");
  assert.equal(fm.notes, "a\nb");
  assert.equal(fm.after, "yes");
});

/* ---------------- marker blocks ---------------- */

test("markers: a block is removed, text outside it is kept", () => {
  const B = "<!-- pve-sync:begin:references -->", E = "<!-- pve-sync:end:references -->";
  assert.equal(stripMarkerFences(`keep\n${B}\nx\n${E}\n`, ["pve-sync"]), "keep\n");
});

test("markers: a stray end marker never eats user text", () => {
  const B = "<!-- pve-sync:begin:references -->", E = "<!-- pve-sync:end:references -->";
  const out = stripMarkerFences(`A\n${E}\nUSER TEXT\n${B}\nx\n${E}\nZ`, ["pve-sync"]);
  assert.match(out, /USER TEXT/);
  assert.doesNotMatch(out, /\nx\n/);
});

/* ---------------- zettel: finding notes ---------------- */

test("zettel: found by alias; frontmatter facts and folded summary shown", async () => {
  const { paths, note } = await ask("when does my OWD expire?");
  assert.equal(paths[0], OWD);
  assert.equal(note(OWD).kind, "entity");
  assert.match(note(OWD).excerpt, /expires: 2029-05-01/);
  assert.match(note(OWD).excerpt, /summary: Open Water Diver; renewal needs a refresher dive\./);
});

test("zettel: found by timestamp id in the filename (dash separator)", async () => {
  const { paths } = await ask("what's in 202611120915?");
  assert.equal(paths[0], SAFETY);
});

test("zettel: found by id when the filename is only the id", async () => {
  const { paths, note } = await ask("tell me about 202610020815");
  assert.equal(paths[0], SKIPPER);
  assert.equal(note(SKIPPER).title, "Skipper licence");
});

test("zettel: found by its # title", async () => {
  const { paths } = await ask("notes on the Skipper licence exam");
  assert.equal(paths[0], SKIPPER);
});

test("zettel: found by the title part of an 'id title' filename", async () => {
  const { paths } = await ask("tell me about the reef survey project");
  assert.equal(paths[0], REEF);
});

test("zettel: found by frontmatter title: and alias:", async () => {
  assert.equal((await ask("is my First aid certificate still valid")).paths[0], FIRSTAID);
  assert.equal((await ask("first aid cert renewal")).paths[0], FIRSTAID);
});

test("zettel: generic titles like 'Index' are not names", async () => {
  const { notes } = await ask("show me the index");
  assert.ok(notes.every((n) => n.kind !== "entity"));
});

/* ---------------- zettel: links ---------------- */

test("links: body [[links]] are followed, incl. [[id#heading]] and backlinks via [[id]]", async () => {
  const { paths, note } = await ask("when does my OWD expire?");
  assert.ok(paths.includes(REEF), "linked note (alias link) added");
  assert.ok(paths.includes(SAFETY), "[[202611120915#Ascent]] resolved to the dash-named note");
  assert.match(note(OWD).excerpt, /Linked from: [^\n]*Reef survey project/, "[[202611171254]] counts as a backlink");
});

test("links: a structure note brings in what it lists, incl. markdown links", async () => {
  const { paths, note } = await ask("which certifications do I have");
  assert.equal(paths[0], CERTS);
  assert.equal(note(CERTS).kind, "entity");
  for (const p of [OWD, SKIPPER, FIRSTAID]) assert.ok(paths.includes(p), `${p} added`);
});

test("links: links inside code blocks and inline code are ignored", async () => {
  const { note } = await ask("is my First aid certificate still valid");
  assert.doesNotMatch(note(FIRSTAID).excerpt, /Scratch/);
});

/* ---------------- keyword search ---------------- */

test("keywords: plurals match ('certs' -> cert notes) and the structure note ranks first", async () => {
  const { paths, notes } = await ask("what certs do i have");
  assert.equal(paths[0], CERTS);
  assert.equal(notes[0].kind, "fuzzy");
  for (const p of [OWD, SKIPPER, FIRSTAID]) assert.ok(paths.includes(p), `${p} added`);
});

test("generated pages: Overview.md, Lab Overview.md and changelogs are never included", async () => {
  for (const q of ["what certs do i have", "should I restart mediaserver?", "is my First aid certificate still valid"]) {
    const { paths, note } = await ask(q, { maxHopNotes: 6 });
    assert.ok(paths.every((p) => !p.startsWith("0 - Meta/")), q);
    for (const n of paths.map(note)) assert.doesNotMatch(n.excerpt, /Homelab overview/, q);
  }
});

test("links: links inside tables (escaped pipe) are followed", async () => {
  const { paths } = await ask("which certifications do I have", { maxHopNotes: 6 });
  assert.ok(paths.includes(REEF), "[[...\\|label]] in a table resolved");
});

/* ---------------- homelab ---------------- */

test("homelab: guest facts, runbook kept, placeholder and syncer text dropped", async () => {
  const { paths, note } = await ask("should I restart mediaserver?");
  assert.equal(paths[0], MEDIA);
  const ex = note(MEDIA).excerpt;
  assert.match(ex, /passthrough: dev0 \/dev\/dri\/renderD128/);
  assert.match(ex, /disks: mp0 bind/);
  assert.match(ex, /Stop transcodes before restarting/);
  assert.match(ex, /Dependencies: none recorded/);
  assert.doesNotMatch(ex, /purpose, quirks/);
  assert.doesNotMatch(ex, /SYNCER-ONLY TEXT/);
  assert.ok(paths.includes(VLAN40), "network it rides added");
});

test("homelab: found by slash id and by id-filename", async () => {
  assert.equal((await ask("status of ct/101")).paths[0], MEDIA);
  assert.equal((await ask("status of ct-101")).paths[0], MEDIA);
});

test("homelab: warnings for offline node, stale sync, inactive storage", async () => {
  const { note } = await ask("is hv2 ok and what about storage/nas");
  assert.ok(note(HV2).warnings.some((w) => w.startsWith("NODE IS OFFLINE")));
  assert.ok(note(HV2).warnings.some((w) => w.startsWith("SYNC STALE")));
  assert.ok(note(NAS).warnings.includes("STORAGE INACTIVE at last sync"));
});

test("homelab: VLAN stub shows its facts", async () => {
  const { note } = await ask("what is net/vlan40");
  assert.match(note(VLAN40).excerpt, /kind: vlan, vlan_id: 40/);
});

/* ---------------- limits and failure modes ---------------- */

test("limits: with maxEntities 1 the first-mentioned note wins", async () => {
  const a = await ask("restart mediaserver, also hv2", { maxEntities: 1 });
  assert.equal(a.paths[0], MEDIA);
  assert.ok(!a.paths.includes(HV2));
  const b = await ask("hv2, then mediaserver", { maxEntities: 1 });
  assert.equal(b.paths[0], HV2);
  assert.ok(!b.paths.includes(VLAN40), "an entity past the cap pulls in no links");
});

test("limits: total size stays within totalMaxChars", async () => {
  const { notes } = await ask("what certs do i have", { totalMaxChars: 1500 });
  const total = notes.reduce((n, x) => n + x.excerpt.length, 0);
  assert.ok(total <= 1500 + 10, `total ${total}`);
});

test("failure: a missing or unset vault adds nothing and does not throw", async () => {
  assert.equal((await ask("OWD", { vaultPath: "" })).notes.length, 0);
  assert.equal((await ask("OWD", { vaultPath: path.join(VAULT, "nope") })).notes.length, 0);
});

/* ---------------- notes already in the chat ---------------- */

test("chat: the context block round-trips (paths and versions read back)", async () => {
  const { notes } = await ask("should I restart mediaserver?");
  const seen = notesInText(renderContext(notes));
  assert.deepEqual([...seen.keys()], notes.map((n) => n.relPath));
  for (const n of notes) assert.equal(seen.get(n.relPath), n.version);
});

test("chat: headers from older plugin versions (no v:) are still recognised", () => {
  const old = "=== VAULT CONTEXT (auto-injected by lm-recall) ===\n" +
    "--- 1. Mediaserver (3 - Containers/ct-101.md) [entity]\n⚠ X ---\nFacts: ...\n=== END VAULT CONTEXT ===";
  assert.equal(notesInText(old).get(MEDIA), "");
});

test("chat: text without a context block yields nothing", () => {
  assert.equal(notesInText("--- 1. x (a.md) [named] v:abc ---").size, 0);
});

test("chat: a note already in the chat is not added again; its links still are", async () => {
  const already = new Map([[MEDIA, (await ask("mediaserver")).note(MEDIA).version]]);
  const { paths, skipped } = await ask("should I restart mediaserver?", {}, { alreadyInChat: already });
  assert.ok(!paths.includes(MEDIA));
  assert.ok(skipped.includes(MEDIA));
  assert.ok(paths.includes(VLAN40), "link of the skipped note still added");
});

test("chat: asking the same thing twice adds nothing the second time", async () => {
  const already = await chatAfter("should I restart mediaserver?");
  const { notes } = await ask("should I restart mediaserver?", {}, { alreadyInChat: already });
  assert.equal(notes.length, 0);
});

test("chat: a new topic in the same chat still gets its notes", async () => {
  const already = await chatAfter("should I restart mediaserver?");
  const { paths } = await ask("when does my OWD expire?", {}, { alreadyInChat: already });
  assert.equal(paths[0], OWD);
});

test("chat: only the new note of a mixed question is added", async () => {
  const already = await chatAfter("should I restart mediaserver?");
  const { paths } = await ask("mediaserver and hv2", {}, { alreadyInChat: already });
  assert.ok(paths.includes(HV2));
  assert.ok(!paths.includes(MEDIA));
});

test("chat: a note that changed since it was added is added again", async () => {
  const already = new Map([[MEDIA, "00000000"]]);
  const { paths } = await ask("should I restart mediaserver?", {}, { alreadyInChat: already });
  assert.equal(paths[0], MEDIA);
});

test("chat: a structure note already in the chat still leads to what it lists", async () => {
  const already = new Map([[CERTS, ""]]);
  const { paths } = await ask("what certs do i have", {}, { alreadyInChat: already });
  assert.ok(!paths.includes(CERTS));
  for (const p of [OWD, SKIPPER, FIRSTAID]) assert.ok(paths.includes(p), `${p} added`);
});

/* ---------------- status line in the chat (Phase 3a) ---------------- */

const { statusFor } = require("../dist/engine/status.js");
const { createPreprocessor } = require("../dist/promptPreprocessor.js");
const fs = require("node:fs");
const os = require("node:os");

/** A stand-in for LM Studio's controller: records status lines, empty history. */
function fakeCtl({ failStatus = false } = {}) {
  const statuses = [];
  return {
    statuses,
    pullHistory: async () => ({ getMessagesArray: () => [] }),
    createStatus: (s) => {
      if (failStatus) throw new Error("no status for you");
      statuses.push(s);
      return { setState() {}, setText() {}, remove() {} };
    },
  };
}
const msg = (text) => ({ getText: () => text });
const preprocessorFor = (vaultPath) => createPreprocessor(() => ({ ...HOMELAB_DEFAULTS, vaultPath }));

test("status: recall reports the vault state", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lm-recall-empty-"));
  try {
    assert.equal((await recall("OWD", { ...HOMELAB_DEFAULTS, vaultPath: VAULT })).vault, "ok");
    assert.equal((await recall("OWD", { ...HOMELAB_DEFAULTS, vaultPath: "" })).vault, "unset");
    assert.equal((await recall("OWD", { ...HOMELAB_DEFAULTS, vaultPath: path.join(VAULT, "nope") })).vault, "unreadable");
    assert.equal((await recall("OWD", { ...HOMELAB_DEFAULTS, vaultPath: path.join(VAULT, OWD) })).vault, "unreadable");
    assert.equal((await recall("OWD", { ...HOMELAB_DEFAULTS, vaultPath: empty })).vault, "empty");
  } finally {
    fs.rmSync(empty, { recursive: true });
  }
});

test("status: success names the notes that were added", async () => {
  const ctl = fakeCtl();
  const out = await preprocessorFor(VAULT)(ctl, msg("how is my Dive certification going?"));
  assert.ok(out.includes("=== VAULT CONTEXT"));
  assert.equal(ctl.statuses.length, 1);
  assert.equal(ctl.statuses[0].status, "done");
  assert.match(ctl.statuses[0].text, /^Added \d+ notes?: .*Dive certification/);
});

test("status: one note is singular; a long list ends in 'and N more'", () => {
  const note = (title) => ({ title, relPath: `${title}.md`, kind: "entity", version: "0", warnings: [], excerpt: "" });
  const one = statusFor({ vault: "ok", skipped: [], notes: [note("ct-101")] });
  assert.deepEqual(one, { status: "done", text: "Added 1 note: ct-101" });
  const many = statusFor({ vault: "ok", skipped: [], notes: "abcdefgh".split("").map(note) });
  assert.equal(many.text, "Added 8 notes: a, b, c, d, e, f and 2 more");
});

test("status: nothing is shown when no note matches, or with @novault", async () => {
  const ctl = fakeCtl();
  const pre = preprocessorFor(VAULT);
  assert.equal(await pre(ctl, msg("zzzqqq xyzzy")), "zzzqqq xyzzy");
  assert.equal(await pre(ctl, msg("OWD @novault")), "OWD");
  assert.deepEqual(ctl.statuses, []);
});

test("status: an unreadable or unset vault shows a friendly error; the message still goes through", async () => {
  const missing = path.join(VAULT, "nope");
  for (const vaultPath of [missing, ""]) {
    const ctl = fakeCtl();
    assert.equal(await preprocessorFor(vaultPath)(ctl, msg("OWD")), "OWD");
    assert.equal(ctl.statuses.length, 1);
    assert.equal(ctl.statuses[0].status, "error");
    assert.match(ctl.statuses[0].text, /message sent without notes/);
    assert.ok(!ctl.statuses[0].text.includes(missing), "no file path in status text");
    assert.ok(!/\n|\bat \S+ \(/.test(ctl.statuses[0].text), "no stack trace in status text");
  }
});

test("status: a config that throws is reported like an unreadable vault", async () => {
  const ctl = fakeCtl();
  const pre = createPreprocessor(() => { throw new Error("/secret/path exploded"); });
  assert.equal(await pre(ctl, msg("OWD")), "OWD");
  assert.equal(ctl.statuses[0].status, "error");
  assert.ok(!ctl.statuses[0].text.includes("/secret/path"));
});

test("status: an empty vault gets a welcome line, once", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lm-recall-empty-"));
  try {
    const ctl = fakeCtl();
    const pre = preprocessorFor(empty);
    assert.equal(await pre(ctl, msg("hello")), "hello");
    assert.equal(await pre(ctl, msg("hello again")), "hello again");
    assert.equal(ctl.statuses.length, 1);
    assert.equal(ctl.statuses[0].status, "done");
    assert.match(ctl.statuses[0].text, /^Welcome/);
  } finally {
    fs.rmSync(empty, { recursive: true });
  }
});

test("status: if the status line can't be shown, the notes are still added", async () => {
  const out = await preprocessorFor(VAULT)(fakeCtl({ failStatus: true }), msg("Dive certification"));
  assert.ok(out.includes("=== VAULT CONTEXT"));
});

/* ---------------- plugin settings (Phase 3b) ---------------- */

const { applySettings } = require("../dist/engine/settings.js");

// What vault.json / LM_RECALL_VAULT / the defaults resolved to.
const BASE = { ...HOMELAB_DEFAULTS, vaultPath: "/from/vault-json", maxHopNotes: 5, userSectionHeadings: ["Howto"] };
// What LM Studio returns when the user has touched nothing.
const UNTOUCHED = {
  vaultPath: "", permanentFolder: "", inboxFolder: "", userSectionHeadings: ["Notes", "Runbook"],
  maxEntities: 3, maxHopNotes: 3, maxFuzzyNotes: 2, totalMaxChars: 6000,
};

test("settings: untouched settings leave vault.json values alone", () => {
  assert.deepEqual(applySettings(BASE, UNTOUCHED), BASE);
  assert.deepEqual(applySettings(BASE, {}), BASE);
});

test("settings: a vault folder set in the settings wins over vault.json", () => {
  assert.equal(applySettings(BASE, { ...UNTOUCHED, vaultPath: "  /from/settings  " }).vaultPath, "/from/settings");
  assert.equal(applySettings(BASE, { ...UNTOUCHED, vaultPath: "   " }).vaultPath, "/from/vault-json");
  assert.equal(applySettings(BASE, { vaultPath: "~/vault" }).vaultPath, path.join(os.homedir(), "vault"));
});

test("settings: changed limits and headings win; invalid values are ignored", () => {
  const cfg = applySettings(BASE, {
    ...UNTOUCHED, maxHopNotes: 0, maxEntities: 1, totalMaxChars: 2000, userSectionHeadings: [" Fixes ", ""],
  });
  assert.equal(cfg.maxHopNotes, 0);
  assert.equal(cfg.maxEntities, 1);
  assert.equal(cfg.totalMaxChars, 2000);
  assert.deepEqual(cfg.userSectionHeadings, ["Fixes"]);
  const bad = applySettings(BASE, { maxHopNotes: -1, maxEntities: 1.5, maxFuzzyNotes: NaN, totalMaxChars: "9", userSectionHeadings: [] });
  assert.deepEqual(bad, BASE);
});

test("settings: applySettings never changes the base config", () => {
  const before = JSON.stringify(BASE);
  applySettings(BASE, { vaultPath: "/x", maxHopNotes: 9, userSectionHeadings: ["A"] });
  assert.equal(JSON.stringify(BASE), before);
});

test("settings: the preprocessor asks for the config on every message, with the controller", async () => {
  const ctl = fakeCtl();
  let vaultPath = path.join(VAULT, "nope");
  const seen = [];
  const pre = createPreprocessor((c) => { seen.push(c); return { ...HOMELAB_DEFAULTS, vaultPath }; });
  assert.equal(await pre(ctl, msg("Dive certification")), "Dive certification");
  vaultPath = VAULT; // the user fixes the folder in the settings
  assert.ok((await pre(ctl, msg("Dive certification"))).includes("=== VAULT CONTEXT"));
  assert.deepEqual(seen, [ctl, ctl]);
  assert.deepEqual(ctl.statuses.map((s) => s.status), ["error", "done"]);
});

test("settings: the settings pages build and read back through the controller", () => {
  const { readSettings, configSchematics, globalConfigSchematics } = require("../dist/settings.js");
  const values = { vaultPath: "/v", permanentFolder: "Z", inboxFolder: "I", userSectionHeadings: ["A"], maxEntities: 1, maxHopNotes: 2, maxFuzzyNotes: 0, totalMaxChars: 900 };
  const parsed = { get: (k) => values[k] };
  const ctl = {
    getGlobalPluginConfig: (s) => { assert.equal(s, globalConfigSchematics); return parsed; },
    getPluginConfig: (s) => { assert.equal(s, configSchematics); return parsed; },
  };
  assert.deepEqual(readSettings(ctl), values);
  // LM Studio refusing the settings must not block a message: fall back to none.
  const broken = { getGlobalPluginConfig: () => { throw new Error("x"); }, getPluginConfig: () => parsed };
  assert.deepEqual(Object.keys(readSettings(broken)).sort(), ["maxEntities", "maxFuzzyNotes", "maxHopNotes", "totalMaxChars"]);
});

test("limits: maxHopNotes 0 adds no linked notes; maxFuzzyNotes 0 adds no keyword matches", async () => {
  const named = await ask("how is my Dive certification going?", { maxHopNotes: 0 });
  assert.deepEqual(named.notes.map((n) => n.kind), ["entity"]);
  assert.equal((await ask("how is my Dive certification going?", { maxHopNotes: 1 })).notes.length, 2);
  assert.equal((await ask("certs", { maxFuzzyNotes: 0, maxHopNotes: 0 })).notes.length, 0);
  assert.equal((await ask("OWD", { maxEntities: 0, maxFuzzyNotes: 0 })).notes.length, 0);
});

/* ---------------- capture and promote (Phase 3c) ---------------- */

const { captureNote, promoteNote, safeFolder, cleanTitle, INBOX_FOLDER } = require("../dist/engine/capture.js");
const { createToolsProvider } = require("../dist/tools.js");

const NOW = new Date(2026, 10, 17, 19, 52); // 202611171952
const LATER = new Date(2026, 10, 17, 20, 5); // 202611172005

/** A throwaway copy of the fixture vault; the real fixture is never written. */
function scratchVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-recall-vault-"));
  fs.cpSync(VAULT, dir, { recursive: true });
  return dir;
}
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  }).sort();
}
const cfgFor = (vaultPath, extra = {}) => ({ ...HOMELAB_DEFAULTS, vaultPath, ...extra });
const read = (vault, rel) => fs.readFileSync(path.join(vault, rel), "utf-8");
const CAPTURE = {
  title: "Mediaserver transcoding fix",
  project: "homelab",
  what_happened: "Hardware transcoding failed until the render group was added.",
  why_it_matters: "Without it every stream transcodes on the CPU.",
  links: ["ct-101", "Mediaserver", "no-such-note"],
};

test("recall: writes one inbox note in the agreed format, linking only notes that exist", async () => {
  const vault = scratchVault();
  try {
    const before = listFiles(vault);
    const r = await captureNote(cfgFor(vault), CAPTURE, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.relPath, `${INBOX_FOLDER}/202611171952 Mediaserver transcoding fix.md`);
    assert.deepEqual(listFiles(vault), [...before, r.relPath].sort(), "exactly one new file, no temp files left");
    assert.equal(read(vault, r.relPath), [
      "---", "managed_by: lm-recall", "---",
      "# Mediaserver transcoding fix", "",
      "## Date", "2026-11-17", "",
      "## Project", "homelab", "",
      "## What happened", CAPTURE.what_happened, "",
      "## Why it matters", CAPTURE.why_it_matters, "",
      "## Links", "- [[ct-101]]", "",
    ].join("\n"));
    assert.match(r.message, /no-such-note/, "unknown links are reported back");
    assert.ok(!r.message.includes(vault), "no absolute path in the message");
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("recall: no links means no Links section; no project means 'unknown'", async () => {
  const vault = scratchVault();
  try {
    const r = await captureNote(cfgFor(vault), { title: "Idea", what_happened: "A.", why_it_matters: "B." }, NOW);
    const text = read(vault, r.relPath);
    assert.ok(!text.includes("## Links"));
    assert.match(text, /## Project\nunknown\n/);
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("recall: an existing note is never overwritten", async () => {
  const vault = scratchVault();
  try {
    const first = await captureNote(cfgFor(vault), CAPTURE, NOW);
    const original = read(vault, first.relPath);
    const again = await captureNote(cfgFor(vault), { ...CAPTURE, what_happened: "Different." }, NOW);
    assert.equal(again.ok, false);
    assert.match(again.message, /never overwrites/);
    assert.equal(read(vault, first.relPath), original);
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("recall: titles can't leave the inbox or break a filename", async () => {
  assert.equal(cleanTitle("../../etc/passwd"), "etc passwd");
  assert.equal(cleanTitle('a/b: "c"? [[d]] #e'), "a b c d e");
  assert.equal(cleanTitle("   "), "");
  const vault = scratchVault();
  try {
    const r = await captureNote(cfgFor(vault), { ...CAPTURE, title: "../../escape" }, NOW);
    assert.equal(r.relPath, `${INBOX_FOLDER}/202611171952 escape.md`);
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("recall: missing fields or an unreadable vault write nothing", async () => {
  const vault = scratchVault();
  try {
    const before = listFiles(vault);
    const r = await captureNote(cfgFor(vault), { title: "x" }, NOW);
    assert.equal(r.ok, false);
    assert.match(r.message, /what_happened, why_it_matters missing/);
    assert.deepEqual(listFiles(vault), before);
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
  const gone = await captureNote(cfgFor(path.join(VAULT, "nope")), CAPTURE, NOW);
  assert.equal(gone.ok, false);
  assert.ok(gone.message.includes(CAPTURE.what_happened), "the note comes back so nothing is lost");
});

test("recall: a failed write returns the whole note, with no path or stack trace", async () => {
  const vault = scratchVault();
  try {
    fs.writeFileSync(path.join(vault, INBOX_FOLDER), "a file where the inbox folder should be");
    const r = await captureNote(cfgFor(vault), CAPTURE, NOW);
    assert.equal(r.ok, false);
    assert.ok(r.message.includes(CAPTURE.why_it_matters));
    assert.ok(!r.message.includes(vault) && !/\bat \S+ \(/.test(r.message));
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: inbox note becomes a zettel; then the inbox note moves, unchanged, to .trash", async () => {
  const vault = scratchVault();
  try {
    const cap = await captureNote(cfgFor(vault), CAPTURE, NOW);
    const inboxBefore = read(vault, cap.relPath);
    const r = await promoteNote(cfgFor(vault), {
      note: "Mediaserver transcoding fix",
      idea: "Mediaserver in an LXC needs the render group for hardware transcoding.",
      connected_to: ["node-hv2", "made up"],
    }, LATER);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.relPath, "Zettels/202611172005 Mediaserver transcoding fix.md");
    assert.equal(read(vault, r.relPath), [
      "# Mediaserver transcoding fix", "",
      "## The idea", "Mediaserver in an LXC needs the render group for hardware transcoding.", "",
      "## Why it matters", CAPTURE.why_it_matters, "",
      "## Connected to", "- [[ct-101]]", "- [[node-hv2]]", "",
      "## Source", "Captured in LM Studio on 2026-11-17, project: homelab.", "",
    ].join("\n"));
    assert.ok(!read(vault, r.relPath).includes("managed_by"), "the zettel is the user's");
    assert.ok(!fs.existsSync(path.join(vault, cap.relPath)), "inbox note gone from the inbox");
    assert.equal(read(vault, ".trash/202611171952 Mediaserver transcoding fix.md"), inboxBefore, "and in .trash, byte for byte");
    assert.match(r.message, /made up/);
    assert.match(r.message, /\.trash/);
    // The reader finds the new zettel by its title, and never reads .trash.
    const found = await recall("what was the mediaserver transcoding fix?", cfgFor(vault));
    assert.ok(found.notes.some((n) => n.relPath === r.relPath), JSON.stringify(found.notes.map((n) => n.relPath)));
    assert.ok(!found.notes.some((n) => n.relPath.startsWith(".trash/")));
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: with no links anywhere, Connected to says (none identified)", async () => {
  const vault = scratchVault();
  try {
    await captureNote(cfgFor(vault), { title: "Lonely", what_happened: "A.", why_it_matters: "B." }, NOW);
    const r = await promoteNote(cfgFor(vault), { note: "202611171952" }, LATER);
    assert.equal(r.ok, true, r.message);
    assert.match(read(vault, r.relPath), /## Connected to\n\(none identified\)\n/);
    assert.match(read(vault, r.relPath), /## The idea\nA\.\n/, "falls back to the inbox note's text");
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: .trash keeps the note byte for byte and never overwrites a file already there", async () => {
  const vault = scratchVault();
  try {
    fs.mkdirSync(path.join(vault, INBOX_FOLDER), { recursive: true });
    fs.mkdirSync(path.join(vault, ".trash"), { recursive: true });
    const rel = `${INBOX_FOLDER}/202611171000 Crlf note.md`;
    const raw = "---\r\nmanaged_by: lm-recall\r\n---\r\n# Crlf note\r\n\r\n## What happened\r\nX.\r\n\r\n## Why it matters\r\nY.\r\n";
    fs.writeFileSync(path.join(vault, rel), raw);
    fs.writeFileSync(path.join(vault, ".trash", "202611171000 Crlf note.md"), "older");
    const r = await promoteNote(cfgFor(vault), { note: "Crlf note" }, LATER);
    assert.equal(r.ok, true, r.message);
    assert.equal(read(vault, ".trash/202611171000 Crlf note.md"), "older");
    assert.equal(read(vault, ".trash/202611171000 Crlf note 1.md"), raw);
    assert.ok(!fs.existsSync(path.join(vault, rel)));
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: refuses notes outside the inbox, notes it didn't create, and repeats", async () => {
  const vault = scratchVault();
  try {
    fs.mkdirSync(path.join(vault, INBOX_FOLDER), { recursive: true });
    fs.writeFileSync(path.join(vault, INBOX_FOLDER, "202611171000 Mine.md"), "# Mine\n\n## What happened\nA.\n\n## Why it matters\nB.\n");
    const before = listFiles(vault);
    const outside = await promoteNote(cfgFor(vault), { note: "Dive certification" }, LATER);
    assert.match(outside.message, /not an inbox note/);
    const userNote = await promoteNote(cfgFor(vault), { note: "Mine" }, LATER);
    assert.match(userNote.message, /not created by lm-recall/);
    assert.match((await promoteNote(cfgFor(vault), { note: "nothing like it" }, LATER)).message, /No inbox note/);
    assert.deepEqual(listFiles(vault), before, "nothing written");

    await captureNote(cfgFor(vault), CAPTURE, NOW);
    assert.equal((await promoteNote(cfgFor(vault), { note: CAPTURE.title }, LATER)).ok, true);
    const repeat = await promoteNote(cfgFor(vault), { note: CAPTURE.title }, new Date(2026, 10, 18, 9, 0));
    assert.equal(repeat.ok, false, "the inbox note is gone, so it can't be promoted twice");
    // A note promoted by the older version (kept and marked) is still refused.
    fs.writeFileSync(path.join(vault, INBOX_FOLDER, "202611170900 Old.md"),
      '---\nmanaged_by: lm-recall\npromoted_to: "[[x]]"\n---\n# Old\n\n## What happened\nA.\n\n## Why it matters\nB.\n');
    assert.match((await promoteNote(cfgFor(vault), { note: "Old" }, LATER)).message, /already promoted/);
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: an existing zettel name is refused and the inbox note is left unmarked", async () => {
  const vault = scratchVault();
  try {
    const cap = await captureNote(cfgFor(vault), CAPTURE, NOW);
    const inbox = read(vault, cap.relPath);
    fs.writeFileSync(path.join(vault, "Zettels", "202611172005 Mediaserver transcoding fix.md"), "mine");
    const r = await promoteNote(cfgFor(vault), { note: CAPTURE.title }, LATER);
    assert.equal(r.ok, false);
    assert.match(r.message, /never overwrites/);
    assert.equal(read(vault, "Zettels/202611172005 Mediaserver transcoding fix.md"), "mine");
    assert.equal(read(vault, cap.relPath), inbox);
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: the permanent folder must stay inside the vault; a new folder is created", async () => {
  assert.equal(safeFolder("Zettels"), "Zettels");
  assert.equal(safeFolder(" Notes/Permanent/ "), "Notes/Permanent");
  for (const bad of ["", "../out", "/etc", "C:\\x", "a/../../b", ".hidden"]) assert.equal(safeFolder(bad), null, bad);
  const vault = scratchVault();
  try {
    await captureNote(cfgFor(vault), CAPTURE, NOW);
    const escape = await promoteNote(cfgFor(vault, { permanentFolder: "../out" }), { note: CAPTURE.title }, LATER);
    assert.equal(escape.ok, false);
    const r = await promoteNote(cfgFor(vault, { permanentFolder: "Permanent" }), { note: CAPTURE.title }, LATER);
    assert.equal(r.relPath, "Permanent/202611172005 Mediaserver transcoding fix.md");
    assert.ok(fs.existsSync(path.join(vault, r.relPath)));
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("tools: recall and promote are offered to the model and use the current settings", async () => {
  const vault = scratchVault();
  try {
    const provider = createToolsProvider(() => cfgFor(vault), () => NOW);
    const tools = await provider({});
    assert.deepEqual(tools.map((t) => t.name), ["recall", "promote"]);
    const out = await tools[0].implementation(CAPTURE, {});
    assert.match(out, /^Saved to 00 - Inbox\/202611171952 Mediaserver transcoding fix\.md/);
    const broken = await (await createToolsProvider(() => { throw new Error("/secret"); })({}))[0].implementation(CAPTURE, {});
    assert.ok(!broken.includes("/secret"));
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("settings: the permanent folder setting wins when set", () => {
  assert.equal(applySettings(BASE, { permanentFolder: " Notes " }).permanentFolder, "Notes");
  assert.equal(applySettings(BASE, { permanentFolder: "" }).permanentFolder, "Zettels");
});

test("settings: the inbox folder setting wins when set", () => {
  assert.equal(applySettings(BASE, { inboxFolder: " Fleeting " }).inboxFolder, "Fleeting");
  assert.equal(applySettings(BASE, { inboxFolder: "" }).inboxFolder, "00 - Inbox");
  assert.equal(applySettings({ ...BASE, inboxFolder: "From json" }, { inboxFolder: "" }).inboxFolder, "From json");
});

test("inbox folder: recall and promote use the configured inbox, never a second 00 - Inbox", async () => {
  const vault = scratchVault();
  try {
    const cfg = cfgFor(vault, { inboxFolder: "Notes/Fleeting" });
    const r = await captureNote(cfg, CAPTURE, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.relPath, "Notes/Fleeting/202611171952 Mediaserver transcoding fix.md");
    assert.ok(!fs.existsSync(path.join(vault, INBOX_FOLDER)), "no default inbox created");
    // A note in the old default folder is not an inbox note any more.
    const p = await promoteNote(cfg, { note: CAPTURE.title }, LATER);
    assert.equal(p.ok, true, p.message);
    assert.equal(p.relPath, "Zettels/202611172005 Mediaserver transcoding fix.md");
    assert.ok(!fs.existsSync(path.join(vault, r.relPath)), "inbox note moved to .trash");
    // Matching ignores case, as Windows and macOS do.
    await captureNote(cfg, { ...CAPTURE, title: "Second" }, NOW);
    const q = await promoteNote(cfgFor(vault, { inboxFolder: "notes/fleeting" }), { note: "Second" }, LATER);
    assert.equal(q.ok, true, q.message);
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("inbox folder: must stay inside the vault and must not overlap the permanent folder", async () => {
  const { foldersOverlap } = require("../dist/engine/capture.js");
  assert.equal(foldersOverlap("Inbox", "inbox"), true);
  assert.equal(foldersOverlap("Notes", "Notes/Inbox"), true);
  assert.equal(foldersOverlap("Notes/Inbox", "Notes"), true);
  assert.equal(foldersOverlap("Inbox", "Inbox2"), false);
  const vault = scratchVault();
  try {
    const before = listFiles(vault);
    for (const extra of [
      { inboxFolder: "../out" }, { inboxFolder: ".hidden" }, { inboxFolder: "/etc" },
      { inboxFolder: "zettels" }, { inboxFolder: "Zettels/Inbox" }, { permanentFolder: "00 - Inbox/Done" },
    ]) {
      const r = await captureNote(cfgFor(vault, extra), CAPTURE, NOW);
      assert.equal(r.ok, false, JSON.stringify(extra));
      assert.ok(r.message.includes(CAPTURE.what_happened), "the note is returned so nothing is lost");
      assert.ok(!r.message.includes(vault), "no absolute path");
      const p = await promoteNote(cfgFor(vault, extra), { note: CAPTURE.title }, LATER);
      assert.equal(p.ok, false, JSON.stringify(extra));
    }
    assert.deepEqual(listFiles(vault), before, "nothing written");
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: tags and summary become frontmatter; the zettel is still the user's", async () => {
  const { cleanTags, cleanSummary } = require("../dist/engine/capture.js");
  assert.deepEqual(cleanTags(["#Homelab", "home lab", "mediaserver", "MEDIASERVER", "2026", "a,b", "net/vlan"]),
    ["homelab", "home-lab", "mediaserver", "ab", "net/vlan"]);
  assert.deepEqual(cleanTags("homelab, media"), ["homelab", "media"]);
  assert.equal(cleanSummary("  It's a\n fix.  "), "It’s a fix.");
  const vault = scratchVault();
  try {
    await captureNote(cfgFor(vault), CAPTURE, NOW);
    const r = await promoteNote(cfgFor(vault), {
      note: CAPTURE.title, tags: ["homelab", "mediaserver"], summary: "Mediaserver's hardware transcoding needs the render group.",
    }, LATER);
    assert.equal(r.ok, true, r.message);
    const text = read(vault, r.relPath);
    assert.ok(text.startsWith("---\ntags: [homelab, mediaserver]\nsummary: 'Mediaserver’s hardware transcoding needs the render group.'\n---\n# Mediaserver transcoding fix\n"));
    assert.ok(!text.includes("managed_by"));
    const fm = parseFrontmatter(text);
    assert.deepEqual(fm.tags, ["homelab", "mediaserver"]);
    assert.equal(fm.summary, "Mediaserver’s hardware transcoding needs the render group.");
    // The reader shows the summary and finds the note by tag.
    const found = await recall("anything about transcoding?", cfgFor(vault));
    const z = found.notes.find((n) => n.relPath === r.relPath);
    assert.ok(z && z.excerpt.includes("hardware transcoding needs the render group"), JSON.stringify(found.notes.map((n) => n.relPath)));
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});

test("promote: without tags or summary the zettel has no frontmatter", async () => {
  const vault = scratchVault();
  try {
    await captureNote(cfgFor(vault), CAPTURE, NOW);
    const r = await promoteNote(cfgFor(vault), { note: CAPTURE.title, tags: ["###", "42"], summary: "   " }, LATER);
    assert.ok(read(vault, r.relPath).startsWith("# Mediaserver transcoding fix\n"));
  } finally {
    fs.rmSync(vault, { recursive: true });
  }
});
