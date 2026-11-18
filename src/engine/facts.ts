import type { Frontmatter } from "./core";

/**
 * Which frontmatter keys get summarized in an injected excerpt.
 * Tracked in git: this is plugin behavior, not machine-local config.
 *
 * Notes whose `id` has a known namespace (vm/101 -> "vm") show the curated
 * list below, in that order: syncer notes carry many keys and only some
 * matter to a model. Every other note (a personal zettel, a project, a cert)
 * shows ALL of its frontmatter except the keys in HIDDEN_KEYS, because the
 * person who wrote it chose what to put there.
 *
 * Key names checked against pve_sync.py (SCHEMA 7, FM_KEYS) and
 * opnsense_sync.py (fw schema 2, FW_KEYS / NET_KEYS).
 */
const COMMON_FACT_KEYS = ["summary", "status"];

const FACT_KEYS_BY_NAMESPACE: Record<string, string[]> = {
  vm: ["type", "node", "onboot", "cores", "memory_mb", "ips", "agent",
       "backup", "last_backup", "snapshots", "storage", "bridges", "vlans",
       "passthrough", "disks", "pve_tags"],
  ct: ["type", "node", "onboot", "unprivileged", "cores", "memory_mb", "ips",
       "backup", "last_backup", "snapshots", "storage", "bridges", "vlans",
       "passthrough", "disks", "pve_tags"],
  node: ["pve_version", "kernel", "cpu_model", "sockets", "cores", "memory_mb", "storages"],
  storage: ["storage_type", "shared", "content", "nodes"],
  // Firewall-owned net notes (vlan_tag ... description) and pve_sync's
  // existence stubs / bridges (kind, vlan_id) share the net/ namespace.
  net: ["kind", "vlan_tag", "vlan_id", "parent_interface", "interface", "ipv4_subnet",
        "gateway", "dhcp_enabled", "dhcp_range", "description"],
  fw: ["model", "opnsense_version", "kernel", "cpu_model", "memory_mb",
       "subnets", "routes_for", "rule_count", "nat_count", "plugins"],
};

/** Never shown as facts: identity/plumbing keys, or shown elsewhere
 * (connects_to becomes "Links to / Linked from" lines). */
const HIDDEN_KEYS = new Set([
  "id", "aliases", "alias", "title", "connects_to", "managed_by", "sync_schema",
  "cssclasses", "cssclass", "publish", "position",
]);

export function factKeysFor(fm: Frontmatter): string[] {
  const id = typeof fm.id === "string" ? fm.id : "";
  const ns = id.includes("/") ? id.split("/")[0] : "";
  const specific = FACT_KEYS_BY_NAMESPACE[ns];
  if (specific) return [...COMMON_FACT_KEYS, ...specific];
  const rest = Object.keys(fm).filter(
    (k) => !HIDDEN_KEYS.has(k) && !COMMON_FACT_KEYS.includes(k),
  );
  return [...COMMON_FACT_KEYS, ...rest];
}
