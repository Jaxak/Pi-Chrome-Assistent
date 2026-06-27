import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_BROKER_HOST, DEFAULT_BROKER_PORT } from "../shared/constants";
import type { DeliveryResult, TargetRuntimeState } from "../shared/protocol";
import { startBrokerServer, type BrowserConnectBrokerServer } from "./broker";
import {
  getChromeAssistentLogPath,
  getGlobalBrokerTokenPath,
  getTrustedBrowsersPath,
} from "./chromeAssistentPaths";
import { createFileLogger, type BrowserConnectLogger } from "./logging";
import { addTrustedBrowserToken, isTrustedBrowserToken } from "./trustedBrowserStore";
import { toNodeError, validateDirectoryPathChain } from "./secureFilesystem";
import {
  buildTargetMetadata,
  connectTargetToBroker,
  getTargetDisplayLabel,
  handleDeliveredChatMessage,
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
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function getTokenFileFallbackPreOpenStats(tokenFilePath: string): ReturnType<typeof lstatSync> | undefined {
  if (typeof fsConstants.O_NOFOLLOW === "number") {
    return undefined;
  }

  try {
    const stats = lstatSync(tokenFilePath);

    if (stats.isSymbolicLink()) {
      throw new Error(`Shared token file must not be a symlink: ${tokenFilePath}`);
    }

    return stats;
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function assertTokenFileOpenedSafely(
  fd: number,
  tokenFilePath: string,
  preOpenStats: ReturnType<typeof lstatSync> | undefined,
): void {
  if (typeof fsConstants.O_NOFOLLOW === "number") {
    return;
  }

  const openedStats = fstatSync(fd);

  if (preOpenStats !== undefined) {
    if (openedStats.dev !== preOpenStats.dev || openedStats.ino !== preOpenStats.ino) {
      throw new Error(`Shared token file changed while opening: ${tokenFilePath}`);
    }

    return;
  }

  let pathStats: ReturnType<typeof lstatSync>;

  try {
    pathStats = lstatSync(tokenFilePath);
  } catch (error) {
    const nodeError = toNodeError(error);

    if (nodeError.code === "ENOENT") {
      throw new Error(`Shared token file changed while opening: ${tokenFilePath}`);
    }

    throw error;
  }

  if (pathStats.isSymbolicLink()) {
    throw new Error(`Shared token file must not be a symlink: ${tokenFilePath}`);
  }

  if (openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
    throw new Error(`Shared token file changed while opening: ${tokenFilePath}`);
  }
}

function openTokenFile(tokenFilePath: string, flags: number, mode?: number): number {
  const preOpenStats = getTokenFileFallbackPreOpenStats(tokenFilePath);
  let fd: number | undefined;

  try {
    fd = mode === undefined ? openSync(tokenFilePath, flags) : openSync(tokenFilePath, flags, mode);
    assertTokenFileOpenedSafely(fd, tokenFilePath, preOpenStats);
    return fd;
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
    }

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

function getAssistantMessageId(event: unknown): string | undefined {
  const message = (event as { message?: { id?: unknown; messageId?: unknown; role?: unknown } } | undefined)?.message;

  if (message?.role !== "assistant") {
    return undefined;
  }

  const id = message.id ?? message.messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

type RuntimeContextLike = {
  model?: { provider?: unknown; id?: unknown; name?: unknown };
  getContextUsage?: () => { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined;
  isIdle: () => boolean;
};

type ModelRegistryContextLike = {
  modelRegistry: {
    getAvailable(): Promise<Array<{ provider?: unknown; id?: unknown; name?: unknown }>> | Array<{ provider?: unknown; id?: unknown; name?: unknown }>;
  };
};

export function buildTargetRuntimeState(options: {
  targetId: string;
  ctx: RuntimeContextLike;
  now?: () => number;
}): TargetRuntimeState {
  const model = options.ctx.model;
  const usage = options.ctx.getContextUsage?.();

  return {
    targetId: options.targetId,
    ...(typeof model?.provider === "string" && typeof model.id === "string"
      ? {
          model: {
            provider: model.provider,
            id: model.id,
            ...(typeof model.name === "string" ? { label: model.name } : {}),
          },
        }
      : {}),
    ...(usage && typeof usage.contextWindow === "number"
      ? {
          contextUsage: {
            tokens: typeof usage.tokens === "number" || usage.tokens === null ? usage.tokens : null,
            maxTokens: usage.contextWindow,
            percent: typeof usage.percent === "number" || usage.percent === null ? usage.percent : null,
          },
        }
      : {}),
    isIdle: options.ctx.isIdle(),
    updatedAt: (options.now ?? Date.now)(),
  };
}

export async function handleTargetModelSet(options: {
  input: { provider: string; modelId: string };
  ctx: ModelRegistryContextLike;
  pi: { setModel(model: unknown): Promise<boolean> | boolean };
}): Promise<DeliveryResult> {
  const models = await options.ctx.modelRegistry.getAvailable();
  const model = models.find((candidate) => candidate.provider === options.input.provider && candidate.id === options.input.modelId);

  if (!model) {
    return { ok: false, error: "Модель недоступна" };
  }

  const changed = await options.pi.setModel(model);
  return changed ? { ok: true } : { ok: false, error: "Не удалось сменить модель" };
}

function getAssistantTextDelta(event: unknown): string | undefined {
  const assistantMessageEvent = (event as {
    assistantMessageEvent?: {
      type?: unknown;
      text_delta?: unknown;
      delta?: unknown;
      textDelta?: unknown;
      text?: unknown;
    };
  } | undefined)?.assistantMessageEvent;

  const delta = assistantMessageEvent?.text_delta
    ?? assistantMessageEvent?.delta
    ?? assistantMessageEvent?.textDelta
    ?? assistantMessageEvent?.text;

  return typeof delta === "string" ? delta : undefined;
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
  let latestCtx: ExtensionContext | undefined;

  const emitRuntimeState = (ctx = latestCtx) => {
    if (!ctx || !activeTargetConnection?.isOpen()) {
      return;
    }

    activeTargetConnection.emitRuntimeState?.(buildTargetRuntimeState({ targetId, ctx }));
  };

  const emitAvailableModels = async (ctx = latestCtx) => {
    if (!ctx || !activeTargetConnection?.isOpen()) {
      return;
    }

    if (!ctx.modelRegistry?.getAvailable) {
      return;
    }

    try {
      const models = await ctx.modelRegistry.getAvailable();
      activeTargetConnection.emitAvailableModels?.(models
        .filter((model) => typeof model.provider === "string" && typeof model.id === "string")
        .map((model) => ({
          provider: model.provider,
          id: model.id,
          ...(typeof model.name === "string" ? { label: model.name } : {}),
        })));
    } catch (error) {
      logger.warn("browser_connect.runtime.available_models_failed", { error: toErrorMessage(error) });
    }
  };

  pi.on("model_select", (_event, ctx) => {
    latestCtx = ctx;
    emitRuntimeState(ctx);
    void emitAvailableModels(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    latestCtx = ctx;
    emitRuntimeState(ctx);
    void emitAvailableModels(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    latestCtx = ctx;
    emitRuntimeState(ctx);
    void emitAvailableModels(ctx);
  });

  pi.on("message_start", (event) => {
    const messageId = getAssistantMessageId(event);

    if (!messageId) {
      return;
    }

    activeTargetConnection?.emitChatEvent({
      kind: "assistant_message_start",
      messageId,
      timestamp: Date.now(),
    });
  });

  pi.on("message_update", (event) => {
    const messageId = getAssistantMessageId(event);
    const delta = getAssistantTextDelta(event);

    if (!messageId || delta === undefined) {
      return;
    }

    activeTargetConnection?.emitChatEvent({
      kind: "assistant_text_delta",
      messageId,
      delta,
      timestamp: Date.now(),
    });
  });

  pi.on("message_end", (event) => {
    const messageId = getAssistantMessageId(event);

    if (!messageId) {
      return;
    }

    activeTargetConnection?.emitChatEvent({
      kind: "assistant_message_end",
      messageId,
      timestamp: Date.now(),
    });
    activeTargetConnection?.emitChatEvent({
      kind: "agent_busy",
      busy: false,
      label: "Агент работает в фоне…",
      timestamp: Date.now(),
    });
  });

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
      latestCtx = ctx;
      const alias = normalizeAlias(args);
      let startedBrokerForThisCommand: BrowserConnectBrokerServer | undefined;

      try {
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
          onDeliveredChatMessage: (message: string) =>
            handleDeliveredChatMessage({
              message,
              isIdle: () => ctx.isIdle(),
              sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
              emitChatEvent: (event) => activeTargetConnection?.emitChatEvent(event),
              logger,
            }),
          onSetModel: (input: { provider: string; modelId: string }) =>
            handleTargetModelSet({ input, ctx, pi }),
        } as const;

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
                targetToken: token,
                isBrowserTokenTrusted: (browserToken) => isTrustedBrowserToken(getTrustedBrowsersPath(), browserToken),
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

        const connectedTargetConnection = activeTargetConnection;

        if (!connectedTargetConnection) {
          throw new Error(`Активация ${PUBLIC_COMMAND_NAME} завершилась без активного подключения`);
        }

        const port = connectedTargetConnection.port;

        emitRuntimeState(ctx);
        void emitAvailableModels(ctx);

        ctx.ui.setStatus(STATUS_KEY, buildStatusText(label, port));
        ctx.ui.notify(`Подключение ${PUBLIC_COMMAND_NAME} активно: ${label} · ${DEFAULT_BROKER_HOST}:${port}`, "info");
        logger.info("browser_connect.command.connected", {
          alias,
          port,
          targetId,
          ownsBroker: ownedBroker !== undefined,
        });
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
    },
  });

  pi.registerCommand("chrome-assistent-auth", {
    description: "Добавить токен доверенного браузера Chrome Assistent",
    handler: async (_args, ctx) => {
      try {
        const token = await ctx.ui.input(
          "Токен браузера",
          "Вставьте токен из вкладки «Авторизация»",
        );

        if (!token?.trim()) {
          ctx.ui.notify("Токен браузера не указан", "warning");
          return;
        }

        await addTrustedBrowserToken(getTrustedBrowsersPath(), token.trim());
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        ctx.ui.notify(`Не удалось сохранить токен браузера: ${errorMessage}`, "error");
        logger.error("browser_connect.auth.failed", {
          error: errorMessage,
        });
        throw error;
      }

      ctx.ui.notify("Токен браузера сохранён", "info");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await cleanupBrowserConnect(ctx);
  });
}
