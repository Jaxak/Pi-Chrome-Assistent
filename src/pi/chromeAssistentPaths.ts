import { homedir } from "node:os";
import { join } from "node:path";

export function getChromeAssistentRuntimeDir(home = homedir()): string {
  return join(home, ".pi", "chrome-assistent");
}

export function getGlobalBrokerTokenPath(home = homedir()): string {
  return join(getChromeAssistentRuntimeDir(home), "broker.token");
}

export function getTrustedBrowsersPath(home = homedir()): string {
  return join(getChromeAssistentRuntimeDir(home), "trusted-browsers.json");
}

export function getChromeAssistentLogPath(home = homedir()): string {
  return join(getChromeAssistentRuntimeDir(home), "chrome-assistent.log");
}
