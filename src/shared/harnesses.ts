// What each harness is, and how its replies can reach the conversation. The service learns
// which route is actually in use from observed behaviour (see `capabilities` in the service);
// this table only names the harness and says how to switch the better route on.

import type { Harness, ReplyDelivery } from "./types.ts";

export interface HarnessInfo {
  label: string;
  /** The best route this harness supports, and what sets it up. */
  best: ReplyDelivery;
  setup: string;
}

export const HARNESS_INFO: Record<Harness, HarnessInfo> = {
  pi: { label: "Pi", best: "live", setup: "the Pi extension (integrations/pi) delivers replies into the running session" },
  claude: { label: "Claude Code", best: "boundary", setup: "the Claude Code hooks hand replies over when the session stops or is prompted" },
  codex: { label: "Codex", best: "pull", setup: "the agent collects replies with `inbox replies`; live delivery is not verified yet" },
  manual: { label: "Manual", best: "pull", setup: "replies are collected with `inbox replies`" },
};

export const DELIVERY_LABEL: Record<ReplyDelivery, string> = {
  live: "Replies arrive in the running session",
  boundary: "Replies arrive when the session next stops or is prompted, or are typed into its terminal when it is free in herdr",
  pull: "Replies wait until the agent asks for them, or are typed into its terminal when it is free in herdr",
  none: "This session cannot receive replies",
};
