import { randomUUID } from "node:crypto";
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
  processStartTime?: string;
  acquiredAt: number;
  lockId?: string;
}

interface TrustedBrowserStoreLockHandle {
  assertOwnership(): void;
  release(): void;
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
  assertCanCommit?: () => void,
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
    assertCanCommit?.();
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
  assertCanCommit?: () => void,
): void {
  writeTrustedBrowserRecordsAtomically(trustedBrowsersPath, records, assertCanCommit);
}

const TRUSTED_BROWSER_STORE_LOCK_RETRY_DELAY_MS = 10;
const TRUSTED_BROWSER_STORE_LOCK_MAX_ATTEMPTS = 200;
const TRUSTED_BROWSER_STORE_LOCK_STALE_TTL_MS = 60_000;

let cachedCurrentProcessStartTime: string | undefined;

function readLinuxProcessStartTime(pid: number): string | undefined {
  try {
    const rawStat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const commTerminatorIndex = rawStat.lastIndexOf(") ");

    if (commTerminatorIndex < 0) {
      return undefined;
    }

    const statFieldsAfterComm = rawStat.slice(commTerminatorIndex + 2).split(" ");
    const startTime = statFieldsAfterComm[19];

    return typeof startTime === "string" && startTime.length > 0
      ? startTime
      : undefined;
  } catch (error) {
    const nodeError = toNodeError(error);

    if (
      nodeError.code === "ENOENT"
      || nodeError.code === "ESRCH"
      || nodeError.code === "EACCES"
      || nodeError.code === "EPERM"
    ) {
      return undefined;
    }

    throw error;
  }
}

function getCurrentProcessStartTime(): string {
  cachedCurrentProcessStartTime ??= readLinuxProcessStartTime(process.pid);

  if (cachedCurrentProcessStartTime === undefined) {
    throw new Error(`Failed to read current process start time for pid ${process.pid}`);
  }

  return cachedCurrentProcessStartTime;
}

function writeTrustedBrowserStoreLockMetadata(
  fd: number,
  lockId: string,
  label = "trusted browser store lock",
): void {
  validateTrustedBrowserStoreFile(fd, label);
  writeFileSync(fd, `${JSON.stringify({
    pid: process.pid,
    processStartTime: getCurrentProcessStartTime(),
    acquiredAt: Date.now(),
    lockId,
  })}\n`, {
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
      || (
        typeof (parsedContent as { processStartTime?: unknown }).processStartTime !== "undefined"
        && (
          typeof (parsedContent as { processStartTime?: unknown }).processStartTime !== "string"
          || (parsedContent as { processStartTime: string }).processStartTime.length === 0
        )
      )
      || typeof (parsedContent as { acquiredAt?: unknown }).acquiredAt !== "number"
      || !Number.isFinite((parsedContent as { acquiredAt: number }).acquiredAt)
      || (
        typeof (parsedContent as { lockId?: unknown }).lockId !== "undefined"
        && typeof (parsedContent as { lockId?: unknown }).lockId !== "string"
      )
    ) {
      return { fileStats };
    }

    return {
      fileStats,
      metadata: {
        pid: (parsedContent as { pid: number }).pid,
        processStartTime: (parsedContent as { processStartTime?: string }).processStartTime,
        acquiredAt: (parsedContent as { acquiredAt: number }).acquiredAt,
        lockId: (parsedContent as { lockId?: string }).lockId,
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

  if (lockState.metadata === undefined || lockState.metadata.processStartTime === undefined) {
    return lockAgeMs >= TRUSTED_BROWSER_STORE_LOCK_STALE_TTL_MS;
  }

  try {
    if (!isProcessAlive(lockState.metadata.pid)) {
      return true;
    }
  } catch {
    return lockAgeMs >= TRUSTED_BROWSER_STORE_LOCK_STALE_TTL_MS;
  }

  const liveProcessStartTime = readLinuxProcessStartTime(lockState.metadata.pid);

  if (liveProcessStartTime === undefined) {
    return false;
  }

  return liveProcessStartTime !== lockState.metadata.processStartTime;
}

function getTrustedBrowserStoreLockQuarantinePath(lockPath: string): string {
  return `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.stale`;
}

function isTrustedBrowserStoreLockOwnedBy(lockPath: string, lockId: string): boolean {
  try {
    return readTrustedBrowserStoreLockMetadata(lockPath).metadata?.lockId === lockId;
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function assertTrustedBrowserStoreLockOwnership(lockPath: string, lockId: string): void {
  if (!isTrustedBrowserStoreLockOwnedBy(lockPath, lockId)) {
    throw new Error(`Trusted browser store lock ownership was lost: ${lockPath}`);
  }
}

function tryAcquireTrustedBrowserStoreLockFile(
  lockPath: string,
  label: string,
): TrustedBrowserStoreLockHandle | undefined {
  let fd: number | undefined;
  const lockId = randomUUID();

  try {
    fd = openTrustedBrowserStoreFile(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | getNoFollowFlag(),
      0o600,
    );
    writeTrustedBrowserStoreLockMetadata(fd, lockId, label);

    return {
      assertOwnership() {
        assertTrustedBrowserStoreLockOwnership(lockPath, lockId);
      },
      release() {
        if (fd === undefined) {
          return;
        }

        const acquiredFd = fd;
        fd = undefined;
        closeSync(acquiredFd);

        if (!isTrustedBrowserStoreLockOwnedBy(lockPath, lockId)) {
          return;
        }

        try {
          unlinkSync(lockPath);
        } catch (error) {
          const nodeError = toNodeError(error);

          if (nodeError.code !== "ENOENT") {
            throw error;
          }
        }
      },
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

function tryAcquireTrustedBrowserStoreReclaimGuard(lockPath: string): TrustedBrowserStoreLockHandle | undefined {
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
  const reclaimGuard = tryAcquireTrustedBrowserStoreReclaimGuard(lockPath);

  if (reclaimGuard === undefined) {
    return;
  }

  try {
    tryReclaimStaleTrustedBrowserStoreLockFile(lockPath);
  } finally {
    reclaimGuard.release();
  }
}

async function acquireTrustedBrowserStoreLock(trustedBrowsersPath: string): Promise<TrustedBrowserStoreLockHandle> {
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
  const lock = await acquireTrustedBrowserStoreLock(trustedBrowsersPath);

  try {
    const records = readTrustedBrowserRecords(trustedBrowsersPath);
    const existingRecord = records.find((record) => record.token === token);

    if (existingRecord) {
      writeTrustedBrowserRecords(trustedBrowsersPath, records, () => lock.assertOwnership());
      return existingRecord;
    }

    const storedRecord = { token };
    writeTrustedBrowserRecords(
      trustedBrowsersPath,
      [...records, storedRecord],
      () => lock.assertOwnership(),
    );
    return storedRecord;
  } finally {
    lock.release();
  }
}

export async function isTrustedBrowserToken(
  trustedBrowsersPath: string,
  token: string,
): Promise<boolean> {
  return readTrustedBrowserRecords(trustedBrowsersPath).some((record) => record.token === token);
}
