import { homedir } from "node:os";
import { join } from "node:path";

export function getChromeAssistentRuntimeDir(home = homedir()): string {
  return join(home, ".pi", "chrome-assistent");
}

export function getChromeAssistentLogPath(home = homedir()): string {
  return join(getChromeAssistentRuntimeDir(home), "chrome-assistent.log");
}
