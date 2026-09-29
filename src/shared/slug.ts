/** A project's name as a folder and branch part: "Atoms light!" → "atoms-light". Empty when it does not start with a letter. */
export function projectSlug(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return /^[a-z]/.test(slug) ? slug : "";
}
