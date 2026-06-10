import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
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

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error("Unknown error");
}

function validateExistingLogDirectoryPath(logDirectoryPath: string): void {
  let stats: ReturnType<typeof lstatSync>;

  try {
    stats = lstatSync(logDirectoryPath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Log directory must not be a symlink: ${logDirectoryPath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Log directory must be a directory: ${logDirectoryPath}`);
  }
}

function ensureLogDirectoryPermissions(logFilePath: string): void {
  const logDirectoryPath = dirname(logFilePath);
  validateExistingLogDirectoryPath(logDirectoryPath);
  mkdirSync(logDirectoryPath, {
    recursive: true,
    mode: 0o700,
  });
  validateExistingLogDirectoryPath(logDirectoryPath);
  chmodSync(logDirectoryPath, 0o700);
}

function getNoFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("Secure log file operations require fs.constants.O_NOFOLLOW support");
  }

  return fsConstants.O_NOFOLLOW;
}

function openLogFile(path: string): number {
  try {
    return openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | getNoFollowFlag(),
      0o600,
    );
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ELOOP") {
      throw new Error(`Log file must not be a symlink: ${path}`);
    }

    throw error;
  }
}

function appendLogEntry(path: string, content: string): void {
  const fd = openLogFile(path);

  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`Log file must be a regular file: ${path}`);
    }

    fchmodSync(fd, 0o600);
    appendFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function createFileLogger(path: string): BrowserConnectLogger {
  let isWritable = true;

  try {
    ensureLogDirectoryPermissions(path);
  } catch {
    isWritable = false;
  }

  return createBaseLogger((entry) => {
    if (!isWritable) {
      return;
    }

    try {
      appendLogEntry(path, `${JSON.stringify(entry)}\n`);
    } catch {
      isWritable = false;
    }
  });
}
