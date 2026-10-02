// Manual only: node --test test/pipeline-hooks-codex.manual.ts
// Not matched by npm test / CI. No inference, real auth or external model endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { installHooks } from "../src/cli/pipeline-hooks.ts";

test("Codex 0.156.1 project PreToolUse blocks actual exec_command (canned loopback transcript)", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-codex-manual-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo space"); const home = join(root, "home"); const codexHome = join(home, "codex");
  mkdirSync(repo); mkdirSync(codexHome, { recursive: true });
  // Whitelist, rather than spreading process.env: no real API tokens, auth-file
  // overrides, daemon endpoints, provider config or Codex login can be inherited.
  const env = { PATH: process.env.PATH, SHELL: "/bin/sh", LANG: "en_US.UTF-8", HOME: home, CODEX_HOME: codexHome,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HERDR_SOCKET_PATH: "/nonexistent", HERDR_BIN_PATH: "/usr/bin/false", OTEL_SDK_DISABLED: "true" };
  const version = spawnSync("codex", ["--version"], { encoding: "utf8", env });
  assert.match(version.stdout, /0\.156\.1/, "verification requires installed Codex 0.156.1");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("init", "-b", "feature"); git("config", "user.name", "Scratch"); git("config", "user.email", "scratch@invalid");
  writeFileSync(join(repo, "file"), "seed"); git("add", "file"); git("commit", "-m", "seed");
  installHooks(repo, { inboxCommand: ["/nonexistent/inbox"] });
  const marker = join(repo, "must-not-exist"); let count = 0; const requests: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); count++;
    const id = `fixture-${count}`;
    const events: any[] = [{ type: "response.created", response: { id } }];
    if (count === 1) events.push({ type: "response.output_item.done", item: { type: "function_call", call_id: "blocked-delivery", name: "exec_command", arguments: JSON.stringify({ cmd: `git push origin HEAD:dev; touch '${marker}'`, workdir: repo, max_output_tokens: 1000 }) } });
    events.push({ type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  writeFileSync(join(codexHome, "config.toml"), `model = "scratch-fixture"\nmodel_provider = "scratch"\n[model_providers.scratch]\nname = "No-inference scratch"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(resolve(repo))}]\ntrust_level = "trusted"\n[analytics]\nenabled = false\n`);
  const child = spawn("codex", ["exec", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--json", "scratch fixture"], { cwd: repo, env });
  child.stdin.end(); t.after(() => child.kill("SIGKILL")); let output = ""; let stderr = "";
  child.stdout.on("data", (b) => output += b); child.stderr.on("data", (b) => stderr += b);
  t.after(() => { if (count !== 2) console.error({ count, output, stderr }); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr + output);
  assert.equal(existsSync(marker), false, "denied command must not run (even its semicolon-separated marker)");
  assert.equal(count, 2, stderr + output);
  const toolResult = requests[1].input.find((i: any) => i.type === "function_call_output");
  assert.match(toolResult?.output ?? "", /Restart the office and retry/);
});
