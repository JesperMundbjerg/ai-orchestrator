// `inbox pipeline check RUN NODE`: the agent-side runner for a check step that names its command.
// The office service never runs a command; this process does, in the candidate's checkout, and records
// what happened as evidence for the service to judge by exact command, exit code and candidate.
import { execFileSync, spawn } from "node:child_process";
import { CHECK_OUTPUT_TAIL_MAX, requiredCommands } from "../shared/pipeline.ts";
import type { PipelineEvidenceInput, PipelineRun } from "../shared/pipeline.ts";

/** A hung command must not hold an agent forever. */
export const CHECK_TIMEOUT_MS = 30 * 60 * 1000;

export interface CheckRun { command: string; exitCode: number; durationMs: number; outputTail: string }

/** Runs one command through the shell in `cwd`, echoing its output to stderr and keeping only the last CHECK_OUTPUT_TAIL_MAX characters. */
export function runCommand(command: string, cwd: string, options: { timeoutMs?: number; echo?: (chunk: string) => void } = {}): Promise<CheckRun> {
  const started = Date.now(); let tail = ""; let timedOut = false;
  const keep = (chunk: Buffer) => {
    const text = chunk.toString("utf8"); options.echo?.(text);
    // Bounded memory however chatty the command is.
    tail = (tail + text).slice(-CHECK_OUTPUT_TAIL_MAX * 2);
  };
  return new Promise((resolve, reject) => {
    // Own process group, so the timeout stops the whole check, never a process this command did not start.
    const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const note = timedOut ? `\n[inbox: stopped after ${Math.round((options.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000)}s]` : signal ? `\n[inbox: ended by ${signal}]` : "";
      resolve({ command, exitCode: code ?? (timedOut ? 124 : 1), durationMs: Date.now() - started, outputTail: (tail + note).slice(-CHECK_OUTPUT_TAIL_MAX) });
    });
  });
}

/** The check evidence for one finished command, bound to the candidate it ran at. */
export function checkEvidence(result: CheckRun, candidate: string): PipelineEvidenceInput {
  const seconds = (result.durationMs / 1000).toFixed(1);
  return { kind: "check", summary: `\`${result.command}\` exit ${result.exitCode} in ${seconds}s at ${candidate.slice(0, 10)}`, command: result.command, exitCode: result.exitCode,
    durationMs: result.durationMs, outputTail: result.outputTail, candidate };
}

/** Why this run cannot be checked from here, or the commands to run, in order. */
export function checkPlan(run: PipelineRun, nodeId: string | undefined, how: string): string[] {
  if (!nodeId) throw new Error(`name the step: ${how}`);
  const node = run.graph.nodes.find(n => n.id === nodeId);
  if (!node) throw new Error(`no step ${nodeId} in run ${run.id}`);
  const commands = requiredCommands(node);
  if (!commands.length) throw new Error(`${node.label} (${node.id}) names no required command, so there is nothing for the office to run; record its check with report|done --check "command" --exit-code N`);
  if (run.state !== "open" || run.archived) throw new Error(`run ${run.id} is ${run.archived ? "archived" : run.state}; checks are recorded only on an open run`);
  const step = run.steps.find(s => s.nodeId === nodeId);
  if (step?.state === "inactive") throw new Error(`${node.label} (${node.id}) is not on this run's selected branches`);
  return commands;
}

/** The checkout must be at the commit the run pins; its bytes are re-verified by the office when the evidence is submitted. */
export function requirePinnedCheckout(run: PipelineRun, refresh: string): void {
  let head: string;
  try { head = execFileSync("git", ["-C", run.candidate.checkout, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`the run's checkout ${run.candidate.checkout} is unavailable`); }
  if (head !== run.candidate.head) throw new Error(`checkout ${run.candidate.checkout} is at ${head.slice(0, 10)}, not the run's candidate ${run.candidate.head.slice(0, 10)}; check out the candidate or re-pin the run first: ${refresh}`);
}
