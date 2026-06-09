import { DIAGNOSTIC_LOG_LIMIT } from "../shared/constants";

const DIAGNOSTICS_STORAGE_KEY = "diagnostics";

export type DiagnosticEntry = {
  timestamp: number;
  phase: string;
  message: string;
};

export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<DiagnosticEntry>;

  return (
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    typeof entry.phase === "string" &&
    entry.phase.length > 0 &&
    typeof entry.message === "string" &&
    entry.message.length > 0
  );
}

async function readStoredDiagnostics(storage: StorageAdapter): Promise<DiagnosticEntry[]> {
  const storedValue = await storage.get<unknown>(DIAGNOSTICS_STORAGE_KEY);

  if (!Array.isArray(storedValue)) {
    return [];
  }

  return storedValue.filter(isDiagnosticEntry);
}

export async function appendDiagnostic(
  storage: StorageAdapter,
  entry: DiagnosticEntry,
): Promise<DiagnosticEntry[]> {
  const diagnostics = await readStoredDiagnostics(storage);
  const nextDiagnostics = [...diagnostics, entry].slice(-DIAGNOSTIC_LOG_LIMIT);

  await storage.set(DIAGNOSTICS_STORAGE_KEY, nextDiagnostics);

  return nextDiagnostics;
}

export function listDiagnostics(storage: StorageAdapter): Promise<DiagnosticEntry[]> {
  return readStoredDiagnostics(storage);
}

export function clearDiagnostics(storage: StorageAdapter): Promise<void> {
  return storage.remove(DIAGNOSTICS_STORAGE_KEY);
}

export function chromeStorageAdapter(): StorageAdapter {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await chrome.storage.local.get(key);
      return result[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await chrome.storage.local.remove(key);
    },
  };
}
