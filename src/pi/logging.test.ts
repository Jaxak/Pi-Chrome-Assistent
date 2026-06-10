import * as fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

async function importLoggingModule() {
  return import("./logging");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
});

describe("createFileLogger", () => {
  it("creates global runtime logs with restrictive directory and file permissions", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chrome-assistent-logging-"));
    const runtimeDir = join(tempDir, ".pi", "chrome-assistent");
    const logFilePath = join(runtimeDir, "chrome-assistent.log");
    const { createFileLogger } = await importLoggingModule();

    try {
      const logger = createFileLogger(logFilePath);

      logger.info("browser_connect.command.connected", {
        port: 8765,
      });

      expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
      expect(statSync(logFilePath).mode & 0o777).toBe(0o600);
      expect(readFileSync(logFilePath, "utf8")).toContain("browser_connect.command.connected");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes log entries through a secure descriptor with O_NOFOLLOW instead of path appends", async () => {
    const logFilePath = "/virtual/.pi/chrome-assistent/chrome-assistent.log";
    const logDirectoryPath = "/virtual/.pi/chrome-assistent";
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const directoryStats = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as fs.Stats;
    const fileStats = {
      isFile: () => true,
    } as fs.Stats;
    const openSync = vi.fn((path: fs.PathLike, flags: number | string) => {
      if (path === logFilePath) {
        return 123;
      }

      return actualFs.openSync(path, flags);
    });
    const appendFileSync = vi.fn((path: fs.PathOrFileDescriptor, data: string) => {
      if (path === logFilePath) {
        throw new Error("path-based log appends must not be used");
      }

      expect(path).toBe(123);
      expect(data).toContain("browser_connect.command.connected");
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
        if (path === logDirectoryPath) {
          return directoryStats;
        }

        return actualFs.lstatSync(path);
      }),
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
      openSync,
      fstatSync: vi.fn((fd: number) => {
        if (fd === 123) {
          return fileStats;
        }

        return actualFs.fstatSync(fd);
      }),
      fchmodSync,
      appendFileSync,
      closeSync,
    }));

    const { createFileLogger } = await importLoggingModule();
    const logger = createFileLogger(logFilePath);

    logger.info("browser_connect.command.connected", {
      port: 8765,
    });

    expect(openSync).toHaveBeenCalledWith(logFilePath, expect.any(Number), 0o600);
    expect(fchmodSync).toHaveBeenCalledWith(123, 0o600);
    expect(appendFileSync).toHaveBeenCalledWith(123, expect.stringContaining("browser_connect.command.connected"), "utf8");
    expect(appendFileSync).not.toHaveBeenCalledWith(logFilePath, expect.anything(), expect.anything());
    expect(closeSync).toHaveBeenCalledWith(123);

    const [, flags] = openSync.mock.calls[0];
    expect(typeof flags).toBe("number");
    expect((flags as number) & (actualFs.constants.O_NOFOLLOW ?? 0x20000)).not.toBe(0);
  });

  it("rejects a symlinked runtime ancestor directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chrome-assistent-logging-"));
    const homeDir = join(tempDir, "home");
    const realPiDir = join(tempDir, "real-pi");
    const symlinkPiDir = join(homeDir, ".pi");
    const redirectedLogFilePath = join(realPiDir, "chrome-assistent", "chrome-assistent.log");
    const logFilePath = join(symlinkPiDir, "chrome-assistent", "chrome-assistent.log");
    const { createFileLogger } = await importLoggingModule();

    try {
      mkdirSync(homeDir, { recursive: true, mode: 0o700 });
      mkdirSync(realPiDir, { recursive: true, mode: 0o700 });
      symlinkSync(realPiDir, symlinkPiDir);

      const logger = createFileLogger(logFilePath);
      logger.info("browser_connect.command.connected", {
        port: 8765,
      });

      expect(existsSync(redirectedLogFilePath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("revalidates the runtime directory before each write", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chrome-assistent-logging-"));
    const runtimeDir = join(tempDir, ".pi", "chrome-assistent");
    const redirectedRuntimeDir = join(tempDir, "redirected-runtime");
    const redirectedLogFilePath = join(redirectedRuntimeDir, "chrome-assistent.log");
    const logFilePath = join(runtimeDir, "chrome-assistent.log");
    const { createFileLogger } = await importLoggingModule();

    try {
      mkdirSync(redirectedRuntimeDir, { recursive: true, mode: 0o700 });

      const logger = createFileLogger(logFilePath);
      logger.info("browser_connect.command.connected", {
        port: 8765,
      });

      expect(readFileSync(logFilePath, "utf8")).toContain("browser_connect.command.connected");

      rmSync(runtimeDir, { recursive: true, force: true });
      symlinkSync(redirectedRuntimeDir, runtimeDir);

      logger.info("browser_connect.command.redirected", {
        port: 8765,
      });

      expect(lstatSync(runtimeDir).isSymbolicLink()).toBe(true);
      expect(existsSync(redirectedLogFilePath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked log file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chrome-assistent-logging-"));
    const runtimeDir = join(tempDir, ".pi", "chrome-assistent");
    const redirectedLogFilePath = join(tempDir, "redirected.log");
    const logFilePath = join(runtimeDir, "chrome-assistent.log");
    const { createFileLogger } = await importLoggingModule();

    try {
      mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      writeFileSync(redirectedLogFilePath, "existing entry\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      symlinkSync(redirectedLogFilePath, logFilePath);

      const logger = createFileLogger(logFilePath);
      logger.info("browser_connect.command.connected", {
        port: 8765,
      });

      expect(lstatSync(logFilePath).isSymbolicLink()).toBe(true);
      expect(readFileSync(redirectedLogFilePath, "utf8")).toBe("existing entry\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
