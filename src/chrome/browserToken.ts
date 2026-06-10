import { BROWSER_TOKEN_STORAGE_KEY } from "../shared/constants";
import type { StorageAdapter } from "./diagnostics";

export { BROWSER_TOKEN_STORAGE_KEY } from "../shared/constants";

export type BrowserAuthState = {
  browserToken?: string;
  tokenConfigured: boolean;
};

const storageQueues = new WeakMap<StorageAdapter, Promise<unknown>>();

async function getStoredString(storage: StorageAdapter, key: string): Promise<string | undefined> {
  const value = await storage.get<unknown>(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runSerialized<T>(storage: StorageAdapter, operation: () => Promise<T>): Promise<T> {
  const previous = storageQueues.get(storage) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  storageQueues.set(storage, next.catch(() => undefined));
  return next;
}

export function getBrowserAuthState(storage: StorageAdapter): Promise<BrowserAuthState> {
  return runSerialized(storage, async () => {
    const browserToken = await getStoredString(storage, BROWSER_TOKEN_STORAGE_KEY);

    return {
      ...(browserToken ? { browserToken } : {}),
      tokenConfigured: browserToken !== undefined,
    };
  });
}

export function ensureBrowserToken(storage: StorageAdapter): Promise<string> {
  return runSerialized(storage, async () => {
    const existing = await getStoredString(storage, BROWSER_TOKEN_STORAGE_KEY);

    if (existing) {
      return existing;
    }

    const token = globalThis.crypto.randomUUID();
    await storage.set(BROWSER_TOKEN_STORAGE_KEY, token);
    return token;
  });
}

export function regenerateBrowserToken(storage: StorageAdapter): Promise<string> {
  return runSerialized(storage, async () => {
    const token = globalThis.crypto.randomUUID();
    await storage.set(BROWSER_TOKEN_STORAGE_KEY, token);
    return token;
  });
}

export function clearBrowserToken(storage: StorageAdapter): Promise<void> {
  return runSerialized(storage, async () => {
    await storage.remove(BROWSER_TOKEN_STORAGE_KEY);
  });
}
