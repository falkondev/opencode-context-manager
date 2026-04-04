import path from "path";
import os from "os";
import fs from "fs";

export const OPENCODE_DEFAULT_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
);

export const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode-cm");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export type Language = "en" | "pt-BR";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface IAppConfig {
  language: Language;
  refreshInterval: number; // seconds
  logLevel: LogLevel;
}

const DEFAULT_CONFIG: IAppConfig = {
  language: "en",
  refreshInterval: 2,
  logLevel: "debug",
};

export function getOpencodePath(): string {
  return process.env["OPENCODE_PATH"] ?? OPENCODE_DEFAULT_PATH;
}

export function getDbPath(): string {
  return path.join(getOpencodePath(), "opencode.db");
}

export function dbExists(): boolean {
  try {
    return fs.existsSync(getDbPath());
  } catch {
    return false;
  }
}

export function loadConfig(): IAppConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<IAppConfig>;
    return {
      language: parsed.language ?? DEFAULT_CONFIG.language,
      refreshInterval: parsed.refreshInterval ?? DEFAULT_CONFIG.refreshInterval,
      logLevel: parsed.logLevel ?? DEFAULT_CONFIG.logLevel,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: IAppConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // Silent — config save failure is non-critical
  }
}
