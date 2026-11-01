// Texts the office writes for agents name the `inbox` commands to run. A cold agent's pane need not
// have `inbox` on its PATH, so each such command is written with the CLI's path (inboxCommand, from
// shared/pipeline-cli.ts). Texts here keep reading `inbox team`; this turns each into the runnable
// command. It leaves what already has a path alone (so it can run twice), and `inbox pipeline`,
// which the pipeline texts write with inboxCommand themselves.

import { inboxCommand } from "../shared/pipeline-cli.ts";

// The commands the office's brief, notices and message texts tell agents to run; `inbox pipeline` is written with inboxCommand
// by the pipeline texts, and `inbox comment` is the page-comment texts'.
const COMMANDS = "say|decide|milestone|handoff|review|team";
const NAMED = new RegExp(`(?<![\\w/.'-])inbox (${COMMANDS})(?![\\w-])`, "g");

/** A team's lead role file, delivered as the founder wrote it (leadrole.ts marks it). */
const ROLE_FILE = /(--- begin lead role ---[\s\S]*?--- end lead role ---)/;

/** `inbox say founder "…"` becomes `<path>/bin/inbox say founder "…"`; the rest of the line is as written, and a role file is left alone. */
export const withInboxPath = (text: string): string =>
  text.split(ROLE_FILE).map((part, i) => (i % 2 ? part : part.replace(NAMED, (_all, command: string) => inboxCommand(command)))).join("");
