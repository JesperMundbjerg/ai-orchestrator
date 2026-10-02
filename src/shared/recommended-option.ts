import type { Option } from "./types.ts";

/** Recommendations are prose. Pick only an unambiguous leading label/id, never
 * an option mentioned somewhere in the explanation. Shared by the UI and automation. */
export function recommendedOption(options: Option[], recommendation: string): string | null {
  const lead = recommendation.trim().replace(/^I recommend\s+/i, "");
  const explicitId = /^option\s+/i.test(lead);
  const text = lead.replace(/^option\s+/i, "").toLocaleLowerCase();
  const matches = options.filter((option) => {
    const label = option.label.trim().toLocaleLowerCase();
    const id = option.id.toLocaleLowerCase();
    const labelMatches = text.startsWith(label) && /^(?:$|[:,.\s—–-])/.test(text.slice(label.length));
    // A sentence starting with the article “A” is not necessarily option A.
    const idMatches = text.startsWith(id) && (explicitId ? /^(?:$|[:,.\s—–-])/ : /^(?:$|[:,.—–-]|\s+(?:because|since)\b)/).test(text.slice(id.length));
    return labelMatches || idMatches;
  });
  return matches.length === 1 ? matches[0]!.id : null;
}
