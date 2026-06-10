import { afterEach, describe, expect, it, vi } from "vitest";

import type { StorageAdapter } from "./diagnostics";
import {
  BROWSER_TOKEN_STORAGE_KEY,
  ensureBrowserToken,
  getBrowserAuthState,
  regenerateBrowserToken,
} from "./browserToken";

class FakeStorageAdapter implements StorageAdapter {
  protected readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class DeferredSetStorageAdapter extends FakeStorageAdapter {
  private readonly releaseSetPromise: Promise<void>;
  private resolveSet!: () => void;

  constructor() {
    super();
    this.releaseSetPromise = new Promise<void>((resolve) => {
      this.resolveSet = resolve;
    });
  }

  override async set<T>(key: string, value: T): Promise<void> {
    await this.releaseSetPromise;
    await super.set(key, value);
  }

  releaseSet(): void {
    this.resolveSet();
  }
}

describe("browserToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates and persists a browser token", async () => {
    const storage = new FakeStorageAdapter();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    const token = await ensureBrowserToken(storage);

    expect(token).toBe("11111111-1111-4111-8111-111111111111");
    await expect(storage.get(BROWSER_TOKEN_STORAGE_KEY)).resolves.toBe(token);
    await expect(getBrowserAuthState(storage)).resolves.toEqual({
      browserToken: token,
      tokenConfigured: true,
    });
  });

  it("returns the same persisted token to concurrent ensure callers", async () => {
    const storage = new DeferredSetStorageAdapter();
    const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID");

    randomUuid
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");

    const firstPromise = ensureBrowserToken(storage);
    const secondPromise = ensureBrowserToken(storage);

    await Promise.resolve();
    await Promise.resolve();
    storage.releaseSet();

    await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(randomUuid).toHaveBeenCalledTimes(1);
    await expect(storage.get(BROWSER_TOKEN_STORAGE_KEY)).resolves.toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("regenerates the token and removes the old value", async () => {
    const storage = new FakeStorageAdapter();
    const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID");

    randomUuid
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");

    const first = await ensureBrowserToken(storage);
    const second = await regenerateBrowserToken(storage);

    expect(second).not.toBe(first);
    expect(second).toBe("22222222-2222-4222-8222-222222222222");
    await expect(storage.get(BROWSER_TOKEN_STORAGE_KEY)).resolves.toBe(second);
  });
});
