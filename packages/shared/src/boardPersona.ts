const PERSONA_NAMES = [
  "Pip",
  "Mochi",
  "Biscuit",
  "Nimbus",
  "Pebble",
  "Sprout",
  "Juniper",
  "Waffles",
  "Clover",
  "Tofu",
  "Maple",
  "Bubbles",
  "Noodle",
  "Pixel",
  "Sunny",
  "Peaches",
  "Ziggy",
  "Marble",
  "Comet",
  "Dewdrop",
  "Fig",
  "Hazel",
  "Kiwi",
  "Lumen",
  "Miso",
  "Nugget",
  "Olive",
  "Pudding",
  "Quill",
  "Rolo",
  "Sesame",
  "Taffy",
  "Umi",
  "Velvet",
  "Wisp",
  "Yuzu",
  "Acorn",
  "Basil",
  "Cocoa",
  "Dumpling",
  "Ember",
  "Fizz",
  "Gumdrop",
  "Honey",
  "Inky",
  "Jellybean",
  "Kumo",
  "Latte",
  "Momo",
  "Nova",
  "Oreo",
  "Poppy",
  "Ripple",
  "Sorbet",
  "Twinkle",
  "Bao",
  "Cinnamon",
  "Doodle",
  "Echo",
  "Flurry",
  "Glimmer",
  "Hopper",
  "Mango",
  "Zephyr",
] as const;

export interface BoardPersona {
  readonly name: string;
  /** Avatar colors as hues (0-359): the body gradient runs from `hue` to `accentHue`. */
  readonly hue: number;
  readonly accentHue: number;
  /** Expression variant, 0-3. */
  readonly face: number;
  /** Body shape variant, 0-3. */
  readonly shape: number;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable per agent thread, so every client and the server agree on who is who. */
export function boardPersona(threadId: string): BoardPersona {
  const hash = fnv1a(threadId);
  const hue = hash % 360;
  return {
    name: PERSONA_NAMES[(hash >>> 9) % PERSONA_NAMES.length]!,
    hue,
    accentHue: (hue + 40 + ((hash >>> 17) % 80)) % 360,
    face: (hash >>> 25) % 4,
    shape: (hash >>> 13) % 4,
  };
}
