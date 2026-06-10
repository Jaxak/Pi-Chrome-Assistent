import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function enforceTrustedBrowsersFilePermissions(trustedBrowsersPath: string): void {
  try {
    chmodSync(trustedBrowsersPath, 0o600);
  } catch (error) {
    const nodeError = toNodeError(error);
    const reason = nodeError.message.length > 0 ? nodeError.message : "Unknown error";
    throw new Error(`Failed to secure trusted browser store permissions at ${trustedBrowsersPath}: ${reason}`);
  }
}

function readTrustedBrowserRecords(trustedBrowsersPath: string): TrustedBrowserRecord[] {
  ensureTrustedBrowsersDirectory(trustedBrowsersPath);

  try {
    const rawContent = readFileSync(trustedBrowsersPath, "utf8");
    enforceTrustedBrowsersFilePermissions(trustedBrowsersPath);
    const parsedContent = JSON.parse(rawContent) as unknown;

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
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function writeTrustedBrowserRecords(
  trustedBrowsersPath: string,
  records: TrustedBrowserRecord[],
): void {
  ensureTrustedBrowsersDirectory(trustedBrowsersPath);
  writeFileSync(trustedBrowsersPath, `${JSON.stringify(records, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  enforceTrustedBrowsersFilePermissions(trustedBrowsersPath);
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
