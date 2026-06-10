import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importTrustedBrowserStoreModule() {
  return import("./trustedBrowserStore");
}

function transpileFixtureModule(sourcePath: string): string {
  return transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText;
}

function createTrustedBrowserStoreWorkerFixture(tempDir: string): {
  moduleUrl: string;
  workerPath: string;
} {
  const fixtureDirectory = join(tempDir, "worker-fixture");
  const secureFilesystemPath = join(process.cwd(), "src/pi/secureFilesystem.ts");
  const trustedBrowserStorePath = join(process.cwd(), "src/pi/trustedBrowserStore.ts");
  const secureFilesystemFixturePath = join(fixtureDirectory, "secureFilesystem.js");
  const trustedBrowserStoreFixturePath = join(fixtureDirectory, "trustedBrowserStore.js");
  const workerPath = join(fixtureDirectory, "trustedBrowserStoreWorker.mjs");

  mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(fixtureDirectory, "package.json"), '{"type":"module"}\n', "utf8");
  writeFileSync(secureFilesystemFixturePath, transpileFixtureModule(secureFilesystemPath), "utf8");
  writeFileSync(
    trustedBrowserStoreFixturePath,
    transpileFixtureModule(trustedBrowserStorePath).replaceAll(
      'from "./secureFilesystem"',
      'from "./secureFilesystem.js"',
    ),
    "utf8",
  );
  writeFileSync(
    workerPath,
    `import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");
const storePath = process.env.STORE_PATH;
const readMarkerPath = process.env.READ_MARKER_PATH;
const writeMarkerPath = process.env.WRITE_MARKER_PATH;
const delayAfterReadMs = Number(process.env.DELAY_AFTER_READ_MS ?? "0");
const delayDuringWriteMs = Number(process.env.DELAY_DURING_WRITE_MS ?? "0");
const reclaimMarkerPath = process.env.RECLAIM_MARKER_PATH;
const reclaimRemoveDelayMs = Number(process.env.RECLAIM_REMOVE_DELAY_MS ?? "0");
const storeDirectoryPath = path.dirname(storePath);
const lockPath = storePath + ".lock";
let delayedRead = false;
let delayedWrite = false;
let delayedReclaim = false;
let trackedStoreFd;
let trackedWriteFd;
let trackedLockFd;

function sleep(milliseconds) {
  if (milliseconds <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const originalOpenSync = fs.openSync.bind(fs);
fs.openSync = function patchedOpenSync(openPath, ...args) {
  const fd = originalOpenSync(openPath, ...args);
  const resolvedPath = String(openPath);
  const flags = args[0];
  const isWritable = typeof flags === "number"
    && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;

  if (trackedStoreFd === undefined && resolvedPath === storePath) {
    trackedStoreFd = fd;
  }

  if (trackedLockFd === undefined && resolvedPath === lockPath) {
    trackedLockFd = fd;
  }

  if (
    trackedWriteFd === undefined
    && isWritable
    && resolvedPath !== lockPath
    && resolvedPath.startsWith(storeDirectoryPath + path.sep)
  ) {
    trackedWriteFd = fd;
  }

  return fd;
};

const originalReadFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = function patchedReadFileSync(readPath, ...args) {
  const result = originalReadFileSync(readPath, ...args);

  if (!delayedRead && readPath === trackedStoreFd) {
    delayedRead = true;

    if (typeof readMarkerPath === "string" && readMarkerPath.length > 0) {
      fs.writeFileSync(readMarkerPath, "", "utf8");
    }

    sleep(delayAfterReadMs);
  }

  return result;
};

const originalWriteFileSync = fs.writeFileSync.bind(fs);
fs.writeFileSync = function patchedWriteFileSync(writePath, data, ...args) {
  if (
    !delayedWrite
    && delayDuringWriteMs > 0
    && writePath === trackedWriteFd
    && (typeof data === "string" || Buffer.isBuffer(data))
  ) {
    delayedWrite = true;

    if (typeof writeMarkerPath === "string" && writeMarkerPath.length > 0) {
      originalWriteFileSync(writeMarkerPath, "", "utf8");
    }

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const splitOffset = Math.max(1, Math.floor(buffer.length / 2));
    fs.writeSync(writePath, buffer.subarray(0, splitOffset));
    sleep(delayDuringWriteMs);
    fs.writeSync(writePath, buffer.subarray(splitOffset));
    return;
  }

  return originalWriteFileSync(writePath, data, ...args);
};

const originalRenameSync = fs.renameSync.bind(fs);
fs.renameSync = function patchedRenameSync(oldPath, newPath, ...args) {
  if (!delayedReclaim && reclaimRemoveDelayMs > 0 && oldPath === lockPath) {
    delayedReclaim = true;

    if (typeof reclaimMarkerPath === "string" && reclaimMarkerPath.length > 0) {
      originalWriteFileSync(reclaimMarkerPath, "", "utf8");
    }

    sleep(reclaimRemoveDelayMs);
  }

  return originalRenameSync(oldPath, newPath, ...args);
};

const originalUnlinkSync = fs.unlinkSync.bind(fs);
fs.unlinkSync = function patchedUnlinkSync(unlinkPath, ...args) {
  if (!delayedReclaim && reclaimRemoveDelayMs > 0 && unlinkPath === lockPath) {
    delayedReclaim = true;

    if (typeof reclaimMarkerPath === "string" && reclaimMarkerPath.length > 0) {
      originalWriteFileSync(reclaimMarkerPath, "", "utf8");
    }

    sleep(reclaimRemoveDelayMs);
  }

  return originalUnlinkSync(unlinkPath, ...args);
};

syncBuiltinESMExports();

const { addTrustedBrowserToken } = await import(process.env.MODULE_URL);
await addTrustedBrowserToken(storePath, process.env.TOKEN);
`,
    "utf8",
  );

  return {
    moduleUrl: pathToFileURL(trustedBrowserStoreFixturePath).href,
    workerPath,
  };
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const startTime = Date.now();

  while (!existsSync(filePath)) {
    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }

    await delay(10);
  }
}

function readLinuxProcessStartTime(pid: number): string {
  const rawStat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const commTerminatorIndex = rawStat.lastIndexOf(") ");

  if (commTerminatorIndex < 0) {
    throw new Error(`Malformed /proc stat content for pid ${pid}`);
  }

  const statFieldsAfterComm = rawStat.slice(commTerminatorIndex + 2).split(" ");
  const startTime = statFieldsAfterComm[19];

  if (typeof startTime !== "string" || startTime.length === 0) {
    throw new Error(`Missing process start time for pid ${pid}`);
  }

  return startTime;
}

async function runAddTrustedBrowserTokenInChildProcess(options: {
  workerPath: string;
  moduleUrl: string;
  trustedBrowsersPath: string;
  token: string;
  readMarkerPath?: string;
  writeMarkerPath?: string;
  delayAfterReadMs?: number;
  delayDuringWriteMs?: number;
  reclaimMarkerPath?: string;
  reclaimRemoveDelayMs?: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [options.workerPath], {
      env: {
        ...process.env,
        DELAY_AFTER_READ_MS: String(options.delayAfterReadMs ?? 0),
        DELAY_DURING_WRITE_MS: String(options.delayDuringWriteMs ?? 0),
        MODULE_URL: options.moduleUrl,
        READ_MARKER_PATH: options.readMarkerPath ?? "",
        RECLAIM_MARKER_PATH: options.reclaimMarkerPath ?? "",
        RECLAIM_REMOVE_DELAY_MS: String(options.reclaimRemoveDelayMs ?? 0),
        STORE_PATH: options.trustedBrowsersPath,
        TOKEN: options.token,
        WRITE_MARKER_PATH: options.writeMarkerPath ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Worker exited with code ${code}: ${stderr}`));
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
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

  it("stores trusted browser tokens even when current process start time cannot be read", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

    vi.doMock("node:fs", () => ({
      ...actualFs,
      readFileSync: vi.fn((path: Parameters<typeof actualFs.readFileSync>[0], ...args: unknown[]) => {
        if (path === `/proc/${process.pid}/stat`) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }

        return Reflect.apply(actualFs.readFileSync, actualFs, [path, ...args]);
      }),
    }));

    const { addTrustedBrowserToken, isTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });
      await expect(isTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toBe(true);
      expect(existsSync(`${trustedBrowsersPath}.lock`)).toBe(false);
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

  it("keeps duplicate auth as a true no-op when a second write would fail", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const noFollowFlag = actualFs.constants.O_NOFOLLOW ?? 0;
    let failDuplicateWrite = false;

    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync: vi.fn((path: Parameters<typeof actualFs.openSync>[0], flags: number | string, mode?: number) => {
        if (
          failDuplicateWrite
          && typeof path === "string"
          && path.startsWith(`${trustedBrowsersPath}.`)
          && path.endsWith(".tmp")
          && typeof flags === "number"
          && (flags & actualFs.constants.O_CREAT) !== 0
          && (flags & actualFs.constants.O_EXCL) !== 0
          && (flags & noFollowFlag) === noFollowFlag
        ) {
          throw new Error("duplicate auth must not attempt a second store write");
        }

        return mode === undefined ? actualFs.openSync(path, flags) : actualFs.openSync(path, flags, mode);
      }),
    }));

    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });

      failDuplicateWrite = true;

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

  it("persists concurrent adds of different tokens", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersDirectory = join(tempDir, "trusted-browsers");
    const trustedBrowsersPath = join(trustedBrowsersDirectory, "trusted-browsers.json");
    const readMarkerPath = join(tempDir, "first-read.marker");
    const { moduleUrl, workerPath } = createTrustedBrowserStoreWorkerFixture(tempDir);

    try {
      mkdirSync(trustedBrowsersDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(trustedBrowsersPath, "[]\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      const firstAddPromise = runAddTrustedBrowserTokenInChildProcess({
        workerPath,
        moduleUrl,
        trustedBrowsersPath,
        token: "browser-token-a",
        readMarkerPath,
        delayAfterReadMs: 300,
      });

      await waitForFile(readMarkerPath);

      await Promise.all([
        firstAddPromise,
        runAddTrustedBrowserTokenInChildProcess({
          workerPath,
          moduleUrl,
          trustedBrowsersPath,
          token: "browser-token-b",
        }),
      ]);

      expect(JSON.parse(readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token-a" },
        { token: "browser-token-b" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers a stale trusted browser store lock", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const trustedBrowsersLockPath = `${trustedBrowsersPath}.lock`;
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      writeFileSync(
        trustedBrowsersLockPath,
        `${JSON.stringify({ pid: 999_999, acquiredAt: Date.now() - 120_000 })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );

      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });

      expect(existsSync(trustedBrowsersLockPath)).toBe(false);
      expect(JSON.parse(readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers when both the stale store lock and stale reclaim guard are orphaned", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const trustedBrowsersLockPath = `${trustedBrowsersPath}.lock`;
    const trustedBrowsersReclaimGuardPath = `${trustedBrowsersLockPath}.reclaim`;
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      writeFileSync(
        trustedBrowsersLockPath,
        `${JSON.stringify({ pid: 999_999, acquiredAt: Date.now() - 120_000 })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      writeFileSync(
        trustedBrowsersReclaimGuardPath,
        `${JSON.stringify({ pid: 999_999, acquiredAt: Date.now() - 120_000 })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );

      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });

      expect(existsSync(trustedBrowsersLockPath)).toBe(false);
      expect(existsSync(trustedBrowsersReclaimGuardPath)).toBe(false);
      expect(JSON.parse(readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim a very old trusted browser store lock when the live owner PID has no recorded process start time", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const trustedBrowsersLockPath = `${trustedBrowsersPath}.lock`;
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      writeFileSync(
        trustedBrowsersLockPath,
        `${JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now() - 86_400_000,
        })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );

      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).rejects.toThrow(/timed out waiting for trusted browser store lock/i);
      expect(existsSync(trustedBrowsersLockPath)).toBe(true);
      expect(existsSync(trustedBrowsersPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim a very old trusted browser store lock when the live owner identity still matches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const trustedBrowsersLockPath = `${trustedBrowsersPath}.lock`;
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      writeFileSync(
        trustedBrowsersLockPath,
        `${JSON.stringify({
          pid: process.pid,
          processStartTime: readLinuxProcessStartTime(process.pid),
          acquiredAt: Date.now() - 86_400_000,
        })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );

      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).rejects.toThrow(/timed out waiting for trusted browser store lock/i);
      expect(existsSync(trustedBrowsersLockPath)).toBe(true);
      expect(existsSync(trustedBrowsersPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reclaims a trusted browser store lock when the live PID belongs to a different process identity", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const trustedBrowsersLockPath = `${trustedBrowsersPath}.lock`;
    const trustedBrowsersReclaimGuardPath = `${trustedBrowsersLockPath}.reclaim`;
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      const reusedPidMetadata = `${JSON.stringify({
        pid: process.pid,
        processStartTime: "reused-process-start-time",
        acquiredAt: Date.now() - 1_000,
      })}\n`;

      writeFileSync(trustedBrowsersLockPath, reusedPidMetadata, {
        encoding: "utf8",
        mode: 0o600,
      });
      writeFileSync(trustedBrowsersReclaimGuardPath, reusedPidMetadata, {
        encoding: "utf8",
        mode: 0o600,
      });

      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });

      expect(existsSync(trustedBrowsersLockPath)).toBe(false);
      expect(existsSync(trustedBrowsersReclaimGuardPath)).toBe(false);
      expect(JSON.parse(readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let concurrent stale-lock reclaim attempts delete a fresh lock", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersDirectory = join(tempDir, "trusted-browsers");
    const trustedBrowsersPath = join(trustedBrowsersDirectory, "trusted-browsers.json");
    const trustedBrowsersLockPath = `${trustedBrowsersPath}.lock`;
    const reclaimMarkerPath = join(tempDir, "reclaim.marker");
    const { moduleUrl, workerPath } = createTrustedBrowserStoreWorkerFixture(tempDir);

    try {
      mkdirSync(trustedBrowsersDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(trustedBrowsersPath, "[]\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      writeFileSync(
        trustedBrowsersLockPath,
        `${JSON.stringify({ pid: 999_999, acquiredAt: Date.now() - 120_000 })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );

      const firstAddPromise = runAddTrustedBrowserTokenInChildProcess({
        workerPath,
        moduleUrl,
        trustedBrowsersPath,
        token: "browser-token-a",
        reclaimMarkerPath,
        reclaimRemoveDelayMs: 300,
      });

      await waitForFile(reclaimMarkerPath);

      await Promise.all([
        firstAddPromise,
        runAddTrustedBrowserTokenInChildProcess({
          workerPath,
          moduleUrl,
          trustedBrowsersPath,
          token: "browser-token-b",
          delayAfterReadMs: 300,
        }),
      ]);

      expect(
        JSON.parse(readFileSync(trustedBrowsersPath, "utf8")).sort(
          (left: { token: string }, right: { token: string }) => left.token.localeCompare(right.token),
        ),
      ).toEqual([
        { token: "browser-token-a" },
        { token: "browser-token-b" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps concurrent readers on well-formed JSON while add writes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersDirectory = join(tempDir, "trusted-browsers");
    const trustedBrowsersPath = join(trustedBrowsersDirectory, "trusted-browsers.json");
    const writeMarkerPath = join(tempDir, "writer-partial.marker");
    const { isTrustedBrowserToken } = await importTrustedBrowserStoreModule();
    const { moduleUrl, workerPath } = createTrustedBrowserStoreWorkerFixture(tempDir);

    try {
      mkdirSync(trustedBrowsersDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(trustedBrowsersPath, "[]\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      const writerPromise = runAddTrustedBrowserTokenInChildProcess({
        workerPath,
        moduleUrl,
        trustedBrowsersPath,
        token: "browser-token",
        writeMarkerPath,
        delayDuringWriteMs: 300,
      });

      await waitForFile(writeMarkerPath);

      for (let attempt = 0; attempt < 40; attempt += 1) {
        expect(typeof await isTrustedBrowserToken(trustedBrowsersPath, "browser-token")).toBe("boolean");
        await delay(5);
      }

      await expect(writerPromise).resolves.toBeUndefined();
      await expect(isTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toBe(true);
      expect(JSON.parse(readFileSync(trustedBrowsersPath, "utf8"))).toEqual([
        { token: "browser-token" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("hardens an existing trusted browser directory via a secure descriptor", async () => {
    const trustedBrowsersPath = "/virtual/trusted-browsers/trusted-browsers.json";
    const trustedBrowsersDirectory = "/virtual/trusted-browsers";
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const directoryStats = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as ReturnType<typeof statSync>;
    const openSync = vi.fn((path: Parameters<typeof actualFs.openSync>[0], flags: number | string, mode?: number) => {
      if (path === trustedBrowsersDirectory) {
        return 456;
      }

      if (path === trustedBrowsersPath) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }

      return mode === undefined ? actualFs.openSync(path, flags) : actualFs.openSync(path, flags, mode);
    });
    const chmodSync = vi.fn((path: Parameters<typeof actualFs.chmodSync>[0], mode: Parameters<typeof actualFs.chmodSync>[1]) => {
      if (path === trustedBrowsersDirectory && mode === 0o700) {
        throw new Error("path-based directory chmod must not be used");
      }

      return actualFs.chmodSync(path, mode);
    });
    const fchmodSync = vi.fn((fd: number, mode: Parameters<typeof actualFs.fchmodSync>[1]) => {
      expect(fd).toBe(456);
      expect(mode).toBe(0o700);
    });
    const closeSync = vi.fn((fd: number) => {
      expect(fd).toBe(456);
    });

    vi.doMock("node:fs", () => ({
      ...actualFs,
      constants: {
        ...actualFs.constants,
        O_DIRECTORY: actualFs.constants.O_DIRECTORY ?? 0x10000,
        O_NOFOLLOW: actualFs.constants.O_NOFOLLOW ?? 0x20000,
      },
      lstatSync: vi.fn((path: Parameters<typeof actualFs.lstatSync>[0]) => {
        if (path === "/virtual" || path === trustedBrowsersDirectory) {
          return directoryStats;
        }

        return actualFs.lstatSync(path);
      }),
      mkdirSync: vi.fn(),
      chmodSync,
      openSync,
      fstatSync: vi.fn((fd: number) => {
        if (fd === 456) {
          return directoryStats;
        }

        return actualFs.fstatSync(fd);
      }),
      fchmodSync,
      closeSync,
    }));

    const { isTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    await expect(isTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toBe(false);
    expect(openSync).toHaveBeenCalledWith(trustedBrowsersDirectory, expect.any(Number));
    expect(chmodSync).not.toHaveBeenCalledWith(trustedBrowsersDirectory, 0o700);
    expect(fchmodSync).toHaveBeenCalledWith(456, 0o700);
    expect(closeSync).toHaveBeenCalledWith(456);

    const [openedPath, flags] = openSync.mock.calls[0];
    expect(openedPath).toBe(trustedBrowsersDirectory);
    expect(typeof flags).toBe("number");
    expect((flags as number) & (actualFs.constants.O_DIRECTORY ?? 0x10000)).not.toBe(0);
    expect((flags as number) & (actualFs.constants.O_NOFOLLOW ?? 0x20000)).not.toBe(0);
  });

  it("tightens a pre-existing trusted browser directory to 0700", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersDirectory = join(tempDir, "nested");
    const trustedBrowsersPath = join(trustedBrowsersDirectory, "trusted-browsers.json");
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      mkdirSync(trustedBrowsersDirectory, { recursive: true, mode: 0o755 });
      chmodSync(trustedBrowsersDirectory, 0o755);

      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).resolves.toEqual({
        token: "browser-token",
      });

      expect(statSync(trustedBrowsersDirectory).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked trusted browser store file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const redirectedStorePath = join(tempDir, "redirected-store.json");
    const { addTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      writeFileSync(redirectedStorePath, "[]\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      symlinkSync(redirectedStorePath, trustedBrowsersPath);

      await expect(addTrustedBrowserToken(trustedBrowsersPath, "browser-token")).rejects.toThrow(/must not be a symlink/i);
      expect(JSON.parse(readFileSync(redirectedStorePath, "utf8"))).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a non-regular trusted browser store path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const { isTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      mkdirSync(trustedBrowsersPath, { mode: 0o700 });

      await expect(isTrustedBrowserToken(trustedBrowsersPath, "browser-token")).rejects.toThrow(/regular file/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed trusted browser store JSON", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "trusted-browsers-"));
    const trustedBrowsersPath = join(tempDir, "trusted-browsers.json");
    const { isTrustedBrowserToken } = await importTrustedBrowserStoreModule();

    try {
      writeFileSync(trustedBrowsersPath, "{not-json}\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      await expect(isTrustedBrowserToken(trustedBrowsersPath, "browser-token")).rejects.toThrow(/malformed json/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
