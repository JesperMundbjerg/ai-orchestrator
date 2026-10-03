// The agent invents its own story; the office only asks for it and keeps plain text.
export const STORY_MAX_CHARS = 800;
/**
 * Which prompt a story answers. Stories saved before this were job backstories under the first
 * prompt, then framed, look-alike lives under the second; the office asks those agents once to
 * retell theirs, then keeps whatever they have.
 */
export const STORY_PROMPT = 3;

const PLACES = [
  "Ibadan, Nigeria", "Valparaíso, Chile", "Ulaanbaatar, Mongolia", "Tbilisi, Georgia", "Madurai, India", "Osaka, Japan",
  "Marseille, France", "Winnipeg, Canada", "Oaxaca, Mexico", "Alice Springs, Australia", "Tunis, Tunisia", "Cluj, Romania",
  "Busan, South Korea", "Addis Ababa, Ethiopia", "Glasgow, Scotland", "Manila, the Philippines", "Almaty, Kazakhstan",
  "La Paz, Bolivia", "Nairobi, Kenya", "Detroit, USA", "Palermo, Sicily", "Hanoi, Vietnam", "Tehran, Iran", "Lviv, Ukraine",
  "Recife, Brazil", "Kraków, Poland", "Dakar, Senegal", "Kathmandu, Nepal", "Montevideo, Uruguay", "a desert village in Rajasthan",
  "a mining town in Western Australia", "a housing estate outside Leeds", "a tea estate in Sri Lanka", "a cotton town in Mississippi",
  "a high-rise in Hong Kong", "a market town in Anatolia",
];
const DECADES = ["1950s", "1960s", "1970s", "1980s", "1990s", "2000s"];
const TRADES = [
  "a night-shift baker", "a piano tuner", "a long-haul truck driver", "a hospital radiographer", "a cinema projectionist",
  "a locksmith", "a wedding tailor", "a beekeeper", "a bus mechanic", "a court stenographer", "a traffic police officer",
  "a theatre seamstress", "a pharmacist", "a sign painter", "a butcher", "a chemistry teacher", "a taxi driver", "a dentist",
  "a spice trader at the market", "an electrician", "a radio repairman", "a night nurse", "a hotel night porter",
  "a tram driver", "an airport weather observer", "a wrestling coach", "a typist at a newspaper", "a vet for farm animals",
];
const OBJECTS = [
  "a cracked snow globe", "a typewriter missing its letter e", "a jar of foreign coins", "a cuckoo clock that struck thirteen",
  "a library book never returned", "a plastic dinosaur with one leg", "a cassette of songs taped off the radio",
  "a chipped enamel mug", "a chess set with a bottle cap for a pawn", "a key nobody knew the lock for", "a tin of odd buttons",
  "a wind-up tin robot", "a toy stethoscope", "roller skates a size too big", "a dented trumpet", "a calculator watch",
  "a hand-drawn map of the neighbourhood", "a stuffed owl", "a magnifying glass", "a bicycle bell", "a flower pressed in a dictionary",
  "a postcard from a stranger", "a lunchbox with a cartoon on it", "a broken transistor radio",
];
const JOYS = [
  "winning a spelling contest with a word nobody else could say", "the first snow you ever saw",
  "a power cut when the whole street came outside", "dancing at a wedding until the band left",
  "teaching a younger cousin to ride a bike", "a night market with a parent", "the day the family got a telephone",
  "forgetting your lines in a school play and the hall laughing kindly", "a long train journey with the window seat",
  "fixing something the adults had given up on", "a football match won in the last minute",
  "a birthday cake that collapsed and tasted perfect", "a bakery's smell at five in the morning", "catching fireflies in a jar",
  "winning a radio phone-in contest", "spending a first pay packet on everyone else", "a stray dog that chose you",
  "watching a festival parade from someone's shoulders", "the first time a stranger laughed at your joke",
];
// Varied on purpose: never things left unsaid or silence, which the office already has too many of.
const FEARS = [
  "heights, especially open staircases", "hospitals and their smell", "getting lost in a crowd", "dogs, since a bite at six",
  "fire, after a kitchen fire at home", "thunderstorms", "losing your eyesight", "lifts stuck between floors", "public speaking",
  "debt, after watching a parent lose a shop", "moths", "tunnels and caves", "driving at night", "growing old alone",
  "failing the one exam that mattered", "earthquakes", "being found out as a fraud", "needles", "fast traffic",
  "running out of money", "wasps", "being picked last", "illness in the family", "clowns",
];

/** FNV-1a: small, stable, and the same wherever it runs. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
const pick = (id: string, field: string, list: readonly string[]): string => list[hash(`${id}#${field}`) % list.length]!;

export interface StorySeeds { place: string; decade: string; trade: string; object: string; joy: string; fear: string }
/** A few starting points for an agent's story, always the same for the same agent id. */
export function storySeeds(id: string): StorySeeds {
  return {
    place: pick(id, "place", PLACES), decade: pick(id, "decade", DECADES), trade: pick(id, "trade", TRADES),
    object: pick(id, "object", OBJECTS), joy: pick(id, "joy", JOYS), fear: pick(id, "fear", FEARS),
  };
}

/**
 * What the office asks an agent: its own life, told plainly. With an id it carries that agent's seeds;
 * `retell` asks an agent whose story answers an older prompt to tell it again.
 */
export function storyIntro(id?: string, retell = false): string {
  const s = id ? storySeeds(id) : null;
  return [
    retell ? "The office has a new story prompt: retell your story once under it, replacing your old one:" : "Quick, one-off office introduction, not part of your task:",
    "in 3–5 sentences, tell your personal life story in the first person, plainly, as your own life — not your job, skills or duties, but who you are: a childhood memory that made you happy, a crisis you came through, what you love or fear.",
    "Start straight in: no label, framing or disclaimer, and never call it fictional, imagined or a backstory, or mention being an AI or a character.",
    s ? `Your seeds, a starting point, not a checklist: ${s.place} in the ${s.decade}; a parent who was ${s.trade}; ${s.object}; ${s.joy}; a fear of ${s.fear}.`
      : "`inbox team` gives you a few seeds to start from.",
    "Make it a real, ordinary life, not a whimsical job, and be original: the office already has too many rivers, fjords and boats, grandparents' workshops, lighthouses, observatories, tiny railways, switchboards, \"formerly the keeper of…\" whimsy, and fears of things left unsaid or of silence, so avoid those.",
    '`inbox team` tells you your office name; save it once with inbox story "…" (plain text, at most 800 characters). If you already saved it in this conversation, skip this.',
  ].join(" ");
}

/** Lower case, no accents or punctuation, single spaces: "Don't" and "DON’T!" read alike. */
const normal = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Labels at the very start: "Backstory:", "My story…", "Here is my bio". */
const LABEL = /^(?:(?:this is|here is|here s|what follows is)\s+)?(?:(?:my|a|an|the)\s+)?(?:(?:personal|short|brief|office)\s+)?(?:back\s?story|story|bio|biography|autobiography|introduction|intro)\b/;
/** Frames and disclaimers anywhere in the opening sentence. */
const FRAME = new RegExp(`\\b(?:${[
  "fictional", "fictitious", "hypothetical", "role ?play", "back ?story", "office story", "persona",
  "in my story", "in this story", "imagined (?:life|childhood|past|self|world)", "imaginary (?:life|childhood|past)", "made up (?:life|story|past|childhood)",
  "an ai", "ai model", "claude model", "ai autobiography", "language model", "llm",
  "as a character", "i (?:don t|do not|didn t|did not|never) (?:have|had) (?:a )?(?:real )?childhood", "i have no (?:real )?childhood",
].join("|")})\\b`);

/**
 * True when a story opens with a frame or disclaimer instead of the life itself:
 * "Fictional office backstory for Yuri:", "In my imagined life", "As an AI, I don't have a childhood".
 */
export function framedStory(text: string): boolean {
  const opening = normal(text.split(/[.!?](?:\s|$)/)[0]!.slice(0, 240));
  return LABEL.test(opening) || FRAME.test(opening);
}
export const FRAMED_STORY = "tell your story plainly as your own life: start straight in, with no label, framing or disclaimer, and never call it fictional, imagined, an office story or a backstory, or mention being an AI or a character. Nothing was saved.";

/** The agent's own story, shown back to it in its briefing so the person it is shows in its work. */
export const storyLine = (story: string) => `Your story: ${story} Let that person show in your work: your own creativity and a personal touch, not only the task.`;
