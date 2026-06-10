import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_BROKER_HOST, DEFAULT_BROKER_PORT } from "../shared/constants";
import {
  getChromeAssistentLogPath,
  getGlobalBrokerTokenPath,
  getTrustedBrowsersPath,
} from "./chromeAssistentPaths";
import { createMemoryLogger } from "./logging";
import type { ConnectedTargetClient } from "./targetClient";

async function importBrowserConnectExtensionModule() {
  return import("./browserConnectExtension");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:crypto");
  vi.doUnmock("node:fs");
  vi.doUnmock("./broker");
  vi.doUnmock("./logging");
  vi.doUnmock("./targetClient");
  vi.doUnmock("./trustedBrowserStore");
});

describe("readOrCreateSharedToken", () => {
  it("creates new token files with restrictive permissions", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenFilePath = join(tempDir, "browser-connect.token");
    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      const token = readOrCreateSharedToken(tokenFilePath);

      expect(token).toHaveLength(36);
      expect(statSync(tokenFilePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the global Chrome Assistent broker token path instead of the cwd-local .pi directory", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const tempCwd = mkdtempSync(join(tmpdir(), "browser-connect-cwd-"));
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();

    process.env.HOME = tempHome;
    process.chdir(tempCwd);

    try {
      const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();
      const token = readOrCreateSharedToken();
      const globalTokenPath = getGlobalBrokerTokenPath(tempHome);
      const legacyTokenPath = join(tempCwd, ".pi", "browser-connect.token");

      expect(token).toHaveLength(36);
      expect(statSync(globalTokenPath).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(globalTokenPath)).toBe(true);
      expect(fs.existsSync(legacyTokenPath)).toBe(false);
    } finally {
      process.chdir(originalCwd);

      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempHome, { recursive: true, force: true });
      rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked ancestor of the global Chrome Assistent broker token path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const tempHome = join(tempDir, "home");
    const realPiDir = join(tempDir, "real-pi");
    const redirectedTokenPath = join(realPiDir, "chrome-assistent", "broker.token");
    const originalHome = process.env.HOME;

    process.env.HOME = tempHome;

    try {
      mkdirSync(tempHome, { recursive: true, mode: 0o700 });
      mkdirSync(realPiDir, { recursive: true, mode: 0o700 });
      symlinkSync(realPiDir, join(tempHome, ".pi"));

      const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

      expect(() => readOrCreateSharedToken()).toThrow(/token directory.*symlink/i);
      expect(fs.existsSync(redirectedTokenPath)).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tightens permissions on existing token directories before reuse", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenDirPath = join(tempDir, ".pi");
    const tokenFilePath = join(tokenDirPath, "browser-connect.token");
    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      mkdirSync(tokenDirPath, { mode: 0o755 });
      writeFileSync(tokenFilePath, "existing-token\n", { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(tokenDirPath, 0o755);

      expect(readOrCreateSharedToken(tokenFilePath)).toBe("existing-token");
      expect(statSync(tokenDirPath).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tightens permissions on existing token files before reuse", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenFilePath = join(tempDir, "browser-connect.token");
    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      writeFileSync(tokenFilePath, "existing-token\n", { encoding: "utf8", mode: 0o644 });
      fs.chmodSync(tokenFilePath, 0o644);

      expect(readOrCreateSharedToken(tokenFilePath)).toBe("existing-token");
      expect(statSync(tokenFilePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads and hardens existing token files via a secure descriptor instead of path operations", async () => {
    const tokenFilePath = "/virtual/.pi/browser-connect.token";
    const tokenDirectoryPath = "/virtual/.pi";
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const directoryStats = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as fs.Stats;
    const fileStats = {
      isFile: () => true,
    } as fs.Stats;
    const openSync = vi.fn((path: fs.PathLike, flags: number | string) => {
      if (path === tokenFilePath) {
        return 123;
      }

      return actualFs.openSync(path, flags);
    });
    const readFileSync = vi.fn((path: fs.PathOrFileDescriptor, encoding: BufferEncoding) => {
      if (path === tokenFilePath) {
        throw new Error("path-based token reads must not be used");
      }

      if (path === 123 && encoding === "utf8") {
        return "secure-token\n";
      }

      return actualFs.readFileSync(path, encoding);
    });
    const chmodSync = vi.fn((path: fs.PathLike, mode: fs.Mode) => {
      if (path === tokenFilePath && mode === 0o600) {
        throw new Error("path-based token chmod must not be used");
      }
    });
    const fchmodSync = vi.fn((fd: number, mode: fs.Mode) => {
      expect(fd).toBe(123);
      expect(mode).toBe(0o600);
    });
    const closeSync = vi.fn((fd: number) => {
      expect(fd).toBe(123);
    });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      constants: {
        ...actualFs.constants,
        O_NOFOLLOW: actualFs.constants.O_NOFOLLOW ?? 0x20000,
      },
      lstatSync: vi.fn((path: fs.PathLike) => {
        if (path === tokenDirectoryPath) {
          return directoryStats;
        }

        if (path === tokenFilePath) {
          return fileStats;
        }

        return actualFs.lstatSync(path);
      }),
      mkdirSync: vi.fn(),
      chmodSync,
      openSync,
      fstatSync: vi.fn((fd: number) => {
        if (fd === 123) {
          return fileStats;
        }

        return actualFs.fstatSync(fd);
      }),
      readFileSync,
      fchmodSync,
      closeSync,
    }));

    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    expect(readOrCreateSharedToken(tokenFilePath)).toBe("secure-token");
    expect(openSync).toHaveBeenCalledWith(tokenFilePath, expect.any(Number));
    expect(readFileSync).toHaveBeenCalledWith(123, "utf8");
    expect(readFileSync).not.toHaveBeenCalledWith(tokenFilePath, "utf8");
    expect(chmodSync).not.toHaveBeenCalledWith(tokenFilePath, 0o600);
    expect(fchmodSync).toHaveBeenCalledWith(123, 0o600);
    expect(closeSync).toHaveBeenCalledWith(123);

    const [, flags] = openSync.mock.calls[0];
    expect(typeof flags).toBe("number");
    expect((flags as number) & (actualFs.constants.O_NOFOLLOW ?? 0x20000)).not.toBe(0);
  });

  it("throws a security error when O_NOFOLLOW is unavailable", async () => {
    const tokenFilePath = "/virtual/.pi/browser-connect.token";
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

    const openSync = vi.fn(() => {
      throw new Error("token file open should not be attempted without O_NOFOLLOW support");
    });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      constants: Object.fromEntries(
        Object.entries(actualFs.constants).filter(([key]) => key !== "O_NOFOLLOW"),
      ),
      lstatSync: vi.fn(() => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }),
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
      openSync,
    }));

    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    expect(() => readOrCreateSharedToken(tokenFilePath)).toThrow(/o_nofollow/i);
    expect(openSync).not.toHaveBeenCalled();
  });

  it("re-reads the token file when an exclusive create loses a race", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenFilePath = join(tempDir, "browser-connect.token");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const noFollowFlag = actualFs.constants.O_NOFOLLOW ?? 0;
    const readFlags = actualFs.constants.O_RDONLY | noFollowFlag;
    const createFlags = actualFs.constants.O_CREAT | actualFs.constants.O_EXCL | actualFs.constants.O_WRONLY | noFollowFlag;
    let readAttempts = 0;

    vi.doMock("node:crypto", () => ({
      randomUUID: vi.fn(() => "generated-token-that-should-not-be-returned"),
    }));
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync: vi.fn((path: fs.PathLike, flags: number | string, mode?: fs.Mode) => {
        if (path === tokenFilePath && flags === readFlags && readAttempts === 0) {
          readAttempts += 1;
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }

        if (path === tokenFilePath && flags === createFlags) {
          actualFs.writeFileSync(tokenFilePath, "existing-token\n", { encoding: "utf8", mode: 0o600 });
          const error = new Error("exists") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }

        return mode === undefined ? actualFs.openSync(path, flags) : actualFs.openSync(path, flags, mode);
      }),
    }));

    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      expect(readOrCreateSharedToken(tokenFilePath)).toBe("existing-token");
      expect(actualFs.readFileSync(tokenFilePath, "utf8").trim()).toBe("existing-token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when hardening permissions on an existing token directory fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenDirPath = join(tempDir, ".pi");
    const tokenFilePath = join(tokenDirPath, "browser-connect.token");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

    actualFs.mkdirSync(tokenDirPath, { mode: 0o755 });
    actualFs.writeFileSync(tokenFilePath, "existing-token\n", { encoding: "utf8", mode: 0o600 });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      chmodSync: vi.fn((path: fs.PathLike, mode: fs.Mode) => {
        if (path === tokenDirPath && mode === 0o700) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }

        return actualFs.chmodSync(path, mode);
      }),
    }));

    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      expect(() => readOrCreateSharedToken(tokenFilePath)).toThrow(/failed to secure token directory/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when hardening permissions on an existing token file fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenFilePath = join(tempDir, "browser-connect.token");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

    actualFs.writeFileSync(tokenFilePath, "existing-token\n", { encoding: "utf8", mode: 0o644 });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      fchmodSync: vi.fn((fd: number, mode: fs.Mode) => {
        if (mode === 0o600) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }

        return actualFs.fchmodSync(fd, mode);
      }),
    }));

    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      expect(() => readOrCreateSharedToken(tokenFilePath)).toThrow(/failed to secure token file/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an existing token directory symlink", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const realTokenDirPath = join(tempDir, "real-token-dir");
    const symlinkTokenDirPath = join(tempDir, ".pi");
    const tokenFilePath = join(symlinkTokenDirPath, "browser-connect.token");
    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      mkdirSync(realTokenDirPath, { mode: 0o700 });
      symlinkSync(realTokenDirPath, symlinkTokenDirPath);

      expect(() => readOrCreateSharedToken(tokenFilePath)).toThrow(/token directory.*symlink/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an existing token file symlink", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenDirPath = join(tempDir, ".pi");
    const realTokenFilePath = join(tempDir, "real-browser-connect.token");
    const tokenFilePath = join(tokenDirPath, "browser-connect.token");
    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      mkdirSync(tokenDirPath, { mode: 0o700 });
      writeFileSync(realTokenFilePath, "existing-token\n", { encoding: "utf8", mode: 0o600 });
      symlinkSync(realTokenFilePath, tokenFilePath);

      expect(() => readOrCreateSharedToken(tokenFilePath)).toThrow(/token file.*symlink/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an existing token path that is not a regular file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-token-"));
    const tokenDirPath = join(tempDir, ".pi");
    const tokenFilePath = join(tokenDirPath, "browser-connect.token");
    const { readOrCreateSharedToken } = await importBrowserConnectExtensionModule();

    try {
      mkdirSync(tokenDirPath, { mode: 0o700 });
      mkdirSync(tokenFilePath, { mode: 0o700 });

      expect(() => readOrCreateSharedToken(tokenFilePath)).toThrow(/token file.*regular file/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("browserConnectExtension", () => {
  it("writes logs under the global Chrome Assistent runtime area instead of the cwd-local .pi directory", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const tempCwd = mkdtempSync(join(tmpdir(), "browser-connect-cwd-"));
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    const createFileLogger = vi.fn(() => createMemoryLogger());

    vi.doMock("./logging", async () => {
      const actual = await vi.importActual<typeof import("./logging")>("./logging");

      return {
        ...actual,
        createFileLogger,
      };
    });

    process.env.HOME = tempHome;
    process.chdir(tempCwd);

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      const pi = {
        registerCommand: vi.fn(),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;

      browserConnectExtension(pi);

      expect(createFileLogger).toHaveBeenCalledWith(getChromeAssistentLogPath(tempHome));
      expect(createFileLogger).not.toHaveBeenCalledWith(join(tempCwd, ".pi", "browser-connect.log"));
    } finally {
      process.chdir(originalCwd);

      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempHome, { recursive: true, force: true });
      rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  it("registers chrome-assistent-connect and chrome-assistent-auth commands", async () => {
    const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
    const registerCommand = vi.fn();
    const pi = {
      registerCommand,
      on: vi.fn(),
      getSessionName: vi.fn(() => "session"),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    browserConnectExtension(pi);

    expect(registerCommand).toHaveBeenCalledWith(
      "chrome-assistent-connect",
      expect.objectContaining({
        description: "Подключить текущую сессию Pi к локальному брокеру Chrome Assistent",
      }),
    );
    expect(registerCommand).toHaveBeenCalledWith(
      "chrome-assistent-auth",
      expect.objectContaining({
        description: "Добавить токен доверенного браузера Chrome Assistent",
      }),
    );
    expect(registerCommand).not.toHaveBeenCalledWith("browser-connect", expect.anything());
  });

  it("prompts for a browser token when chrome-assistent-auth runs", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const originalHome = process.env.HOME;

    process.env.HOME = tempHome;

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let authHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-auth") {
            authHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const input = vi.fn(async () => undefined);
      const notify = vi.fn();
      const ctx = {
        ui: {
          input,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(authHandler).toBeDefined();
      await expect(authHandler?.("", ctx)).resolves.toBeUndefined();

      expect(input).toHaveBeenCalledWith(
        "Токен браузера",
        "Вставьте токен из вкладки «Авторизация»",
      );
      expect(notify).toHaveBeenCalledWith("Токен браузера не указан", "warning");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("stores the browser token and keeps duplicate auth idempotent", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const originalHome = process.env.HOME;

    process.env.HOME = tempHome;

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let authHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-auth") {
            authHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const input = vi.fn()
        .mockResolvedValueOnce("  browser-token  ")
        .mockResolvedValueOnce("browser-token");
      const notify = vi.fn();
      const ctx = {
        ui: {
          input,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(authHandler).toBeDefined();
      await expect(authHandler?.("", ctx)).resolves.toBeUndefined();
      await expect(authHandler?.("", ctx)).resolves.toBeUndefined();

      expect(notify).toHaveBeenNthCalledWith(1, "Токен браузера сохранён", "info");
      expect(notify).toHaveBeenNthCalledWith(2, "Токен браузера сохранён", "info");
      const trustedBrowsersPath = getTrustedBrowsersPath(tempHome);
      expect(statSync(trustedBrowsersPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token" },
      ]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("shows a user-facing error when browser token prompt fails", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const originalHome = process.env.HOME;
    const addTrustedBrowserToken = vi.fn();
    const logger = createMemoryLogger();

    process.env.HOME = tempHome;

    vi.doMock("./trustedBrowserStore", () => ({
      addTrustedBrowserToken,
    }));
    vi.doMock("./logging", () => ({
      createFileLogger: vi.fn(() => logger),
    }));

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let authHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-auth") {
            authHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const input = vi.fn(async () => {
        throw new Error("окно ввода недоступно");
      });
      const notify = vi.fn();
      const ctx = {
        ui: {
          input,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(authHandler).toBeDefined();
      await expect(authHandler?.("", ctx)).rejects.toThrow("окно ввода недоступно");

      expect(addTrustedBrowserToken).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        "Не удалось сохранить токен браузера: окно ввода недоступно",
        "error",
      );
      expect(logger.entries).toContainEqual(expect.objectContaining({
        level: "error",
        message: "browser_connect.auth.failed",
        details: expect.objectContaining({
          error: "окно ввода недоступно",
        }),
      }));
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("shows a user-facing error when browser token storage fails", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const originalHome = process.env.HOME;
    const addTrustedBrowserToken = vi.fn(async () => {
      throw new Error("хранилище токенов недоступно");
    });
    const logger = createMemoryLogger();

    process.env.HOME = tempHome;

    vi.doMock("./trustedBrowserStore", () => ({
      addTrustedBrowserToken,
    }));
    vi.doMock("./logging", () => ({
      createFileLogger: vi.fn(() => logger),
    }));

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let authHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-auth") {
            authHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const input = vi.fn().mockResolvedValue("browser-token");
      const notify = vi.fn();
      const ctx = {
        ui: {
          input,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(authHandler).toBeDefined();
      await expect(authHandler?.("", ctx)).rejects.toThrow("хранилище токенов недоступно");

      expect(addTrustedBrowserToken).toHaveBeenCalledWith(getTrustedBrowsersPath(), "browser-token");
      expect(notify).toHaveBeenCalledWith(
        "Не удалось сохранить токен браузера: хранилище токенов недоступно",
        "error",
      );
      expect(logger.entries).toContainEqual(expect.objectContaining({
        level: "error",
        message: "browser_connect.auth.failed",
        details: expect.objectContaining({
          error: "хранилище токенов недоступно",
        }),
      }));
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("retries with a fresh activation state when the first attempt disconnects before activation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-command-"));
    const originalCwd = process.cwd();
    const firstConnection: ConnectedTargetClient = {
      port: DEFAULT_BROKER_PORT,
      url: `ws://${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}`,
      metadata: {
        targetId: "target-1",
        alias: "frontend",
        cwd: "/repo/project",
        pid: 123,
        connectedAt: 1,
        lastSeenAt: 1,
      },
      isOpen: () => false,
      close: vi.fn(async () => undefined),
    };
    const secondConnection: ConnectedTargetClient = {
      port: 8765,
      url: `ws://${DEFAULT_BROKER_HOST}:8765`,
      metadata: {
        targetId: "target-1",
        alias: "frontend",
        cwd: "/repo/project",
        pid: 123,
        connectedAt: 2,
        lastSeenAt: 2,
      },
      isOpen: () => true,
      close: vi.fn(async () => undefined),
    };
    const connectTargetToBroker = vi.fn()
      .mockImplementationOnce(async (options: { onDisconnect?: () => void }) => {
        options.onDisconnect?.();
        return firstConnection;
      })
      .mockImplementationOnce(async () => secondConnection);
    const startBrokerClose = vi.fn(async () => undefined);
    const startBrokerServer = vi.fn(async () => ({
      port: secondConnection.port,
      close: startBrokerClose,
    }));

    vi.doMock("./targetClient", async () => {
      const actual = await vi.importActual<typeof import("./targetClient")>("./targetClient");

      return {
        ...actual,
        buildTargetMetadata: vi.fn(async () => ({
          targetId: "target-1",
          alias: "frontend",
          cwd: "/repo/project",
          pid: 123,
          connectedAt: 1,
          lastSeenAt: 1,
        })),
        getTargetDisplayLabel: vi.fn(() => "frontend"),
        connectTargetToBroker,
      };
    });
    vi.doMock("./broker", () => ({
      startBrokerServer,
    }));

    process.chdir(tempDir);

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-connect") {
            commandHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const setStatus = vi.fn();
      const notify = vi.fn();
      const ctx = {
        cwd: "/repo/project",
        isIdle: () => true,
        ui: {
          setStatus,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(commandHandler).toBeDefined();
      await expect(commandHandler?.("frontend", ctx)).resolves.toBeUndefined();

      expect(connectTargetToBroker).toHaveBeenCalledTimes(2);
      expect(connectTargetToBroker.mock.calls[0][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: DEFAULT_BROKER_PORT,
      });
      expect(connectTargetToBroker.mock.calls[1][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: secondConnection.port,
      });
      expect(startBrokerServer).toHaveBeenCalledOnce();
      expect(firstConnection.close).toHaveBeenCalledOnce();
      expect(secondConnection.close).not.toHaveBeenCalled();
      expect(startBrokerClose).not.toHaveBeenCalled();
      expect(setStatus).toHaveBeenCalledWith(
        "chrome-assistent-connect",
        `/chrome-assistent-connect: frontend · подключено · ${DEFAULT_BROKER_HOST}:${secondConnection.port}`,
      );
      expect(notify).toHaveBeenCalledWith(
        `Подключение /chrome-assistent-connect активно: frontend · ${DEFAULT_BROKER_HOST}:${secondConnection.port}`,
        "info",
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retries a normal broker connection when broker startup loses an address-in-use race", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-command-"));
    const originalCwd = process.cwd();
    const connectError = new Error("connect ECONNREFUSED 127.0.0.1:8765");
    const bindRaceError = new Error("listen EADDRINUSE: address already in use 127.0.0.1:8765") as NodeJS.ErrnoException;
    bindRaceError.code = "EADDRINUSE";
    const connectedTarget: ConnectedTargetClient = {
      port: DEFAULT_BROKER_PORT,
      url: `ws://${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}`,
      metadata: {
        targetId: "target-1",
        alias: "frontend",
        cwd: "/repo/project",
        pid: 123,
        connectedAt: 2,
        lastSeenAt: 2,
      },
      isOpen: () => true,
      close: vi.fn(async () => undefined),
    };
    const connectTargetToBroker = vi.fn()
      .mockRejectedValueOnce(connectError)
      .mockResolvedValueOnce(connectedTarget);
    const startBrokerServer = vi.fn().mockRejectedValueOnce(bindRaceError);

    vi.doMock("./targetClient", async () => {
      const actual = await vi.importActual<typeof import("./targetClient")>("./targetClient");

      return {
        ...actual,
        buildTargetMetadata: vi.fn(async () => ({
          targetId: "target-1",
          alias: "frontend",
          cwd: "/repo/project",
          pid: 123,
          connectedAt: 1,
          lastSeenAt: 1,
        })),
        getTargetDisplayLabel: vi.fn(() => "frontend"),
        connectTargetToBroker,
      };
    });
    vi.doMock("./broker", () => ({
      startBrokerServer,
    }));

    process.chdir(tempDir);

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-connect") {
            commandHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const setStatus = vi.fn();
      const notify = vi.fn();
      const ctx = {
        cwd: "/repo/project",
        isIdle: () => true,
        ui: {
          setStatus,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(commandHandler).toBeDefined();
      await expect(commandHandler?.("frontend", ctx)).resolves.toBeUndefined();

      expect(connectTargetToBroker).toHaveBeenCalledTimes(2);
      expect(connectTargetToBroker.mock.calls[0][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: DEFAULT_BROKER_PORT,
      });
      expect(connectTargetToBroker.mock.calls[1][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: DEFAULT_BROKER_PORT,
      });
      expect(startBrokerServer).toHaveBeenCalledOnce();
      expect(setStatus).toHaveBeenCalledWith(
        "chrome-assistent-connect",
        `/chrome-assistent-connect: frontend · подключено · ${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}`,
      );
      expect(notify).toHaveBeenCalledWith(
        `Подключение /chrome-assistent-connect активно: frontend · ${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}`,
        "info",
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shows renamed Russian failure copy when connection setup fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-command-"));
    const originalCwd = process.cwd();
    const startupError = new Error("не удалось запустить локальный брокер");
    const connectTargetToBroker = vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:17345"));
    const startBrokerServer = vi.fn().mockRejectedValueOnce(startupError);

    vi.doMock("./targetClient", async () => {
      const actual = await vi.importActual<typeof import("./targetClient")>("./targetClient");

      return {
        ...actual,
        buildTargetMetadata: vi.fn(async () => ({
          targetId: "target-1",
          alias: "frontend",
          cwd: "/repo/project",
          pid: 123,
          connectedAt: 1,
          lastSeenAt: 1,
        })),
        getTargetDisplayLabel: vi.fn(() => "frontend"),
        connectTargetToBroker,
      };
    });
    vi.doMock("./broker", () => ({
      startBrokerServer,
    }));

    process.chdir(tempDir);

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-connect") {
            commandHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const setStatus = vi.fn();
      const notify = vi.fn();
      const ctx = {
        cwd: "/repo/project",
        isIdle: () => true,
        ui: {
          setStatus,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(commandHandler).toBeDefined();
      await expect(commandHandler?.("frontend", ctx)).rejects.toThrow(startupError);

      expect(connectTargetToBroker).toHaveBeenCalledOnce();
      expect(startBrokerServer).toHaveBeenCalledOnce();
      expect(setStatus).toHaveBeenCalledWith("chrome-assistent-connect", undefined);
      expect(notify).toHaveBeenCalledWith(
        "Не удалось выполнить /chrome-assistent-connect: не удалось запустить локальный брокер",
        "error",
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces token initialization failures through the normal command error path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-home-"));
    const tempHome = join(tempDir, "home");
    const realPiDir = join(tempDir, "real-pi");
    const originalHome = process.env.HOME;
    const createFileLogger = vi.fn(() => createMemoryLogger());

    vi.doMock("./logging", async () => {
      const actual = await vi.importActual<typeof import("./logging")>("./logging");

      return {
        ...actual,
        createFileLogger,
      };
    });

    process.env.HOME = tempHome;

    try {
      mkdirSync(tempHome, { recursive: true, mode: 0o700 });
      mkdirSync(realPiDir, { recursive: true, mode: 0o700 });
      symlinkSync(realPiDir, join(tempHome, ".pi"));

      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-connect") {
            commandHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const setStatus = vi.fn();
      const notify = vi.fn();
      const ctx = {
        cwd: "/repo/project",
        isIdle: () => true,
        ui: {
          setStatus,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(commandHandler).toBeDefined();
      await expect(commandHandler?.("frontend", ctx)).rejects.toThrow(/token directory.*symlink/i);

      expect(createFileLogger).toHaveBeenCalledOnce();
      expect(setStatus).toHaveBeenCalledWith("chrome-assistent-connect", undefined);
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/не удалось выполнить \/chrome-assistent-connect: .*token directory.*symlink/i),
        "error",
      );
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves owned-broker recovery by closing and replacing a failed owned broker", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "browser-connect-command-"));
    const originalCwd = process.cwd();
    const firstOwnedBrokerClose = vi.fn(async () => undefined);
    const secondOwnedBrokerClose = vi.fn(async () => undefined);
    const firstOwnedBrokerConnection: ConnectedTargetClient = {
      port: 8765,
      url: `ws://${DEFAULT_BROKER_HOST}:8765`,
      metadata: {
        targetId: "target-1",
        alias: "frontend",
        cwd: "/repo/project",
        pid: 123,
        connectedAt: 1,
        lastSeenAt: 1,
      },
      isOpen: () => true,
      close: vi.fn(async () => undefined),
    };
    const secondOwnedBrokerConnection: ConnectedTargetClient = {
      port: 9876,
      url: `ws://${DEFAULT_BROKER_HOST}:9876`,
      metadata: {
        targetId: "target-1",
        alias: "frontend",
        cwd: "/repo/project",
        pid: 123,
        connectedAt: 2,
        lastSeenAt: 2,
      },
      isOpen: () => true,
      close: vi.fn(async () => undefined),
    };
    const connectTargetToBroker = vi.fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:8765"))
      .mockResolvedValueOnce(firstOwnedBrokerConnection)
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(secondOwnedBrokerConnection);
    const startBrokerServer = vi.fn()
      .mockResolvedValueOnce({
        port: firstOwnedBrokerConnection.port,
        close: firstOwnedBrokerClose,
      })
      .mockResolvedValueOnce({
        port: secondOwnedBrokerConnection.port,
        close: secondOwnedBrokerClose,
      });

    vi.doMock("./targetClient", async () => {
      const actual = await vi.importActual<typeof import("./targetClient")>("./targetClient");

      return {
        ...actual,
        buildTargetMetadata: vi.fn(async () => ({
          targetId: "target-1",
          alias: "frontend",
          cwd: "/repo/project",
          pid: 123,
          connectedAt: 1,
          lastSeenAt: 1,
        })),
        getTargetDisplayLabel: vi.fn(() => "frontend"),
        connectTargetToBroker,
      };
    });
    vi.doMock("./broker", () => ({
      startBrokerServer,
    }));

    process.chdir(tempDir);

    try {
      const { default: browserConnectExtension } = await importBrowserConnectExtensionModule();
      let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
          if (name === "chrome-assistent-connect") {
            commandHandler = options.handler;
          }
        }),
        on: vi.fn(),
        getSessionName: vi.fn(() => "session"),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;
      const setStatus = vi.fn();
      const notify = vi.fn();
      const ctx = {
        cwd: "/repo/project",
        isIdle: () => true,
        ui: {
          setStatus,
          notify,
        },
      };

      browserConnectExtension(pi);

      expect(commandHandler).toBeDefined();
      await expect(commandHandler?.("frontend", ctx)).resolves.toBeUndefined();
      await expect(commandHandler?.("frontend", ctx)).resolves.toBeUndefined();

      expect(connectTargetToBroker).toHaveBeenCalledTimes(4);
      expect(connectTargetToBroker.mock.calls[0][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: DEFAULT_BROKER_PORT,
      });
      expect(connectTargetToBroker.mock.calls[1][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: firstOwnedBrokerConnection.port,
      });
      expect(connectTargetToBroker.mock.calls[2][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: firstOwnedBrokerConnection.port,
      });
      expect(connectTargetToBroker.mock.calls[3][0]).toMatchObject({
        host: DEFAULT_BROKER_HOST,
        port: secondOwnedBrokerConnection.port,
      });
      expect(firstOwnedBrokerConnection.close).toHaveBeenCalledOnce();
      expect(firstOwnedBrokerClose).toHaveBeenCalledOnce();
      expect(secondOwnedBrokerClose).not.toHaveBeenCalled();
      expect(startBrokerServer).toHaveBeenCalledTimes(2);
      expect(setStatus).toHaveBeenLastCalledWith(
        "chrome-assistent-connect",
        `/chrome-assistent-connect: frontend · подключено · ${DEFAULT_BROKER_HOST}:${secondOwnedBrokerConnection.port}`,
      );
      expect(notify).toHaveBeenLastCalledWith(
        `Подключение /chrome-assistent-connect активно: frontend · ${DEFAULT_BROKER_HOST}:${secondOwnedBrokerConnection.port}`,
        "info",
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("activateBrowserConnectConnection", () => {
  it("fails activation and cleans up when disconnect wins the activation race", async () => {
    const { activateBrowserConnectConnection } = await importBrowserConnectExtensionModule();
    const logger = createMemoryLogger();
    const close = vi.fn(async () => undefined);
    const setActiveConnection = vi.fn();
    const connection: ConnectedTargetClient = {
      port: 8765,
      url: "ws://127.0.0.1:8765",
      metadata: {
        targetId: "target-1",
        cwd: "/repo/project",
        pid: 123,
        connectedAt: 1,
        lastSeenAt: 1,
      },
      isOpen: () => false,
      close,
    };

    await expect(activateBrowserConnectConnection({
      connection,
      disconnectedBeforeActivation: true,
      setActiveConnection,
      label: "frontend",
      logger,
    })).rejects.toThrow(/завершения активации/i);

    expect(setActiveConnection).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "browser_connect.command.activation_aborted_disconnected",
      }),
    );
  });
});

describe("handleUnexpectedBrowserConnectDisconnect", () => {
  it("clears active connection state, status, and notifies the user", async () => {
    const { handleUnexpectedBrowserConnectDisconnect } = await importBrowserConnectExtensionModule();
    const clearActiveConnection = vi.fn();
    const setStatus = vi.fn();
    const notify = vi.fn();
    const logger = createMemoryLogger();

    handleUnexpectedBrowserConnectDisconnect({
      clearActiveConnection,
      ctx: {
        ui: {
          setStatus,
          notify,
        },
      },
      label: "frontend",
      port: 8765,
      logger,
    });

    expect(clearActiveConnection).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("chrome-assistent-connect", undefined);
    expect(notify).toHaveBeenCalledWith(
      "Подключение /chrome-assistent-connect прервано: frontend · 127.0.0.1:8765",
      "warning",
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "browser_connect.target.disconnected",
      }),
    );
  });

  it("clears and resets the owned broker when the active owned-broker target disconnects", async () => {
    const { handleUnexpectedBrowserConnectDisconnect } = await importBrowserConnectExtensionModule();
    const activeTargetConnection = { port: 8765 };
    const clearActiveConnection = vi.fn();
    const resetOwnedBroker = vi.fn();
    const setStatus = vi.fn();
    const notify = vi.fn();
    const logger = createMemoryLogger();

    handleUnexpectedBrowserConnectDisconnect({
      disconnectedConnection: activeTargetConnection,
      activeTargetConnection,
      ownedBroker: { port: 8765 },
      clearActiveConnection,
      resetOwnedBroker,
      ctx: {
        ui: {
          setStatus,
          notify,
        },
      },
      label: "frontend",
      port: 8765,
      logger,
    });

    expect(clearActiveConnection).toHaveBeenCalledOnce();
    expect(resetOwnedBroker).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("chrome-assistent-connect", undefined);
    expect(notify).toHaveBeenCalledWith(
      "Подключение /chrome-assistent-connect прервано: frontend · 127.0.0.1:8765",
      "warning",
    );
  });
});

describe("recoverOwnedBrokerAfterConnectFailure", () => {
  it("clears the owned broker after a failed reconnect so a fresh broker can be started", async () => {
    const { recoverOwnedBrokerAfterConnectFailure } = await importBrowserConnectExtensionModule();
    const closeOwnedBroker = vi.fn(async () => undefined);

    await expect(recoverOwnedBrokerAfterConnectFailure({
      attemptedPort: 8765,
      ownedBroker: { port: 8765 },
      closeOwnedBroker,
    })).resolves.toBe(true);

    expect(closeOwnedBroker).toHaveBeenCalledOnce();
  });
});

describe("startOwnedBrokerIfNeeded", () => {
  it("waits for an in-flight owned broker close before starting a fresh broker", async () => {
    const { startOwnedBrokerIfNeeded } = await importBrowserConnectExtensionModule();
    let resolveClose: (() => void) | undefined;
    const closingOwnedBroker = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    let ownedBroker: { port: number } | undefined = { port: 8765 };
    const startBroker = vi.fn(async () => ({
      port: 8765,
      close: vi.fn(async () => undefined),
    }));
    const setOwnedBroker = vi.fn((broker: { port: number }) => {
      ownedBroker = broker;
    });

    const startPromise = startOwnedBrokerIfNeeded({
      getOwnedBroker: () => ownedBroker,
      closingOwnedBroker,
      startBroker,
      setOwnedBroker,
    });

    await Promise.resolve();

    expect(startBroker).not.toHaveBeenCalled();

    ownedBroker = undefined;
    resolveClose?.();

    await expect(startPromise).resolves.toMatchObject({ port: 8765 });
    expect(startBroker).toHaveBeenCalledOnce();
    expect(setOwnedBroker).toHaveBeenCalledOnce();
  });

  it("does not start a broker when one still exists after the close settles", async () => {
    const { startOwnedBrokerIfNeeded } = await importBrowserConnectExtensionModule();
    const existingBroker = { port: 8765 };
    const startBroker = vi.fn(async () => ({
      port: 8765,
      close: vi.fn(async () => undefined),
    }));
    const setOwnedBroker = vi.fn();

    await expect(startOwnedBrokerIfNeeded({
      getOwnedBroker: () => existingBroker,
      closingOwnedBroker: Promise.resolve(),
      startBroker,
      setOwnedBroker,
    })).resolves.toBeUndefined();

    expect(startBroker).not.toHaveBeenCalled();
    expect(setOwnedBroker).not.toHaveBeenCalled();
  });
});
