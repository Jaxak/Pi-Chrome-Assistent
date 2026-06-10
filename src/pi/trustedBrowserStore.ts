import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { toNodeError, validateDirectoryPathChain } from "./secureFilesystem";

export interface TrustedBrowserRecord {
  token: string;
}

interface TrustedBrowserStoreLockMetadata {
  pid: number;
  acquiredAt: number;
}

function ensureTrustedBrowsersDirectory(trustedBrowsersPath: string): void {
  const trustedBrowsersDirectory = dirname(trustedBrowsersPath);
  validateDirectoryPathChain(trustedBrowsersDirectory, "Trusted browser directory");
  mkdirSync(trustedBrowsersDirectory, {
    recursive: true,
    mode: 0o700,
  });
  validateDirectoryPathChain(trustedBrowsersDirectory, "Trusted browser directory");

  try {
    chmodSync(trustedBrowsersDirectory, 0o700);
  } catch (error) {
    const nodeError = toNodeError(error);
    const reason = nodeError.message.length > 0 ? nodeError.message : "Unknown error";
    throw new Error(`Failed to secure trusted browser directory permissions at ${trustedBrowsersDirectory}: ${reason}`);
  }
}

function getNoFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("Secure trusted browser store operations require fs.constants.O_NOFOLLOW support");
  }

  return fsConstants.O_NOFOLLOW;
}

function openTrustedBrowserStoreFile(trustedBrowsersPath: string, flags: number, mode?: number): number {
  try {
    return mode === undefined
      ? openSync(trustedBrowsersPath, flags)
      : openSync(trustedBrowsersPath, flags, mode);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ELOOP") {
      throw new Error(`Trusted browser store file must not be a symlink: ${trustedBrowsersPath}`);
    }

    throw error;
  }
}

function validateTrustedBrowserStoreFile(fd: number, trustedBrowsersPath: string): void {
  if (!fstatSync(fd).isFile()) {
    throw new Error(`Trusted browser store file must be a regular file: ${trustedBrowsersPath}`);
  }
}

function enforceTrustedBrowsersFilePermissions(fd: number, trustedBrowsersPath: string): void {
  try {
    fchmodSync(fd, 0o600);
  } catch (error) {
    const nodeError = toNodeError(error);
    const reason = nodeError.message.length > 0 ? nodeError.message : "Unknown error";
    throw new Error(`Failed to secure trusted browser store permissions at ${trustedBrowsersPath}: ${reason}`);
  }
}

function parseTrustedBrowserRecords(rawContent: string, trustedBrowsersPath: string): TrustedBrowserRecord[] {
  let parsedContent: unknown;

  try {
    parsedContent = JSON.parse(rawContent) as unknown;
  } catch (error) {
    const nodeError = toNodeError(error);
    const reason = nodeError.message.length > 0 ? nodeError.message : "Unknown error";
    throw new Error(`Trusted browser store contains malformed JSON at ${trustedBrowsersPath}: ${reason}`);
  }

  if (!Array.isArray(parsedContent)) {
    throw new Error(`Trusted browser store must contain an array: ${trustedBrowsersPath}`);
  }

  return parsedContent.map((record) => {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof (record as { token?: unknown }).token !== "string"
    ) {
      throw new Error(`Trusted browser store contains an invalid record: ${trustedBrowsersPath}`);
    }

    return {
      token: (record as { token: string }).token,
    };
  });
}

function readTrustedBrowserRecords(trustedBrowsersPath: string): TrustedBrowserRecord[] {
  ensureTrustedBrowsersDirectory(trustedBrowsersPath);
  validateDirectoryPathChain(dirname(trustedBrowsersPath), "Trusted browser directory");

  let fd: number | undefined;

  try {
    fd = openTrustedBrowserStoreFile(
      trustedBrowsersPath,
      fsConstants.O_RDONLY | getNoFollowFlag(),
    );
    validateTrustedBrowserStoreFile(fd, trustedBrowsersPath);
    const rawContent = readFileSync(fd, "utf8");
    enforceTrustedBrowsersFilePermissions(fd, trustedBrowsersPath);
    return parseTrustedBrowserRecords(rawContent, trustedBrowsersPath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return [];
    }

    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function validateTrustedBrowserStoreTargetForWrite(trustedBrowsersPath: string): void {
  let fd: number | undefined;

  try {
    fd = openTrustedBrowserStoreFile(
      trustedBrowsersPath,
      fsConstants.O_RDONLY | getNoFollowFlag(),
    );
    validateTrustedBrowserStoreFile(fd, trustedBrowsersPath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return;
    }

    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function writeTrustedBrowserRecordsAtomically(
  trustedBrowsersPath: string,
  records: TrustedBrowserRecord[],
): void {
  ensureTrustedBrowsersDirectory(trustedBrowsersPath);
  validateDirectoryPathChain(dirname(trustedBrowsersPath), "Trusted browser directory");
  validateTrustedBrowserStoreTargetForWrite(trustedBrowsersPath);

  const tempPath = `${trustedBrowsersPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const rawContent = `${JSON.stringify(records, null, 2)}\n`;
  let tempFd: number | undefined;

  try {
    tempFd = openTrustedBrowserStoreFile(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | getNoFollowFlag(),
      0o600,
    );
    validateTrustedBrowserStoreFile(tempFd, tempPath);
    writeFileSync(tempFd, rawContent, {
      encoding: "utf8",
    });
    enforceTrustedBrowsersFilePermissions(tempFd, tempPath);
    closeSync(tempFd);
    tempFd = undefined;
    renameSync(tempPath, trustedBrowsersPath);
  } catch (error) {
    if (tempFd !== undefined) {
      closeSync(tempFd);
    }

    try {
      unlinkSync(tempPath);
    } catch (unlinkError) {
      const unlinkNodeError = toNodeError(unlinkError);

      if (unlinkNodeError.code !== "ENOENT") {
        throw unlinkError;
      }
    }

    throw error;
  }
}

function writeTrustedBrowserRecords(
  trustedBrowsersPath: string,
  records: TrustedBrowserRecord[],
): void {
  writeTrustedBrowserRecordsAtomically(trustedBrowsersPath, records);
}

const TRUSTED_BROWSER_STORE_LOCK_RETRY_DELAY_MS = 10;
const TRUSTED_BROWSER_STORE_LOCK_MAX_ATTEMPTS = 200;
const TRUSTED_BROWSER_STORE_LOCK_STALE_TTL_MS = 60_000;
const TRUSTED_BROWSER_STORE_LOCK_MAX_LIVE_PID_TRUST_MS = 15 * 60_000;

function writeTrustedBrowserStoreLockMetadata(
  fd: number,
  label = "trusted browser store lock",
): void {
  validateTrustedBrowserStoreFile(fd, label);
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`, {
    encoding: "utf8",
  });
  enforceTrustedBrowsersFilePermissions(fd, label);
}

function readTrustedBrowserStoreLockMetadata(lockPath: string): {
  fileStats: ReturnType<typeof fstatSync>;
  metadata?: TrustedBrowserStoreLockMetadata;
} {
  let fd: number | undefined;

  try {
    fd = openTrustedBrowserStoreFile(
      lockPath,
      fsConstants.O_RDONLY | getNoFollowFlag(),
    );
    validateTrustedBrowserStoreFile(fd, lockPath);
    const fileStats = fstatSync(fd);
    const rawContent = readFileSync(fd, "utf8").trim();

    if (rawContent.length === 0) {
      return { fileStats };
    }

    let parsedContent: unknown;

    try {
      parsedContent = JSON.parse(rawContent) as unknown;
    } catch {
      return { fileStats };
    }

    if (
      typeof parsedContent !== "object"
      || parsedContent === null
      || typeof (parsedContent as { pid?: unknown }).pid !== "number"
      || !Number.isInteger((parsedContent as { pid: number }).pid)
      || (parsedContent as { pid: number }).pid <= 0
      || typeof (parsedContent as { acquiredAt?: unknown }).acquiredAt !== "number"
      || !Number.isFinite((parsedContent as { acquiredAt: number }).acquiredAt)
    ) {
      return { fileStats };
    }

    return {
      fileStats,
      metadata: {
        pid: (parsedContent as { pid: number }).pid,
        acquiredAt: (parsedContent as { acquiredAt: number }).acquiredAt,
      },
    };
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ESRCH") {
      return false;
    }

    if (nodeError.code === "EPERM") {
      return true;
    }

    throw error;
  }
}

function getTrustedBrowserStoreLockAgeMs(
  lockState: ReturnType<typeof readTrustedBrowserStoreLockMetadata>,
): number {
  return lockState.metadata === undefined
    ? Date.now() - Number(lockState.fileStats.mtimeMs)
    : Date.now() - lockState.metadata.acquiredAt;
}

function isTrustedBrowserStoreLockStale(
  lockState: ReturnType<typeof readTrustedBrowserStoreLockMetadata>,
): boolean {
  const lockAgeMs = getTrustedBrowserStoreLockAgeMs(lockState);

  if (lockState.metadata === undefined) {
    return lockAgeMs >= TRUSTED_BROWSER_STORE_LOCK_STALE_TTL_MS;
  }

  if (lockAgeMs >= TRUSTED_BROWSER_STORE_LOCK_MAX_LIVE_PID_TRUST_MS) {
    return true;
  }

  try {
    return !isProcessAlive(lockState.metadata.pid);
  } catch {
    return lockAgeMs >= TRUSTED_BROWSER_STORE_LOCK_STALE_TTL_MS;
  }
}

function getTrustedBrowserStoreLockQuarantinePath(lockPath: string): string {
  return `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.stale`;
}

function tryAcquireTrustedBrowserStoreLockFile(
  lockPath: string,
  label: string,
): (() => void) | undefined {
  let fd: number | undefined;

  try {
    fd = openTrustedBrowserStoreFile(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | getNoFollowFlag(),
      0o600,
    );
    writeTrustedBrowserStoreLockMetadata(fd, label);

    return () => {
      if (fd === undefined) {
        return;
      }

      const acquiredFd = fd;
      fd = undefined;
      closeSync(acquiredFd);

      try {
        unlinkSync(lockPath);
      } catch (error) {
        const nodeError = toNodeError(error);

        if (nodeError.code !== "ENOENT") {
          throw error;
        }
      }
    };
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);

      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        const unlinkNodeError = toNodeError(unlinkError);

        if (unlinkNodeError.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }

    const nodeError = toNodeError(error);

    if (nodeError.code === "EEXIST") {
      return undefined;
    }

    throw error;
  }
}

function tryReclaimStaleTrustedBrowserStoreLockFile(lockPath: string): boolean {
  let lockState: ReturnType<typeof readTrustedBrowserStoreLockMetadata>;

  try {
    lockState = readTrustedBrowserStoreLockMetadata(lockPath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return true;
    }

    throw error;
  }

  if (!isTrustedBrowserStoreLockStale(lockState)) {
    return false;
  }

  const quarantinePath = getTrustedBrowserStoreLockQuarantinePath(lockPath);

  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return true;
    }

    throw error;
  }

  try {
    unlinkSync(quarantinePath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  return true;
}

function tryAcquireTrustedBrowserStoreReclaimGuard(lockPath: string): (() => void) | undefined {
  const reclaimGuardPath = `${lockPath}.reclaim`;
  const releaseReclaimGuard = tryAcquireTrustedBrowserStoreLockFile(
    reclaimGuardPath,
    "trusted browser store reclaim guard",
  );

  if (releaseReclaimGuard !== undefined) {
    return releaseReclaimGuard;
  }

  if (!tryReclaimStaleTrustedBrowserStoreLockFile(reclaimGuardPath)) {
    return undefined;
  }

  return tryAcquireTrustedBrowserStoreLockFile(
    reclaimGuardPath,
    "trusted browser store reclaim guard",
  );
}

function tryReclaimTrustedBrowserStoreLock(lockPath: string): void {
  const releaseReclaimGuard = tryAcquireTrustedBrowserStoreReclaimGuard(lockPath);

  if (releaseReclaimGuard === undefined) {
    return;
  }

  try {
    tryReclaimStaleTrustedBrowserStoreLockFile(lockPath);
  } finally {
    releaseReclaimGuard();
  }
}

async function acquireTrustedBrowserStoreLock(trustedBrowsersPath: string): Promise<() => void> {
  ensureTrustedBrowsersDirectory(trustedBrowsersPath);
  const lockPath = `${trustedBrowsersPath}.lock`;

  for (let attempt = 0; attempt < TRUSTED_BROWSER_STORE_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const releaseLock = tryAcquireTrustedBrowserStoreLockFile(lockPath, "trusted browser store lock");

    if (releaseLock !== undefined) {
      return releaseLock;
    }

    tryReclaimTrustedBrowserStoreLock(lockPath);

    await delay(TRUSTED_BROWSER_STORE_LOCK_RETRY_DELAY_MS);
  }

  throw new Error(`Timed out waiting for trusted browser store lock: ${lockPath}`);
}

export async function addTrustedBrowserToken(
  trustedBrowsersPath: string,
  token: string,
): Promise<TrustedBrowserRecord> {
  const releaseLock = await acquireTrustedBrowserStoreLock(trustedBrowsersPath);

  try {
    const records = readTrustedBrowserRecords(trustedBrowsersPath);
    const existingRecord = records.find((record) => record.token === token);

    if (existingRecord) {
      writeTrustedBrowserRecords(trustedBrowsersPath, records);
      return existingRecord;
    }

    const storedRecord = { token };
    writeTrustedBrowserRecords(trustedBrowsersPath, [...records, storedRecord]);
    return storedRecord;
  } finally {
    releaseLock();
  }
}

export async function isTrustedBrowserToken(
  trustedBrowsersPath: string,
  token: string,
): Promise<boolean> {
  return readTrustedBrowserRecords(trustedBrowsersPath).some((record) => record.token === token);
}
