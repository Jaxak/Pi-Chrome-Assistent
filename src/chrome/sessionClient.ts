import { PROTOCOL_VERSION } from "../shared/constants";
import {
  createRequestId,
  parseProtocolEnvelope,
  type DirectCommandResult,
  type DirectSessionSnapshot,
  type PiMirrorEvent,
  type SelectionPayload,
} from "../shared/protocol";

export type SessionConnectionState = {
  online: boolean;
  connecting: boolean;
  statusText?: string;
};

export type SessionCommandEventName = "open" | "message" | "error" | "close";
export type SessionCommandEventListener = (event?: { data?: string }) => void;

export interface SessionSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    eventName: SessionCommandEventName,
    listener: SessionCommandEventListener,
    options?: { once?: boolean },
  ): void;
  removeEventListener(eventName: SessionCommandEventName, listener: SessionCommandEventListener): void;
}

export type SessionClientOptions = {
  port: number;
  webSocketFactory?: (url: string) => SessionSocket;
  requestIdFactory?: () => string;
  onSnapshot(snapshot: DirectSessionSnapshot): void;
  onConnectionState(state: SessionConnectionState): void;
  onCommandResult?(result: { requestId: string; result: DirectCommandResult }): void;
  onSessionEvent?(event: PiMirrorEvent): void;
  reconnectDelaysMs?: number[];
};

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000];

function createBrowserWebSocket(url: string): SessionSocket {
  return new WebSocket(url) as unknown as SessionSocket;
}

function isOpen(socket: SessionSocket | undefined): socket is SessionSocket {
  return socket?.readyState === SOCKET_OPEN;
}

function sendEnvelope(
  socket: SessionSocket,
  envelope: {
    type: string;
    requestId?: string;
    payload?: unknown;
  },
): void {
  socket.send(JSON.stringify({
    version: PROTOCOL_VERSION,
    type: envelope.type,
    requestId: envelope.requestId,
    payload: envelope.payload,
  }));
}

function isDirectSessionSnapshot(value: unknown): value is DirectSessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const snap = value as Partial<DirectSessionSnapshot>;
  return snap.session !== undefined && typeof snap.session === "object" &&
    snap.chat !== undefined && typeof snap.chat === "object" &&
    snap.runtime !== undefined && typeof snap.runtime === "object";
}

export class SessionClient {
  private port: number;
  private readonly webSocketFactory: (url: string) => SessionSocket;
  private readonly requestIdFactory: () => string;
  private readonly reconnectDelaysMs: number[];
  private readonly onSnapshot: (snapshot: DirectSessionSnapshot) => void;
  private readonly onConnectionState: (state: SessionConnectionState) => void;
  private readonly onCommandResult?: (result: { requestId: string; result: DirectCommandResult }) => void;
  private readonly onSessionEvent?: (event: PiMirrorEvent) => void;
  private socket: SessionSocket | undefined;
  private closedByClient = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReportedState: SessionConnectionState | undefined;

  constructor(options: SessionClientOptions) {
    this.port = options.port;
    this.webSocketFactory = options.webSocketFactory ?? createBrowserWebSocket;
    this.requestIdFactory = options.requestIdFactory ?? createRequestId;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.onSnapshot = options.onSnapshot;
    this.onConnectionState = options.onConnectionState;
    this.onCommandResult = options.onCommandResult;
    this.onSessionEvent = options.onSessionEvent;
  }

  connect(): void {
    this.closedByClient = false;
    this.clearReconnectTimer();
    this.doConnect(this.port);
  }

  reconnectToPort(port: number): void {
    this.port = port;
    this.clearReconnectTimer();
    this.closedByClient = false;

    const currentSocket = this.socket;
    if (currentSocket) {
      currentSocket.close();
      this.socket = undefined;
    }

    this.doConnect(port);
  }

  sendChatMessage(message: string): boolean {
    const text = message.trim();
    const socket = this.socket;

    if (!text || !isOpen(socket)) {
      return false;
    }

    sendEnvelope(socket, {
      type: "session.chat.send",
      requestId: this.requestIdFactory(),
      payload: { message: text },
    });
    return true;
  }

  sendSelection(selection: SelectionPayload): boolean {
    const socket = this.socket;

    if (!isOpen(socket)) {
      return false;
    }

    sendEnvelope(socket, {
      type: "session.selection.send",
      requestId: this.requestIdFactory(),
      payload: { selection },
    });
    return true;
  }

  setModel(input: { provider: string; modelId: string }): boolean {
    const socket = this.socket;
    const provider = input.provider.trim();
    const modelId = input.modelId.trim();

    if (provider.length === 0 || modelId.length === 0 || !isOpen(socket)) {
      return false;
    }

    sendEnvelope(socket, {
      type: "session.model.set",
      requestId: this.requestIdFactory(),
      payload: { provider, modelId },
    });
    return true;
  }

  close(): void {
    this.closedByClient = true;
    this.clearReconnectTimer();

    if (this.socket && (this.socket.readyState === SOCKET_CONNECTING || this.socket.readyState === SOCKET_OPEN)) {
      this.socket.close();
    }
  }

  private doConnect(port: number): void {
    this.reportState(false, true, "Подключаемся к Pi-сессии…");

    const socket = this.webSocketFactory(`ws://127.0.0.1:${port}`);
    this.socket = socket;

    const isCurrentActiveSocket = () => this.socket === socket && !this.closedByClient;

    const onOpen = () => {
      if (!isCurrentActiveSocket()) return;
    };

    const onMessage = (event?: { data?: string }) => {
      if (!isCurrentActiveSocket() || typeof event?.data !== "string") return;
      this.handleEnvelope(event.data);
    };

    const onError = () => {
      if (!isCurrentActiveSocket()) return;
      this.closeCurrentSocketForReconnect("Pi-сессия недоступна");
    };

    const onClose = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);

      if (this.socket === socket) {
        this.socket = undefined;
      }

      if (!this.closedByClient && this.socket === undefined) {
        this.reportState(false, false, "Pi-сессия недоступна");
        this.scheduleReconnect();
      }
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  }

  private handleEnvelope(raw: string): void {
    const envelope = parseProtocolEnvelope(raw);

    if (!envelope) return;

    switch (envelope.type) {
      case "session.snapshot": {
        if (isDirectSessionSnapshot(envelope.payload)) {
          this.reconnectAttempt = 0;
          this.onSnapshot(envelope.payload);
          this.reportState(true, false, "Подключено к Pi-сессии");
        }
        return;
      }

      case "session.error": {
        const error = (envelope.payload as { error?: unknown } | undefined)?.error;
        const errorMessage = typeof error === "string" && error.length > 0 ? error : "Ошибка сессии";
        this.reportState(false, false, errorMessage);
        return;
      }

      case "session.command.result": {
        const payload = envelope.payload as { ok?: unknown; error?: unknown } | undefined;
        const result: DirectCommandResult = {
          ok: payload?.ok === true,
          ...(typeof payload?.error === "string" ? { error: payload.error } : {}),
        };
        this.onCommandResult?.({
          requestId: envelope.requestId ?? "",
          result,
        });
        return;
      }

      case "session.event": {
        this.onSessionEvent?.(envelope.payload as PiMirrorEvent);
        return;
      }
    }
  }

  private closeCurrentSocketForReconnect(statusText: string): void {
    const socket = this.socket;

    if (!socket) return;

    this.reportState(false, false, statusText);

    if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
      socket.close();
    }
  }

  private scheduleReconnect(): void {
    // Bounded infinite retry: after ramp-up stays at last delay
    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      if (this.closedByClient) return;
      this.doConnect(this.port);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private reportState(online: boolean, connecting: boolean, statusText: string): void {
    const nextState: SessionConnectionState = { online, connecting, statusText };

    if (
      this.lastReportedState?.online === nextState.online &&
      this.lastReportedState?.connecting === nextState.connecting &&
      this.lastReportedState?.statusText === nextState.statusText
    ) {
      return;
    }

    this.lastReportedState = nextState;
    this.onConnectionState(nextState);
  }
}
