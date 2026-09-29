/**
 * A model id as a person says it: "claude-opus-5-5" → "Opus 5.5", "gpt-6" → "GPT-6",
 * "openai-codex/gpt-5.6-sol" → "GPT-5.6 Sol". The provider prefix and a date suffix are left
 * out; the raw id stays with the label for anyone who wants it.
 */
export function modelLabel(id: string): string {
  const name = id.slice(id.lastIndexOf("/") + 1);
  const claude = /^claude-([a-z]+)-(\d+)[-.](\d+)(?:-\d{8})?(\[1m\])?$/i.exec(name);
  if (claude) return `${cap(claude[1]!)} ${claude[2]}.${claude[3]}${claude[4] ? " (1M)" : ""}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)(.*)$/i.exec(name);
  if (gpt) {
    const [attached, ...words] = gpt[2]!.split("-");
    return `GPT-${gpt[1]}${attached}${words.filter(Boolean).map((w) => ` ${cap(w)}`).join("")}`;
  }
  // Anything else: its words, capitalised where they are words, without a date stamp.
  return name
    .split("-")
    .filter((w) => w && !/^\d{8}$/.test(w))
    .map((w) => (/^[a-z]{2,}$/i.test(w) ? cap(w) : w))
    .join(" ") || id;
}

const cap = (w: string) => `${w[0]!.toUpperCase()}${w.slice(1)}`;
