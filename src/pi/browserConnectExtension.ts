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
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_BROKER_HOST, DEFAULT_BROKER_PORT } from "../shared/constants";
import { startBrokerServer, type BrowserConnectBrokerServer } from "./broker";
import {
  getChromeAssistentLogPath,
  getGlobalBrokerTokenPath,
} from "./chromeAssistentPaths";
import { createFileLogger, type BrowserConnectLogger } from "./logging";
import { toNodeError, validateDirectoryPathChain } from "./secureFilesystem";
import {
  buildTargetMetadata,
  connectTargetToBroker,
  getTargetDisplayLabel,
  handleDeliveredSelection,
  type ConnectedTargetClient,
} from "./targetClient";

const STATUS_KEY = "chrome-assistent-connect";
const PUBLIC_COMMAND_NAME = "/chrome-assistent-connect";

function normalizeAlias(args: string): string | undefined {
  const alias = args.trim();
  return alias.length > 0 ? alias : undefined;
}

function enforcePermissions(path: string, mode: number, kind: "token directory" | "token file"): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    const nodeError = toNodeError(error);
    const reason = nodeError.message.length > 0 ? nodeError.message : "Unknown error";
    throw new Error(`Failed to secure ${kind} permissions at ${path}: ${reason}`);
  }
}

function ensureTokenDirectoryPermissions(tokenFilePath: string): void {
  const tokenDirectoryPath = dirname(tokenFilePath);
  validateDirectoryPathChain(tokenDirectoryPath, "Shared token directory");
  mkdirSync(tokenDirectoryPath, {
    recursive: true,
    mode: 0o700,
  });
  validateDirectoryPathChain(tokenDirectoryPath, "Shared token directory");
  enforcePermissions(tokenDirectoryPath, 0o700, "token directory");
}

function getNoFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("Secure shared token file operations require fs.constants.O_NOFOLLOW support");
  }

  return fsConstants.O_NOFOLLOW;
}

function openTokenFile(tokenFilePath: string, flags: number, mode?: number): number {
  try {
    return mode === undefined ? openSync(tokenFilePath, flags) : openSync(tokenFilePath, flags, mode);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ELOOP") {
      throw new Error(`Shared token file must not be a symlink: ${tokenFilePath}`);
    }

    throw error;
  }
}

function validateOpenTokenFile(fd: number, tokenFilePath: string): void {
  if (!fstatSync(fd).isFile()) {
    throw new Error(`Shared token file must be a regular file: ${tokenFilePath}`);
  }
}

function enforceTokenFilePermissions(fd: number, tokenFilePath: string): void {
  try {
    fchmodSync(fd, 0o600);
  } catch (error) {
    const nodeError = toNodeError(error);
    const reason = nodeError.message.length > 0 ? nodeError.message : "Unknown error";
    throw new Error(`Failed to secure token file permissions at ${tokenFilePath}: ${reason}`);
  }
}

function readExistingToken(tokenFilePath: string): string | undefined {
  validateDirectoryPathChain(dirname(tokenFilePath), "Shared token directory");
  const fd = openTokenFile(tokenFilePath, fsConstants.O_RDONLY | getNoFollowFlag());

  try {
    validateOpenTokenFile(fd, tokenFilePath);
    const existingToken = readFileSync(fd, "utf8").trim();
    enforceTokenFilePermissions(fd, tokenFilePath);

    if (existingToken.length === 0) {
      return undefined;
    }

    return existingToken;
  } finally {
    closeSync(fd);
  }
}

function createTokenFile(tokenFilePath: string, token: string): void {
  validateDirectoryPathChain(dirname(tokenFilePath), "Shared token directory");
  const fd = openTokenFile(
    tokenFilePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | getNoFollowFlag(),
    0o600,
  );

  try {
    validateOpenTokenFile(fd, tokenFilePath);
    writeFileSync(fd, `${token}\n`, {
      encoding: "utf8",
    });
    enforceTokenFilePermissions(fd, tokenFilePath);
  } finally {
    closeSync(fd);
  }
}

export function readOrCreateSharedToken(tokenFilePath = getGlobalBrokerTokenPath()): string {
  ensureTokenDirectoryPermissions(tokenFilePath);

  try {
    const existingToken = readExistingToken(tokenFilePath);

    if (existingToken) {
      return existingToken;
    }
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const token = randomUUID();

  try {
    createTokenFile(tokenFilePath, token);
    return token;
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code !== "EEXIST") {
      throw error;
    }
  }

  const existingToken = readExistingToken(tokenFilePath);

  if (!existingToken) {
    throw new Error(`Shared token file exists but is empty: ${tokenFilePath}`);
  }

  return existingToken;
}

function buildStatusText(label: string, port: number): string {
  return `${PUBLIC_COMMAND_NAME}: ${label} · подключено · ${DEFAULT_BROKER_HOST}:${port}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Unknown error";
}

function isAddressInUseError(error: unknown): boolean {
  const nodeError = toNodeError(error);

  if (nodeError.code === "EADDRINUSE") {
    return true;
  }

  const errorMessage = toErrorMessage(error);
  return /eaddrinuse|address already in use/i.test(errorMessage);
}

export async function activateBrowserConnectConnection(options: {
  connection: ConnectedTargetClient;
  disconnectedBeforeActivation: boolean;
  setActiveConnection(connection: ConnectedTargetClient): void;
  label: string;
  logger: BrowserConnectLogger;
}): Promise<ConnectedTargetClient> {
  if (!options.disconnectedBeforeActivation && options.connection.isOpen()) {
    options.setActiveConnection(options.connection);
    return options.connection;
  }

  options.logger.warn("browser_connect.command.activation_aborted_disconnected", {
    label: options.label,
    port: options.connection.port,
  });

  try {
    await options.connection.close();
  } catch (error) {
    options.logger.warn("browser_connect.target.activation_cleanup_failed", {
      error: toErrorMessage(error),
      label: options.label,
      port: options.connection.port,
    });
  }

  throw new Error(
    `Подключение ${PUBLIC_COMMAND_NAME} закрылось до завершения активации: ${options.label} · ${DEFAULT_BROKER_HOST}:${options.connection.port}`,
  );
}

export function handleUnexpectedBrowserConnectDisconnect(options: {
  disconnectedConnection?: Pick<ConnectedTargetClient, "port">;
  activeTargetConnection?: Pick<ConnectedTargetClient, "port">;
  ownedBroker?: Pick<BrowserConnectBrokerServer, "port">;
  clearActiveConnection(): void;
  resetOwnedBroker?(): void;
  ctx: {
    ui: Pick<ExtensionContext["ui"], "setStatus" | "notify">;
  };
  label: string;
  port: number;
  logger: BrowserConnectLogger;
}): boolean {
  if (
    options.disconnectedConnection &&
    options.activeTargetConnection !== options.disconnectedConnection
  ) {
    return false;
  }

  options.clearActiveConnection();

  if (
    options.resetOwnedBroker &&
    options.disconnectedConnection &&
    options.ownedBroker?.port === options.disconnectedConnection.port
  ) {
    options.resetOwnedBroker();
  }

  options.ctx.ui.setStatus(STATUS_KEY, undefined);
  options.ctx.ui.notify(
    `Подключение ${PUBLIC_COMMAND_NAME} прервано: ${options.label} · ${DEFAULT_BROKER_HOST}:${options.port}`,
    "warning",
  );
  options.logger.warn("browser_connect.target.disconnected", {
    label: options.label,
    port: options.port,
  });
  return true;
}

export async function recoverOwnedBrokerAfterConnectFailure(options: {
  attemptedPort: number;
  ownedBroker?: Pick<BrowserConnectBrokerServer, "port">;
  closeOwnedBroker(): Promise<void>;
}): Promise<boolean> {
  if (!options.ownedBroker || options.attemptedPort !== options.ownedBroker.port) {
    return false;
  }

  await options.closeOwnedBroker();
  return true;
}

export async function startOwnedBrokerIfNeeded(options: {
  getOwnedBroker(): Pick<BrowserConnectBrokerServer, "port"> | undefined;
  closingOwnedBroker?: Promise<void>;
  startBroker(): Promise<BrowserConnectBrokerServer>;
  setOwnedBroker(broker: BrowserConnectBrokerServer): void;
}): Promise<BrowserConnectBrokerServer | undefined> {
  await options.closingOwnedBroker;

  if (options.getOwnedBroker()) {
    return undefined;
  }

  const broker = await options.startBroker();
  options.setOwnedBroker(broker);
  return broker;
}

export default function browserConnectExtension(pi: ExtensionAPI): void {
  const logger: BrowserConnectLogger = createFileLogger(getChromeAssistentLogPath());
  const targetId = randomUUID();
  let sharedToken: string | undefined;
  let activeTargetConnection: ConnectedTargetClient | undefined;
  let ownedBroker: BrowserConnectBrokerServer | undefined;
  let closingOwnedBroker: Promise<void> | undefined;

  const closeTargetConnection = async () => {
    if (!activeTargetConnection) {
      return;
    }

    const targetConnection = activeTargetConnection;
    activeTargetConnection = undefined;
    await targetConnection.close();
  };

  const closeOwnedBroker = async () => {
    if (closingOwnedBroker) {
      await closingOwnedBroker;
      return;
    }

    if (!ownedBroker) {
      return;
    }

    const broker = ownedBroker;
    const closePromise = broker.close().finally(() => {
      if (ownedBroker === broker) {
        ownedBroker = undefined;
      }

      if (closingOwnedBroker === closePromise) {
        closingOwnedBroker = undefined;
      }
    });

    closingOwnedBroker = closePromise;
    await closePromise;
  };

  const cleanupBrowserConnect = async (ctx?: ExtensionContext) => {
    await closeTargetConnection().catch((error) => {
      logger.warn("browser_connect.target.close_failed", {
        error: toErrorMessage(error),
      });
    });

    await closeOwnedBroker().catch((error) => {
      logger.warn("browser_connect.broker.close_failed", {
        error: toErrorMessage(error),
      });
    });

    ctx?.ui.setStatus(STATUS_KEY, undefined);
  };

  pi.registerCommand("chrome-assistent-connect", {
    description: "Подключить текущую сессию Pi к локальному брокеру Chrome Assistent",
    handler: async (args, ctx) => {
      const alias = normalizeAlias(args);
      const token = sharedToken ?? readOrCreateSharedToken();
      sharedToken = token;

      await closeTargetConnection().catch((error) => {
        logger.warn("browser_connect.target.reconnect_cleanup_failed", {
          error: toErrorMessage(error),
        });
      });

      await closingOwnedBroker;

      const metadata = await buildTargetMetadata({
        targetId,
        alias,
        cwd: ctx.cwd,
        pid: process.pid,
        sessionName: pi.getSessionName(),
      });

      const label = getTargetDisplayLabel(metadata);
      const connectOptions = {
        host: DEFAULT_BROKER_HOST,
        port: ownedBroker?.port ?? DEFAULT_BROKER_PORT,
        token,
        metadata,
        logger,
        onDeliveredSelection: (selection: Parameters<typeof handleDeliveredSelection>[0]["selection"]) =>
          handleDeliveredSelection({
            selection,
            isIdle: () => ctx.isIdle(),
            sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
            logger,
          }),
      } as const;

      let startedBrokerForThisCommand: BrowserConnectBrokerServer | undefined;

      const connectAndActivate = async (port: number) => {
        let attemptConnectionPort = port;
        let attemptActivationCommitted = false;
        let attemptDisconnectedBeforeActivation = false;
        let attemptPendingTargetConnection: ConnectedTargetClient | undefined;
        const onDisconnect = () => {
          attemptDisconnectedBeforeActivation = true;

          if (!attemptActivationCommitted || !attemptPendingTargetConnection) {
            logger.warn("browser_connect.target.disconnected_before_activation", {
              label,
              port: attemptConnectionPort,
            });
            return;
          }

          handleUnexpectedBrowserConnectDisconnect({
            disconnectedConnection: attemptPendingTargetConnection,
            activeTargetConnection,
            ownedBroker,
            clearActiveConnection: () => {
              activeTargetConnection = undefined;
            },
            resetOwnedBroker: () => {
              void closeOwnedBroker().catch((error) => {
                logger.warn("browser_connect.broker.disconnect_cleanup_failed", {
                  error: toErrorMessage(error),
                  port: attemptConnectionPort,
                });
              });
            },
            ctx,
            label,
            port: attemptConnectionPort,
            logger,
          });
        };

        attemptPendingTargetConnection = await connectTargetToBroker({
          ...connectOptions,
          port,
          onDisconnect,
        });
        attemptConnectionPort = attemptPendingTargetConnection.port;
        await activateBrowserConnectConnection({
          connection: attemptPendingTargetConnection,
          disconnectedBeforeActivation: attemptDisconnectedBeforeActivation,
          setActiveConnection: (connection) => {
            activeTargetConnection = connection;
            attemptActivationCommitted = true;
          },
          label,
          logger,
        });
      };

      try {
        try {
          await connectAndActivate(connectOptions.port);
        } catch (connectError) {
          logger.warn("browser_connect.connect_failed", {
            error: toErrorMessage(connectError),
            port: connectOptions.port,
          });

          await recoverOwnedBrokerAfterConnectFailure({
            attemptedPort: connectOptions.port,
            ownedBroker,
            closeOwnedBroker,
          }).catch((error) => {
            logger.warn("browser_connect.broker.reconnect_cleanup_failed", {
              error: toErrorMessage(error),
              port: connectOptions.port,
            });
          });

          try {
            startedBrokerForThisCommand = await startOwnedBrokerIfNeeded({
              getOwnedBroker: () => ownedBroker,
              closingOwnedBroker,
              startBroker: () => startBrokerServer({
                host: DEFAULT_BROKER_HOST,
                port: DEFAULT_BROKER_PORT,
                token,
                logger,
              }),
              setOwnedBroker: (broker) => {
                ownedBroker = broker;
              },
            });
          } catch (startBrokerError) {
            if (!isAddressInUseError(startBrokerError)) {
              throw startBrokerError;
            }

            logger.warn("browser_connect.broker.start_race_recovered", {
              error: toErrorMessage(startBrokerError),
              port: DEFAULT_BROKER_PORT,
            });
          }

          await connectAndActivate(ownedBroker?.port ?? DEFAULT_BROKER_PORT);
        }
      } catch (error) {
        if (startedBrokerForThisCommand) {
          await closeOwnedBroker().catch(() => undefined);
        }

        const errorMessage = toErrorMessage(error);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(`Не удалось выполнить ${PUBLIC_COMMAND_NAME}: ${errorMessage}`, "error");
        logger.error("browser_connect.command.failed", {
          error: errorMessage,
          alias,
        });
        throw error;
      }

      const connectedTargetConnection = activeTargetConnection;

      if (!connectedTargetConnection) {
        throw new Error(`Активация ${PUBLIC_COMMAND_NAME} завершилась без активного подключения`);
      }

      const port = connectedTargetConnection.port;

      ctx.ui.setStatus(STATUS_KEY, buildStatusText(label, port));
      ctx.ui.notify(`Подключение ${PUBLIC_COMMAND_NAME} активно: ${label} · ${DEFAULT_BROKER_HOST}:${port}`, "info");
      logger.info("browser_connect.command.connected", {
        alias,
        port,
        targetId,
        ownsBroker: ownedBroker !== undefined,
      });
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await cleanupBrowserConnect(ctx);
  });
}
