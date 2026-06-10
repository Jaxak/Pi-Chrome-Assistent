import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { toNodeError, validateDirectoryPathChain } from "./secureFilesystem";

export interface TrustedBrowserRecord {
  token: string;
}

function ensureTrustedBrowsersDirectory(trustedBrowsersPath: string): void {
  const trustedBrowsersDirectory = dirname(trustedBrowsersPath);
  validateDirectoryPathChain(trustedBrowsersDirectory, "Trusted browser directory");
  mkdirSync(trustedBrowsersDirectory, {
    recursive: true,
    mode: 0o700,
  });
  validateDirectoryPathChain(trustedBrowsersDirectory, "Trusted browser directory");
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

function writeTrustedBrowserRecordsToFd(fd: number, trustedBrowsersPath: string, records: TrustedBrowserRecord[]): void {
  validateTrustedBrowserStoreFile(fd, trustedBrowsersPath);
  ftruncateSync(fd, 0);
  writeFileSync(fd, `${JSON.stringify(records, null, 2)}\n`, {
    encoding: "utf8",
  });
  enforceTrustedBrowsersFilePermissions(fd, trustedBrowsersPath);
}

function createTrustedBrowserStoreFile(
  trustedBrowsersPath: string,
  records: TrustedBrowserRecord[],
): void {
  validateDirectoryPathChain(dirname(trustedBrowsersPath), "Trusted browser directory");
  const fd = openTrustedBrowserStoreFile(
    trustedBrowsersPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | getNoFollowFlag(),
    0o600,
  );

  try {
    writeTrustedBrowserRecordsToFd(fd, trustedBrowsersPath, records);
  } finally {
    closeSync(fd);
  }
}

function updateTrustedBrowserStoreFile(
  trustedBrowsersPath: string,
  records: TrustedBrowserRecord[],
): void {
  validateDirectoryPathChain(dirname(trustedBrowsersPath), "Trusted browser directory");
  const fd = openTrustedBrowserStoreFile(
    trustedBrowsersPath,
    fsConstants.O_RDWR | getNoFollowFlag(),
  );

  try {
    writeTrustedBrowserRecordsToFd(fd, trustedBrowsersPath, records);
  } finally {
    closeSync(fd);
  }
}

function writeTrustedBrowserRecords(
  trustedBrowsersPath: string,
  records: TrustedBrowserRecord[],
): void {
  ensureTrustedBrowsersDirectory(trustedBrowsersPath);

  try {
    updateTrustedBrowserStoreFile(trustedBrowsersPath, records);
    return;
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    createTrustedBrowserStoreFile(trustedBrowsersPath, records);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code !== "EEXIST") {
      throw error;
    }

    updateTrustedBrowserStoreFile(trustedBrowsersPath, records);
  }
}

export async function addTrustedBrowserToken(
  trustedBrowsersPath: string,
  token: string,
): Promise<TrustedBrowserRecord> {
  const records = readTrustedBrowserRecords(trustedBrowsersPath);
  const existingRecord = records.find((record) => record.token === token);

  if (existingRecord) {
    writeTrustedBrowserRecords(trustedBrowsersPath, records);
    return existingRecord;
  }

  const storedRecord = { token };
  writeTrustedBrowserRecords(trustedBrowsersPath, [...records, storedRecord]);
  return storedRecord;
}

export async function isTrustedBrowserToken(
  trustedBrowsersPath: string,
  token: string,
): Promise<boolean> {
  return readTrustedBrowserRecords(trustedBrowsersPath).some((record) => record.token === token);
}
