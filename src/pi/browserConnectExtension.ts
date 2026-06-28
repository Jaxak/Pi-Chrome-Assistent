import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_DIRECT_SESSION_HOST } from "../shared/constants";
import type {
  DirectCommandResult,
  DirectSessionSnapshot,
  SelectionPayload,
  SessionEntryLike,
  TargetModelSummary,
} from "../shared/protocol";
import { formatSelectionMessage } from "../shared/formatSelectionMessage";
import {
  DEFAULT_DIRECT_SESSION_PORT,
  startDirectSessionServerOnAvailablePort,
  type DirectSessionServer,
} from "./sessionServer";
import { createFileLogger } from "./logging";
import { getChromeAssistentLogPath } from "./chromeAssistentPaths";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_KEY = "chrome-assistent-connect";
const COMMAND_NAME = "chrome-assistent-connect";

// ---------------------------------------------------------------------------
// Helpers — exported for testing
// ---------------------------------------------------------------------------

export function buildDirectRuntimeState(options: {
  ctx: {
    model?: { provider?: unknown; id?: unknown; name?: unknown };
    getContextUsage?: () => { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined;
    isIdle: () => boolean;
  };
  now?: () => number;
}): Pick<DirectSessionSnapshot["runtime"], "model" | "contextUsage" | "isIdle" | "updatedAt"> {
  const model = options.ctx.model;
  const usage = options.ctx.getContextUsage?.();

  const modelSummary: TargetModelSummary | undefined =
    typeof model?.provider === "string" && typeof model?.id === "string"
      ? {
          provider: model.provider,
          id: model.id,
          ...(typeof model.name === "string" ? { label: model.name } : {}),
        }
      : undefined;

  const contextUsage =
    usage && typeof usage.contextWindow === "number"
      ? {
          tokens: typeof usage.tokens === "number" || usage.tokens === null ? usage.tokens : null,
          maxTokens: usage.contextWindow,
          percent: typeof usage.percent === "number" || usage.percent === null ? usage.percent : null,
        }
      : undefined;

  return {
    ...(modelSummary ? { model: modelSummary } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    isIdle: options.ctx.isIdle(),
    updatedAt: (options.now ?? Date.now)(),
  };
}

export async function handleDirectModelSet(options: {
  input: { provider: string; modelId: string };
  ctx: {
    modelRegistry: {
      getAvailable(): Promise<Array<{ provider?: unknown; id?: unknown; name?: unknown }>> | Array<{ provider?: unknown; id?: unknown; name?: unknown }>;
    };
  };
  pi: { setModel(model: unknown): Promise<boolean> | boolean };
}): Promise<DirectCommandResult> {
  const models = await options.ctx.modelRegistry.getAvailable();
  const model = models.find(
    (candidate) =>
      candidate.provider === options.input.provider &&
      candidate.id === options.input.modelId,
  );

  if (!model) {
    return { ok: false, error: "Модель недоступна" };
  }

  const changed = await options.pi.setModel(model);
  return changed ? { ok: true } : { ok: false, error: "Не удалось сменить модель" };
}


// ---------------------------------------------------------------------------
// Extension default export
// ---------------------------------------------------------------------------

export default function browserConnectExtension(pi: ExtensionAPI): void {
  const logger = createFileLogger(getChromeAssistentLogPath());
  let activeSessionServer: DirectSessionServer | undefined;
  let latestCtx: ExtensionContext | undefined;
  let latestAlias: string | undefined;
  let connectedAt: number | undefined;


  const broadcastSnapshot = () => {
    activeSessionServer?.broadcastSnapshot();
  };

  // ----- Pi event handlers (broadcast snapshot + forward raw events) -----

  pi.on("model_select", (_event, ctx) => {
    latestCtx = ctx;
    broadcastSnapshot();
  });

  pi.on("turn_start", (event, _ctx) => {
    activeSessionServer?.broadcastEvent({
      type: "turn_start",
      turnId: (event as { turnId?: string })?.turnId ?? "",
    });
    broadcastSnapshot();
  });

  pi.on("turn_end", (event, ctx) => {
    latestCtx = ctx;
    activeSessionServer?.broadcastEvent({
      type: "turn_end",
      turnId: (event as { turnId?: string })?.turnId ?? "",
    });
    // broadcastSnapshot() intentionally omitted here:
    // turn_end event is sufficient to clear agentBusy; snapshot may contain
    // stale isIdle state and overwrite agentBusy back to true (race condition).
  });

  pi.on("session_compact", (_event, ctx) => {
    latestCtx = ctx;
    broadcastSnapshot();
  });

  pi.on("message_start", (event, _ctx) => {
    activeSessionServer?.broadcastEvent({
      type: "message_start",
      message: {
        id: (event as { message?: { id?: string } })?.message?.id ?? "",
        role: (event as { message?: { role?: string } })?.message?.role ?? "",
      },
    });
    broadcastSnapshot();
  });

  pi.on("message_update", (event, _ctx) => {
    const rawAssistantMessageEvent = (event as {
      assistantMessageEvent?: { type?: string; text_delta?: string };
    })?.assistantMessageEvent;

    activeSessionServer?.broadcastEvent({
      type: "message_update",
      message: {
        id: (event as { message?: { id?: string } })?.message?.id ?? "",
        role: (event as { message?: { role?: string } })?.message?.role ?? "",
      },
      ...(rawAssistantMessageEvent?.type === "text_delta" && typeof rawAssistantMessageEvent.text_delta === "string"
        ? {
            assistantMessageEvent: {
              type: "text_delta" as const,
              text_delta: rawAssistantMessageEvent.text_delta,
            },
          }
        : {}),
    });
    broadcastSnapshot();
  });

  pi.on("message_end", (event, ctx) => {
    latestCtx = ctx;
    activeSessionServer?.broadcastEvent({
      type: "message_end",
      message: {
        id: (event as { message?: { id?: string } })?.message?.id ?? "",
        role: (event as { message?: { role?: string } })?.message?.role ?? "",
      },
      stopReason: (event as { stopReason?: string })?.stopReason,
    });
    broadcastSnapshot();
  });

  pi.on("tool_execution_start", (event, _ctx) => {
    activeSessionServer?.broadcastEvent({
      type: "tool_execution_start",
      toolName: (event as { toolName?: string })?.toolName ?? "",
      input: (event as { input?: unknown })?.input,
    });
    broadcastSnapshot();
  });

  pi.on("tool_execution_update", (event, _ctx) => {
    activeSessionServer?.broadcastEvent({
      type: "tool_execution_update",
      toolName: (event as { toolName?: string })?.toolName ?? "",
      output: (event as { output?: unknown })?.output,
    });
    broadcastSnapshot();
  });

  pi.on("tool_execution_end", (event, _ctx) => {
    activeSessionServer?.broadcastEvent({
      type: "tool_execution_end",
      toolName: (event as { toolName?: string })?.toolName ?? "",
      output: (event as { output?: unknown })?.output,
      error: (event as { error?: string })?.error,
    });
    broadcastSnapshot();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (activeSessionServer) {
      const server = activeSessionServer;
      activeSessionServer = undefined;
      await server.close().catch(() => undefined);
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // ----- Snapshot builder — authoritative entries from sessionManager -----

  const toSessionEntryLike = (entry: unknown): SessionEntryLike | null => {
    const candidate = entry as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
      message?: {
        role?: unknown;
        id?: unknown;
        content?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
      };
    };

    if (candidate.type !== "message") {
      return null;
    }

    const role = candidate.message?.role;
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "toolResult" &&
      role !== "custom" &&
      role !== "branchSummary" &&
      role !== "compactionSummary"
    ) {
      return null;
    }

    return {
      type: "message",
      id: typeof candidate.id === "string" ? candidate.id : "",
      timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : new Date().toISOString(),
      message: {
        role,
        ...(typeof candidate.message?.id === "string" ? { id: candidate.message.id } : {}),
        ...(candidate.message?.content !== undefined ? { content: candidate.message.content } : {}),
        ...(typeof candidate.message?.stopReason === "string" ? { stopReason: candidate.message.stopReason } : {}),
        ...(typeof candidate.message?.errorMessage === "string" ? { errorMessage: candidate.message.errorMessage } : {}),
      },
    };
  };

  const buildSnapshot = (): DirectSessionSnapshot => {
    const ctx = latestCtx;
    const runtime = buildDirectRuntimeState({ ctx: ctx as Parameters<typeof buildDirectRuntimeState>[0]["ctx"] });

    // Authoritative history: raw session entries from Pi sessionManager
    const entries = (ctx?.sessionManager?.getBranch?.() ?? []).map(toSessionEntryLike).filter((entry): entry is SessionEntryLike => entry !== null);

    const modelSummary: TargetModelSummary | undefined =
      typeof ctx?.model?.provider === "string" && typeof ctx.model.id === "string"
        ? {
            provider: ctx.model.provider,
            id: ctx.model.id,
            ...(typeof ctx.model.name === "string" ? { label: ctx.model.name } : {}),
          }
        : undefined;

    return {
      session: {
        cwd: ctx?.cwd ?? "",
        pid: process.pid,
        sessionName: ctx ? pi.getSessionName() : undefined,
        alias: latestAlias,
        connectedAt: connectedAt ?? Date.now(),
      },
      chat: {
        entries,
        agentBusy: ctx ? !ctx.isIdle() : false,
        busyLabel: "Агент работает в фоне…",
      },
      runtime: {
        ...(runtime.model ? { model: runtime.model } : {}),
        availableModels: modelSummary ? [modelSummary] : [],
        ...(runtime.contextUsage ? { contextUsage: runtime.contextUsage } : {}),
        isIdle: runtime.isIdle,
        updatedAt: runtime.updatedAt,
      },
    };
  };

  // ----- Command handler -----

  pi.registerCommand(COMMAND_NAME, {
    description: "Подключить текущую сессию Pi к локальному серверу Chrome Assistent (прямое соединение)",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      connectedAt = Date.now();
      latestAlias = args.trim().length > 0 ? args.trim() : undefined;

      // Close previous server if any
      if (activeSessionServer) {
        const prev = activeSessionServer;
        activeSessionServer = undefined;
        await prev.close().catch(() => undefined);
      }

      try {
        const server = await startDirectSessionServerOnAvailablePort({
          host: DEFAULT_DIRECT_SESSION_HOST,
          preferredPort: DEFAULT_DIRECT_SESSION_PORT,
          buildSnapshot,
          onChatMessage: async (message: string): Promise<DirectCommandResult> => {
            try {
              broadcastSnapshot();

              const deliveryOptions = ctx.isIdle() ? undefined : ({ deliverAs: "followUp" } as const);
              await pi.sendUserMessage(message, deliveryOptions);
              broadcastSnapshot();
              return { ok: true };
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : "Неизвестная ошибка";
              broadcastSnapshot();
              return { ok: false, error: errMsg };
            }
          },
          onSelection: async (selection: SelectionPayload): Promise<DirectCommandResult> => {
            try {
              const formatted = formatSelectionMessage(selection);
              broadcastSnapshot();

              const deliveryOptions = ctx.isIdle() ? undefined : ({ deliverAs: "followUp" } as const);
              await pi.sendUserMessage(formatted, deliveryOptions);
              broadcastSnapshot();
              return { ok: true };
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : "Неизвестная ошибка";
              broadcastSnapshot();
              return { ok: false, error: errMsg };
            }
          },
          onSetModel: async (input: { provider: string; modelId: string }): Promise<DirectCommandResult> => {
            const result = await handleDirectModelSet({
              input,
              ctx,
              pi,
            });
            broadcastSnapshot();
            return result;
          },
          logger,
        });

        activeSessionServer = server;
        const port = server.port;

        ctx.ui.setStatus(STATUS_KEY, `${COMMAND_NAME}: подключено · ${DEFAULT_DIRECT_SESSION_HOST}:${port}`);
        ctx.ui.notify(`${COMMAND_NAME}: сервер запущен на порту ${port}`, "info");

        logger.info("browser_connect.command.connected", {
          alias: latestAlias,
          port,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Неизвестная ошибка";
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(`Не удалось выполнить ${COMMAND_NAME}: ${errorMessage}`, "error");
        logger.error("browser_connect.command.failed", {
          error: errorMessage,
        });
        throw error;
      }
    },
  });
}
