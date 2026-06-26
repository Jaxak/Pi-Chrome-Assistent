import {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_PORT,
  PROTOCOL_VERSION,
} from "../shared/constants";
import {
  createRequestId,
  parseProtocolEnvelope,
  validateChatEvent,
  type ChatEvent,
  type TargetMetadata,
} from "../shared/protocol";

export type BrokerConnectionState = {
  online: boolean;
  statusText: string;
};

export type BrokerSocketEventName = "open" | "message" | "error" | "close";
export type BrokerSocketEventListener = (event?: { data?: string }) => void;

export interface BrokerSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    eventName: BrokerSocketEventName,
    listener: BrokerSocketEventListener,
    options?: { once?: boolean },
  ): void;
  removeEventListener(eventName: BrokerSocketEventName, listener: BrokerSocketEventListener): void;
}

export type BrokerClientOptions = {
  browserToken: string;
  selectedTargetId?: string;
  brokerUrl?: string;
  webSocketFactory?: (url: string) => BrokerSocket;
  requestIdFactory?: () => string;
  onTargets?: (targets: TargetMetadata[]) => void;
  onChatEvent?: (event: ChatEvent) => void;
  onConnectionState?: (state: BrokerConnectionState) => void;
  reconnectDelaysMs?: number[];
  handshakeTimeoutMs?: number;
};

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000];
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_BROKER_URL = `ws://${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}`;
const TARGET_UNAVAILABLE_ERROR = "Target is not available";
const BROWSER_AUTH_ERROR_PREFIX = "Браузер не авторизован";

function createBrowserWebSocket(url: string): BrokerSocket {
  return new WebSocket(url) as unknown as BrokerSocket;
}

function isOpen(socket: BrokerSocket | undefined): socket is BrokerSocket {
  return socket?.readyState === SOCKET_OPEN;
}

function sendEnvelope(
  socket: BrokerSocket,
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

function isTargetMetadata(value: unknown): value is TargetMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const target = value as Partial<TargetMetadata>;
  return (
    typeof target.targetId === "string" &&
    target.targetId.length > 0 &&
    (target.alias === undefined || typeof target.alias === "string") &&
    typeof target.cwd === "string" &&
    target.cwd.length > 0 &&
    (target.gitBranch === undefined || typeof target.gitBranch === "string") &&
    typeof target.pid === "number" &&
    Number.isFinite(target.pid) &&
    (target.sessionName === undefined || typeof target.sessionName === "string") &&
    typeof target.connectedAt === "number" &&
    Number.isFinite(target.connectedAt) &&
    typeof target.lastSeenAt === "number" &&
    Number.isFinite(target.lastSeenAt)
  );
}

export class BrokerClient {
  private readonly browserToken: string;
  private readonly brokerUrl: string;
  private selectedTargetId: string | undefined;
  private readonly webSocketFactory: (url: string) => BrokerSocket;
  private readonly requestIdFactory: () => string;
  private readonly reconnectDelaysMs: number[];
  private readonly handshakeTimeoutMs: number;
  private readonly onTargets?: (targets: TargetMetadata[]) => void;
  private readonly onChatEvent?: (event: ChatEvent) => void;
  private readonly onConnectionState?: (state: BrokerConnectionState) => void;
  private socket: BrokerSocket | undefined;
  private closedByClient = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private fatalAuthError = false;
  private lastReportedState: BrokerConnectionState | undefined;

  constructor(options: BrokerClientOptions) {
    this.browserToken = options.browserToken;
    this.selectedTargetId = options.selectedTargetId;
    this.brokerUrl = options.brokerUrl ?? DEFAULT_BROKER_URL;
    this.webSocketFactory = options.webSocketFactory ?? createBrowserWebSocket;
    this.requestIdFactory = options.requestIdFactory ?? createRequestId;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.onTargets = options.onTargets;
    this.onChatEvent = options.onChatEvent;
    this.onConnectionState = options.onConnectionState;
  }

  connect(): void {
    this.closedByClient = false;
    this.fatalAuthError = false;
    this.clearReconnectTimer();
    this.clearHandshakeTimer();

    const currentSocket = this.socket;

    if (currentSocket?.readyState === SOCKET_CONNECTING || currentSocket?.readyState === SOCKET_OPEN) {
      this.socket = undefined;
      currentSocket.close();
    }

    this.reportState(false, "Подключаемся к Pi…");
    this.openSocket();
  }

  setSelectedTargetId(targetId: string | undefined): void {
    const previousTargetId = this.selectedTargetId;
    this.selectedTargetId = targetId;

    if (!isOpen(this.socket) || previousTargetId === targetId) {
      return;
    }

    if (previousTargetId) {
      this.unsubscribe(previousTargetId);
    }

    if (targetId) {
      this.subscribe(targetId);
    }
  }

  sendChatMessage(message: string): boolean {
    const text = message.trim();

    const socket = this.socket;

    if (!text || !this.selectedTargetId || !isOpen(socket)) {
      return false;
    }

    sendEnvelope(socket, {
      type: "client.sendChatMessage",
      requestId: this.requestIdFactory(),
      payload: {
        token: this.browserToken,
        targetId: this.selectedTargetId,
        message: text,
      },
    });
    return true;
  }

  close(): void {
    this.closedByClient = true;
    this.clearReconnectTimer();
    this.clearHandshakeTimer();

    if (this.socket && (this.socket.readyState === SOCKET_CONNECTING || this.socket.readyState === SOCKET_OPEN)) {
      this.socket.close();
    }
  }

  private openSocket(): void {
    const socket = this.webSocketFactory(this.brokerUrl);
    this.socket = socket;

    const isCurrentActiveSocket = () => this.socket === socket && !this.closedByClient;

    const onOpen = () => {
      if (!isCurrentActiveSocket()) {
        return;
      }

      this.reconnectAttempt = 0;
      sendEnvelope(socket, {
        type: "client.hello",
        requestId: this.requestIdFactory(),
        payload: { token: this.browserToken },
      });
      sendEnvelope(socket, {
        type: "client.listTargets",
        requestId: this.requestIdFactory(),
      });
      this.startHandshakeTimer(socket);
    };

    const onMessage = (event?: { data?: string }) => {
      if (!isCurrentActiveSocket() || typeof event?.data !== "string") {
        return;
      }

      this.handleEnvelope(event.data);
    };

    const onError = () => {
      if (!isCurrentActiveSocket()) {
        return;
      }

      this.closeCurrentSocketForReconnect("Pi недоступен");
    };

    const onClose = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);

      const wasCurrentSocket = this.socket === socket;

      if (wasCurrentSocket) {
        this.socket = undefined;
      }

      if (wasCurrentSocket) {
        this.clearHandshakeTimer();
      }

      if (!this.closedByClient && !this.fatalAuthError && wasCurrentSocket) {
        this.reportState(false, "Pi недоступен");
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

    if (!envelope) {
      return;
    }

    if (envelope.type === "client.targets") {
      this.clearHandshakeTimer();
      const targets = (envelope.payload as { targets?: unknown } | undefined)?.targets;
      const validTargets = Array.isArray(targets) ? targets.filter(isTargetMetadata) : [];
      this.reportState(true, "Pi подключён");
      this.onTargets?.(validTargets);

      if (this.selectedTargetId && validTargets.some((target) => target.targetId === this.selectedTargetId)) {
        this.subscribe(this.selectedTargetId);
      }
      return;
    }

    if (envelope.type === "client.chatEvent") {
      const validation = validateChatEvent(envelope.payload);

      if (validation.ok) {
        this.onChatEvent?.(envelope.payload as ChatEvent);
      }
      return;
    }

    if (envelope.type === "client.error") {
      this.clearHandshakeTimer();
      const error = (envelope.payload as { error?: unknown } | undefined)?.error;
      const errorMessage = typeof error === "string" && error.length > 0 ? error : "Pi недоступен";

      if (errorMessage === TARGET_UNAVAILABLE_ERROR) {
        this.reportState(true, "Pi подключён");
        return;
      }

      if (errorMessage.startsWith(BROWSER_AUTH_ERROR_PREFIX)) {
        this.fatalAuthError = true;
      }

      this.reportState(false, errorMessage);
    }
  }

  private closeCurrentSocketForReconnect(statusText: string): void {
    const socket = this.socket;

    if (!socket) {
      return;
    }

    this.reportState(false, statusText);

    if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
      socket.close();
    }
  }

  private startHandshakeTimer(socket: BrokerSocket): void {
    this.clearHandshakeTimer();

    this.handshakeTimer = setTimeout(() => {
      if (this.socket !== socket || this.closedByClient) {
        return;
      }

      this.closeCurrentSocketForReconnect("Pi недоступен");
    }, this.handshakeTimeoutMs);
  }

  private subscribe(targetId: string): void {
    const socket = this.socket;

    if (!isOpen(socket)) {
      return;
    }

    sendEnvelope(socket, {
      type: "client.subscribeTarget",
      requestId: this.requestIdFactory(),
      payload: {
        token: this.browserToken,
        targetId,
      },
    });
  }

  private unsubscribe(targetId: string): void {
    const socket = this.socket;

    if (!isOpen(socket)) {
      return;
    }

    sendEnvelope(socket, {
      type: "client.unsubscribeTarget",
      requestId: this.requestIdFactory(),
      payload: {
        token: this.browserToken,
        targetId,
      },
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelaysMs[this.reconnectAttempt];
    this.reconnectAttempt += 1;

    if (delay === undefined) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reportState(false, "Подключаемся к Pi…");
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private reportState(online: boolean, statusText: string): void {
    const nextState = { online, statusText };

    if (
      this.lastReportedState?.online === nextState.online &&
      this.lastReportedState.statusText === nextState.statusText
    ) {
      return;
    }

    this.lastReportedState = nextState;
    this.onConnectionState?.(nextState);
  }
}
