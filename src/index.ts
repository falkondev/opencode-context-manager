import { getDbPath, dbExists, loadConfig } from "./utils/config.ts";
import { setLanguage } from "./utils/i18n.ts";
import { logger, LOG_FILE } from "./utils/logger.ts";
import { SessionManager } from "./managers/session-manager.ts";
import { Dashboard } from "./ui/dashboard.ts";

async function main(): Promise<void> {
  // Load user config
  const config = loadConfig();
  setLanguage(config.language);

  // Initialise logger as early as possible (before TUI takes over stdout/stderr)
  logger.init(config.logLevel);
  logger.info("main", "opencode-context-manager starting", {
    version: process.env["npm_package_version"] ?? "dev",
    pid: process.pid,
    dbPath: getDbPath(),
    logFile: LOG_FILE,
    language: config.language,
    refreshInterval: config.refreshInterval,
  });

  // Verify OpenCode database exists
  if (!dbExists()) {
    const dbPath = getDbPath();
    logger.error("main", `Database not found: ${dbPath}`);
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
    logger.debug("main", `Session selected: ${id}`);
    const metrics = manager.selectSession(id);
    if (metrics) {
      dashboard.update(manager.getSummaries(), metrics);
    }
  });

  // Wire up: refresh request from UI → manager
  dashboard.onRefresh(() => {
    logger.debug("main", "Manual refresh triggered");
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
    logger.info("main", "Shutting down");
    manager.stop();
    dashboard.destroy();
    logger.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error("main", `Fatal error: ${msg}`, err);
  logger.close();
  console.error(`\n  Fatal error: ${msg}\n`);
  process.exit(1);
});
