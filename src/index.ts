import path from "path";
import os from "os";

const OPENCODE_DEFAULT_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
);

const OPENCODE_PATH = process.env["OPENCODE_PATH"] ?? OPENCODE_DEFAULT_PATH;

function printBanner(): void {
  console.log("");
  console.log("  opencode-context-manager");
  console.log("  ─────────────────────────────────────────");
  console.log("  Manages OpenCode AI sessions and context.");
  console.log("");
  console.log(`  OpenCode path : ${OPENCODE_PATH}`);
  console.log(`  Database      : ${path.join(OPENCODE_PATH, "opencode.db")}`);
  console.log("");
}

printBanner();
