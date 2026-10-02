// Machine-wide integrations are opt-in. Local harness usage/session reads are separate from
// the authenticated Codex account request; disabling account polling never reads its login.
export const STARTUP_KEYS = {
  codexAccountPolling: "INBOX_CODEX_ACCOUNT_POLLING",
  presenceDiscovery: "INBOX_PRESENCE_DISCOVERY",
  browserCleanup: "INBOX_BROWSER_CLEANUP",
} as const;

export interface StartupConfig {
  codexAccountPolling: boolean;
  presenceDiscovery: boolean;
  browserCleanup: boolean;
}

/** Missing is off; reject typos rather than silently granting process/credential access. */
export function startupConfig(env: Record<string, string | undefined> = process.env): StartupConfig {
  const enabled = (key: string): boolean => {
    const value = env[key]?.trim().toLowerCase();
    if (!value || value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
    throw new Error(`${key} must be 1/true or 0/false`);
  };
  return {
    codexAccountPolling: enabled(STARTUP_KEYS.codexAccountPolling),
    presenceDiscovery: enabled(STARTUP_KEYS.presenceDiscovery),
    browserCleanup: enabled(STARTUP_KEYS.browserCleanup),
  };
}

/** Keep the side-effect boundary testable without a real socket, account or process watcher. */
export function startIntegrations(config: StartupConfig, services: {
  herdr: { start(): void };
  machine: { start(): void } | undefined;
  usage: { start(options: { accountPolling: boolean }): void };
}): void {
  if (config.presenceDiscovery) services.herdr.start();
  if (config.browserCleanup) services.machine?.start();
  services.usage.start({ accountPolling: config.codexAccountPolling });
}
