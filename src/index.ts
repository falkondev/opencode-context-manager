import { getDbPath, dbExists, loadConfig } from "./utils/config.ts";
import { setLanguage } from "./utils/i18n.ts";
import { SessionManager } from "./managers/session-manager.ts";
import { Dashboard } from "./ui/dashboard.ts";

async function main(): Promise<void> {
  // Load user config
  const config = loadConfig();
  setLanguage(config.language);

  // Verify OpenCode database exists
  if (!dbExists()) {
    const dbPath = getDbPath();
    console.error(`\n  OpenCode database not found: ${dbPath}`);
    console.error("  Run OpenCode at least once, then restart this tool.\n");
    process.exit(1);
  }

  const dbPath = getDbPath();

  // Initialise data layer
  const manager = new SessionManager(dbPath);

  // Initialise UI
  const dashboard = new Dashboard(config);

  // Wire up: session selection from UI → manager
  dashboard.onSelect((id) => {
    const metrics = manager.selectSession(id);
    if (metrics) {
      dashboard.update(manager.getSummaries(), metrics);
    }
  });

  // Wire up: refresh request from UI → manager
  dashboard.onRefresh(() => {
    manager.refresh();
  });

  // Wire up: data changes from manager → UI
  manager.onRefresh((summaries, current) => {
    dashboard.update(summaries, current);
  });

  // Start polling and initial load
  manager.start();

  // Clean shutdown on process signals
  const shutdown = () => {
    manager.stop();
    dashboard.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  Fatal error: ${msg}\n`);
  process.exit(1);
});
