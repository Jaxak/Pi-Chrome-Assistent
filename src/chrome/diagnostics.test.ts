import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_LOG_LIMIT } from "../shared/constants";
import {
  appendDiagnostic,
  clearDiagnostics,
  listDiagnostics,
  type DiagnosticEntry,
  type StorageAdapter,
} from "./diagnostics";

class FakeStorageAdapter implements StorageAdapter {
  private readonly values = new Map<string, unknown>();

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

describe("diagnostics", () => {
  it("caps logs at DIAGNOSTIC_LOG_LIMIT", async () => {
    const storage = new FakeStorageAdapter();

    for (let index = 0; index < DIAGNOSTIC_LOG_LIMIT + 3; index += 1) {
      await appendDiagnostic(storage, {
        timestamp: 1_710_000_000_000 + index,
        phase: "diagnostics",
        message: `message-${index}`,
      });
    }

    const diagnostics = await listDiagnostics(storage);

    expect(diagnostics).toHaveLength(DIAGNOSTIC_LOG_LIMIT);
    expect(diagnostics[0]?.message).toBe("message-3");
    expect(diagnostics.at(-1)?.message).toBe(`message-${DIAGNOSTIC_LOG_LIMIT + 2}`);
  });

  it("returns entries with timestamp, phase, and message", async () => {
    const storage = new FakeStorageAdapter();
    const entry: DiagnosticEntry = {
      timestamp: 1_710_000_000_000,
      phase: "sendSelection",
      message: "Delivery failed",
    };

    await appendDiagnostic(storage, entry);

    await expect(listDiagnostics(storage)).resolves.toEqual([entry]);
  });

  it("clears stored diagnostics", async () => {
    const storage = new FakeStorageAdapter();

    await appendDiagnostic(storage, {
      timestamp: 1_710_000_000_000,
      phase: "targets",
      message: "Connection failed",
    });

    await clearDiagnostics(storage);

    await expect(listDiagnostics(storage)).resolves.toEqual([]);
  });
});
