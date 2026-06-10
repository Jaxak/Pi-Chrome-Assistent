import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

async function importTrustedBrowserStoreModule() {
  return import("./trustedBrowserStore");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("trustedBrowserStore", () => {
  it("adds a trusted browser token, reads it back, and hardens file permissions", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const { addTrustedBrowserToken, isTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });
      await expect(isTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toBe(true);
      await expect(isTrustedBrowserToken(trustedBrowsersPath, "other-token")).resolves.toBe(false);
      expect(statSync(trustedBrowsersPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps duplicate auth idempotent for the same exact token", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });
      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });

      expect(JSON.parse(readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
