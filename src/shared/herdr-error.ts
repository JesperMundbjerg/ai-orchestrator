// How a failed herdr CLI call is told to a person: herdr's own message when it gave one, else how
// the process ended. Shared by the service and the CLI; pure, no I/O.

/** One readable line, never a dump of herdr's output or a stack trace. */
function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^(fatal|error):\s*/i, "").slice(0, 200);
}

/**
 * What went wrong, as herdr said it or else as the process ended: exit code, signal, or our own
 * deadline. Never the command line, which carries the prompt text and hides the actual cause.
 */
export function herdrError(err: unknown, command: string, timeoutMs: number): string {
  const e = err as { stdout?: string; stderr?: string; code?: number | string | null; signal?: string | null; killed?: boolean };
  for (const out of [e.stdout, e.stderr]) {
    try {
      const message = (JSON.parse(out ?? "") as { error?: { message?: string } }).error?.message;
      if (message) return message;
    } catch {
      // Not JSON: a plain line from herdr, kept below with how the process ended.
    }
  }
  const said = firstLine(e.stderr) || firstLine(e.stdout);
  let ended: string;
  if (e.killed && e.signal) ended = `herdr ${command} gave no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} and was stopped`;
  else if (e.signal) ended = `herdr ${command} was ended by ${e.signal}`;
  else if (typeof e.code === "number") ended = `herdr ${command} exited with code ${e.code}`;
  else if (e.code === "ENOENT") ended = `herdr ${command} could not start: herdr is not installed at the configured path`;
  else if (err instanceof SyntaxError) ended = `herdr ${command} gave an answer that is not JSON`;
  else if (typeof e.code === "string") ended = `herdr ${command} could not run (${e.code})`;
  else ended = `herdr ${command} did not answer`;
  return said ? `${ended}: ${said}` : `${ended} without saying why`;
}
