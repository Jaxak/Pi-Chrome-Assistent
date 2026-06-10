import { lstatSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";

export function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error("Unknown error");
}

function validateExistingDirectoryPath(directoryPath: string, kind: string): boolean {
  let stats: ReturnType<typeof lstatSync>;

  try {
    stats = lstatSync(directoryPath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`${kind} must not be a symlink: ${directoryPath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`${kind} must be a directory: ${directoryPath}`);
  }

  return true;
}

export function validateDirectoryPathChain(directoryPath: string, kind: string): void {
  const resolvedDirectoryPath = resolve(directoryPath);
  const { root } = parse(resolvedDirectoryPath);
  const pathComponents = resolvedDirectoryPath.slice(root.length).split(sep).filter((component) => component.length > 0);
  let currentPath = root;

  for (const pathComponent of pathComponents) {
    currentPath = join(currentPath, pathComponent);

    if (!validateExistingDirectoryPath(currentPath, kind)) {
      return;
    }
  }
}
