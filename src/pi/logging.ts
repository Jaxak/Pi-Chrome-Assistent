import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type BrowserConnectLogger = {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
};

export type BrowserConnectLogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
};

export type MemoryBrowserConnectLogger = BrowserConnectLogger & {
  readonly entries: readonly BrowserConnectLogEntry[];
};

function createLogEntry(
  level: BrowserConnectLogEntry["level"],
  message: string,
  details?: Record<string, unknown>,
): BrowserConnectLogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
  };
}

function createBaseLogger(
  writeEntry: (entry: BrowserConnectLogEntry) => void,
): BrowserConnectLogger {
  return {
    info(message, details) {
      writeEntry(createLogEntry("info", message, details));
    },
    warn(message, details) {
      writeEntry(createLogEntry("warn", message, details));
    },
    error(message, details) {
      writeEntry(createLogEntry("error", message, details));
    },
  };
}

export function createMemoryLogger(): MemoryBrowserConnectLogger {
  const entries: BrowserConnectLogEntry[] = [];
  const logger = createBaseLogger((entry) => {
    entries.push(entry);
  });

  return {
    ...logger,
    get entries() {
      return entries;
    },
  };
}

export function createFileLogger(path: string): BrowserConnectLogger {
  let isWritable = true;

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    isWritable = false;
  }

  return createBaseLogger((entry) => {
    if (!isWritable) {
      return;
    }

    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      isWritable = false;
    }
  });
}
