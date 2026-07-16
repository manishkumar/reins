/**
 * Human-readable session names.
 *
 * A session id like `3b9f2a1c-…` is unambiguous but unmemorable — with three
 * agents in one repo, "which one is the auth refactor?" has no answer a human
 * can hold in their head. Two layers fix that:
 *
 *   1. A deterministic MNEMONIC (`brave-otter`) computed from the id. Pure
 *      function, no storage, so it works identically in `watch`, `sessions`,
 *      and the steer picker — and even where the capture DB isn't available.
 *   2. An optional CUSTOM name set with `reins name` (stored in runs.db,
 *      display/targeting sugar only — never a control-plane input).
 *
 * The mnemonic is display + addressing convenience, not an identity: the
 * steering files, hold queue, and allowances stay keyed by the real session
 * id. Collisions across the word space (48×48 = 2304 combos) are tolerable
 * because the short id is always shown alongside.
 */

const ADJECTIVES = [
  "amber", "bold", "brave", "brisk", "calm", "cedar", "civil", "clear",
  "coral", "crisp", "deft", "dusky", "eager", "early", "fleet", "frank",
  "gentle", "glad", "golden", "hardy", "hazel", "humble", "iron", "jade",
  "keen", "kind", "lively", "loyal", "lucid", "mellow", "modest", "noble",
  "olive", "opal", "pale", "plain", "proud", "quiet", "rapid", "rosy",
  "rustic", "sable", "sage", "sturdy", "sunny", "swift", "tidy", "vivid",
];

const ANIMALS = [
  "badger", "bison", "crane", "crow", "deer", "dove", "egret", "elk",
  "falcon", "fawn", "finch", "fox", "gecko", "hare", "hawk", "heron",
  "hound", "ibis", "jay", "kite", "koala", "lark", "lemur", "llama",
  "lynx", "marmot", "marten", "mole", "moose", "newt", "otter", "owl",
  "panda", "pika", "plover", "quail", "rabbit", "raven", "robin", "seal",
  "shrew", "sparrow", "stork", "swan", "tapir", "vole", "wren", "yak",
];

/** FNV-1a 32-bit — tiny, dependency-free, stable across platforms. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic `adjective-animal` mnemonic for a session id. */
export function mnemonic(sessionId: string): string {
  const h = fnv1a(sessionId);
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length];
  return `${adj}-${animal}`;
}

/** The name a human sees for a session: their custom label, else the mnemonic. */
export function displayName(sessionId: string, custom?: string | null): string {
  const c = (custom ?? "").trim();
  return c || mnemonic(sessionId);
}
