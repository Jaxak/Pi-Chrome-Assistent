import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_DIRECT_SESSION_HOST } from "../shared/constants";
import type {
  ChatEvent,
  DirectCommandResult,
  DirectSessionSnapshot,
  SelectionPayload,
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
// Event helpers
// ---------------------------------------------------------------------------

function getAssistantMessageId(event: unknown): string | undefined {
  // Handle test shape { message: { id: 'msg-1', role: 'assistant' } }
  // and possible variants with messageId
  const message = (event as { message?: { id?: unknown; messageId?: unknown; role?: unknown } })?.message;

  if (message?.role !== "assistant") {
    return undefined;
  }

  const id = message.id ?? message.messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function getAssistantTextDelta(event: unknown): string | undefined {
  const assistantMessageEvent = (event as {
    assistantMessageEvent?: {
      text_delta?: unknown;
      delta?: unknown;
      textDelta?: unknown;
      text?: unknown;
    };
  })?.assistantMessageEvent;

  const delta =
    assistantMessageEvent?.text_delta ??
    assistantMessageEvent?.delta ??
    assistantMessageEvent?.textDelta ??
    assistantMessageEvent?.text;

  return typeof delta === "string" ? delta : undefined;
}

// ---------------------------------------------------------------------------
// Merge helpers — append-only overlap merge of session history + transient
// ---------------------------------------------------------------------------

/**
 * Produce a stable signature string for a single ChatEvent.
 * Used to detect exact structural equality during overlap detection.
 */
function eventSignature(evt: ChatEvent): string {
  switch (evt.kind) {
    case "user_message":
      return `user|${evt.text}|${evt.timestamp}`;
    case "agent_busy":
      return `busy|${evt.busy}|${evt.label}|${evt.timestamp}`;
    case "assistant_message_start":
      return `ast_start|${evt.messageId}|${evt.timestamp}`;
    case "assistant_text_delta":
      return `ast_delta|${evt.messageId}|${evt.delta}|${evt.timestamp}`;
    case "assistant_message_end":
      return `ast_end|${evt.messageId}|${evt.timestamp}`;
    case "error":
      return `err|${evt.message}|${evt.timestamp}`;
  }
}

/**
 * Find the length of the longest overlap between the suffix of `base` and the prefix of `overlay`.
 * Returns the number of consecutive events at the start of `overlay` that match
 * the tail of `base` by exact signature.
 */
function findOverlapIndex(base: ChatEvent[], overlay: ChatEvent[]): number {
  if (base.length === 0 || overlay.length === 0) return 0;

  const maxOverlap = Math.min(base.length, overlay.length);
  for (let len = maxOverlap; len >= 1; len--) {
    let match = true;
    for (let i = 0; i < len; i++) {
      if (eventSignature(base[base.length - len + i]) !== eventSignature(overlay[i])) {
        match = false;
        break;
      }
    }
    if (match) return len;
  }
  return 0;
}

/**
 * Merge authoritative session history with transient overlay events
 * using append-only overlap merge.
 *
 * Strategy:
 * - sessionHistory is the authoritative base.
 * - transient is the recent overlay (in-memory events since last persist).
 * - Find the longest prefix of transient that exactly matches a suffix of
 *   sessionHistory (by event signatures).
 * - Append the non-overlapping suffix of transient to sessionHistory.
 *
 * This avoids eating new events that merely share text with older history entries.
 */
export function mergeChatEvents(
  sessionHistory: ChatEvent[],
  transient: ChatEvent[],
): ChatEvent[] {
  if (transient.length === 0) return [...sessionHistory];
  if (sessionHistory.length === 0) return [...transient];

  const overlap = findOverlapIndex(sessionHistory, transient);
  const newEvents = transient.slice(overlap);

  return [...sessionHistory, ...newEvents];
}

// ---------------------------------------------------------------------------
// Session history from sessionManager
// ---------------------------------------------------------------------------

/** Build authoritative chat events from sessionManager branch entries. */
export function buildChatEventsFromSessionBranch(options: {
  ctx: ExtensionContext | undefined;
  now: () => number;
}): ChatEvent[] {
  const branch = options.ctx?.sessionManager?.getBranch?.() ?? [];
  const events: ChatEvent[] = [];
  const baseTs = options.now();

  for (const entry of branch) {
    if (entry.type !== "message") continue;

    const msg = entry.message;
    const ts = msg.timestamp
      ? (msg.timestamp as number)
      : baseTs;

    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      if (text.length > 0) {
        events.push({ kind: "user_message", text, timestamp: ts });
      }
    } else if (msg.role === "assistant") {
      const id = (msg as { id?: string }).id ?? entry.id;
      events.push({ kind: "assistant_message_start", messageId: id, timestamp: ts });
      const text = extractTextContent(msg.content);
      if (text.length > 0) {
        events.push({ kind: "assistant_text_delta", messageId: id, delta: text, timestamp: ts });
      }
      events.push({ kind: "assistant_message_end", messageId: id, timestamp: ts });
    }
  }

  return events;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => typeof c === "object" && c !== null && "text" in c)
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");
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
  let chatEvents: ChatEvent[] = [];

  const broadcastSnapshot = () => {
    activeSessionServer?.broadcastSnapshot();
  };

  // ----- Pi event handlers -----

  pi.on("model_select", (_event, ctx) => {
    latestCtx = ctx;
    broadcastSnapshot();
  });

  pi.on("turn_end", (_event, ctx) => {
    latestCtx = ctx;
    broadcastSnapshot();
  });

  pi.on("session_compact", (_event, ctx) => {
    latestCtx = ctx;
    broadcastSnapshot();
  });

  pi.on("message_start", (event) => {
    const messageId = getAssistantMessageId(event);
    if (messageId) {
      chatEvents.push({
        kind: "assistant_message_start",
        messageId,
        timestamp: Date.now(),
      });
    }
    broadcastSnapshot();
  });

  pi.on("message_update", (event) => {
    const messageId = getAssistantMessageId(event);
    const delta = getAssistantTextDelta(event);
    if (messageId && delta !== undefined) {
      chatEvents.push({
        kind: "assistant_text_delta",
        messageId,
        delta,
        timestamp: Date.now(),
      });
    }
    broadcastSnapshot();
  });

  pi.on("message_end", (event) => {
    const messageId = getAssistantMessageId(event);
    if (messageId) {
      chatEvents.push({
        kind: "assistant_message_end",
        messageId,
        timestamp: Date.now(),
      });
    }
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

  // ----- Snapshot builder -----

  const buildSnapshot = (): DirectSessionSnapshot => {
    const ctx = latestCtx;
    const runtime = buildDirectRuntimeState({ ctx: ctx as Parameters<typeof buildDirectRuntimeState>[0]["ctx"] });

    // Merge authoritative session history with transient in-memory events,
    // avoiding duplicates when transient events have already been persisted.
    const sessionHistory = buildChatEventsFromSessionBranch({ ctx, now: Date.now });
    const mergedEvents = mergeChatEvents(sessionHistory, chatEvents);

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
        events: mergedEvents,
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

      chatEvents = [];

      try {
        const server = await startDirectSessionServerOnAvailablePort({
          host: DEFAULT_DIRECT_SESSION_HOST,
          preferredPort: DEFAULT_DIRECT_SESSION_PORT,
          buildSnapshot,
          onChatMessage: async (message: string): Promise<DirectCommandResult> => {
            try {
              chatEvents.push({ kind: "user_message", text: message, timestamp: Date.now() });
              chatEvents.push({ kind: "agent_busy", busy: true, label: "Агент работает в фоне…", timestamp: Date.now() });
              broadcastSnapshot();

              const deliveryOptions = ctx.isIdle() ? undefined : ({ deliverAs: "followUp" } as const);
              await pi.sendUserMessage(message, deliveryOptions);
              broadcastSnapshot();
              return { ok: true };
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : "Неизвестная ошибка";
              chatEvents.push({ kind: "error", message: errMsg, timestamp: Date.now() });
              broadcastSnapshot();
              return { ok: false, error: errMsg };
            }
          },
          onSelection: async (selection: SelectionPayload): Promise<DirectCommandResult> => {
            try {
              const formatted = formatSelectionMessage(selection);
              chatEvents.push({ kind: "user_message", text: formatted, timestamp: Date.now() });
              chatEvents.push({ kind: "agent_busy", busy: true, label: "Агент работает в фоне…", timestamp: Date.now() });
              broadcastSnapshot();

              const deliveryOptions = ctx.isIdle() ? undefined : ({ deliverAs: "followUp" } as const);
              await pi.sendUserMessage(formatted, deliveryOptions);
              broadcastSnapshot();
              return { ok: true };
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : "Неизвестная ошибка";
              chatEvents.push({ kind: "error", message: errMsg, timestamp: Date.now() });
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
