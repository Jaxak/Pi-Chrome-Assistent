import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticEntry } from "./diagnostics";
import {
  formatConnectionStatus,
  formatDiagnostics,
  formatLastErrorSummary,
  formatSummary,
  formatTargetPrimaryLabel,
  formatTargetSecondaryLabel,
} from "./popup";
import type { TargetMetadata } from "../shared/protocol";

class FakeDocumentFragment {
  readonly children: FakeElement[] = [];

  append(...nodes: Array<FakeDocumentFragment | FakeElement>): void {
    for (const node of nodes) {
      if (node instanceof FakeDocumentFragment) {
        this.children.push(...node.children);
        node.children.length = 0;
        continue;
      }

      this.children.push(node);
    }
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};

  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  private ownTextContent = "";

  className = "";
  disabled = false;
  id = "";
  title = "";
  type = "";

  constructor(readonly tagName: string) {}

  set textContent(value: string) {
    this.ownTextContent = value;
    this.children.length = 0;
  }

  get textContent(): string {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join("")
      : this.ownTextContent;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);

    if (name === "id") {
      this.id = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: Array<FakeDocumentFragment | FakeElement>): void {
    for (const node of nodes) {
      if (node instanceof FakeDocumentFragment) {
        this.children.push(...node.children);
        node.children.length = 0;
        continue;
      }

      this.children.push(node);
    }
  }

  replaceChildren(...nodes: Array<FakeDocumentFragment | FakeElement>): void {
    this.children.length = 0;
    this.ownTextContent = "";
    this.append(...nodes);
  }

  addEventListener(eventName: string, listener: () => void): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener();
    }
  }
}

class FakeDocument {
  private readonly elementsById = new Map<string, FakeElement>();

  register(id: string, tagName: string, textContent = ""): FakeElement {
    const element = new FakeElement(tagName);
    element.id = id;
    element.setAttribute("id", id);
    element.textContent = textContent;
    this.elementsById.set(id, element);
    return element;
  }

  querySelector<T>(selector: string): T | null {
    if (!selector.startsWith("#")) {
      return null;
    }

    return (this.elementsById.get(selector.slice(1)) ?? null) as T | null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  createDocumentFragment(): FakeDocumentFragment {
    return new FakeDocumentFragment();
  }
}

type PopupRefs = {
  statusText: FakeElement;
  sendButton: FakeElement;
  diagnosticsButton: FakeElement;
  diagnosticsOutput: FakeElement;
  targetContainer: FakeElement;
};

type PopupSetupOptions = {
  diagnostics?: DiagnosticEntry[];
  listTargetsResponse?: {
    ok?: boolean;
    error?: string;
    targets?: TargetMetadata[];
    selectedTargetId?: string;
    tokenConfigured?: boolean;
  };
  runtimeSendMessage?: (message: { type: string; targetId?: string }) => unknown;
  startDomPickerResponses?: Array<{ ok?: boolean; error?: string }>;
  storedSelectedTargetId?: string;
  storageGetError?: Error;
  storageSetError?: Error;
  storageGetNeverResolves?: boolean;
  storageSetNeverResolves?: boolean;
  windowClose?: () => void;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createTarget(overrides: Partial<TargetMetadata> = {}): TargetMetadata {
  return {
    targetId: "target-1",
    alias: "Alpha",
    cwd: "/tmp/pi-alpha",
    gitBranch: "main",
    pid: 101,
    sessionName: "session-a",
    connectedAt: 1_710_000_000_000,
    lastSeenAt: 1_710_000_000_100,
    ...overrides,
  };
}

function createPopupDom(): { document: FakeDocument; refs: PopupRefs } {
  const document = new FakeDocument();
  const refs: PopupRefs = {
    statusText: document.register("status-text", "span", "Ожидание"),
    sendButton: document.register("send-button", "button", "Отправить в Pi"),
    diagnosticsButton: document.register("diagnostics-button", "button", "Диагностика"),
    diagnosticsOutput: document.register("diagnostics-output", "pre", "Диагностика ещё не запускалась."),
    targetContainer: document.register("target-container", "div", "Цели появятся здесь."),
  };

  refs.sendButton.disabled = true;
  refs.sendButton.setAttribute("aria-disabled", "true");

  return { document, refs };
}

function createChromeMock(options: PopupSetupOptions) {
  const sentMessages: Array<{ type: string; targetId?: string }> = [];
  const storageSetCalls: Array<Record<string, unknown>> = [];
  const storedValues = new Map<string, unknown>();
  const startDomPickerResponses = [...(options.startDomPickerResponses ?? [])];

  if (options.storedSelectedTargetId) {
    storedValues.set("selectedTargetId", options.storedSelectedTargetId);
  }

  const chromeMock = {
    runtime: {
      sendMessage: vi.fn(async (message: { type: string; targetId?: string }) => {
        sentMessages.push(message);

        if (options.runtimeSendMessage) {
          return await options.runtimeSendMessage(message);
        }

        switch (message.type) {
          case "listTargets":
            return options.listTargetsResponse ?? { ok: true, targets: [] };
          case "getDiagnostics":
            return { ok: true, diagnostics: options.diagnostics ?? [] };
          case "startDomPicker":
            return startDomPickerResponses.shift() ?? { ok: true };
          default:
            throw new Error(`Unexpected message type: ${message.type}`);
        }
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (options.storageGetNeverResolves) {
            return await new Promise<never>(() => {
              // Intentionally unresolved to simulate hung storage.
            });
          }

          if (options.storageGetError) {
            throw options.storageGetError;
          }

          return { [key]: storedValues.get(key) };
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storageSetCalls.push(values);

          if (options.storageSetNeverResolves) {
            return await new Promise<never>(() => {
              // Intentionally unresolved to simulate hung storage.
            });
          }

          if (options.storageSetError) {
            throw options.storageSetError;
          }

          for (const [key, value] of Object.entries(values)) {
            storedValues.set(key, value);
          }
        }),
        remove: vi.fn(async (key: string) => {
          storedValues.delete(key);
        }),
      },
    },
  };

  return { chromeMock, sentMessages, storageSetCalls, storedValues };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function findTargetOption(targetContainer: FakeElement, targetId: string): FakeElement | undefined {
  return targetContainer.children.find((child) => child.dataset.targetId === targetId);
}

async function setupPopup(options: PopupSetupOptions = {}) {
  vi.resetModules();

  const { document, refs } = createPopupDom();
  const { chromeMock, sentMessages, storageSetCalls, storedValues } = createChromeMock(options);
  const closeWindow = vi.fn(options.windowClose ?? (() => undefined));

  (globalThis as Record<string, unknown>).document = document as unknown;
  (globalThis as Record<string, unknown>).chrome = chromeMock as unknown;
  (globalThis as Record<string, unknown>).window = {
    close: closeWindow,
  } as unknown;

  const popupModule = await import("./popup");
  await flushAsyncWork();

  return {
    popupModule,
    refs,
    sentMessages,
    storageSetCalls,
    storedValues,
    closeWindow,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).chrome;
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe("popup formatting", () => {
  it("uses alias as primary label", () => {
    expect(
      formatTargetPrimaryLabel({
        alias: "frontend",
        cwd: "/repo",
        pid: 1,
        connectedAt: 1,
        lastSeenAt: 1,
        targetId: "t",
      }),
    ).toBe("frontend");
  });

  it("falls back to cwd basename and branch", () => {
    expect(
      formatTargetPrimaryLabel({
        cwd: "/work/repo",
        gitBranch: "main",
        pid: 1,
        connectedAt: 1,
        lastSeenAt: 1,
        targetId: "t",
      }),
    ).toBe("repo · main");
  });

  it("formats secondary target details", () => {
    expect(
      formatTargetSecondaryLabel({
        cwd: "/work/repo",
        gitBranch: "main",
        sessionName: "api",
        pid: 42,
        connectedAt: 1,
        lastSeenAt: 1,
        targetId: "t",
      }),
    ).toContain("pid 42");
  });

  it("formats connection status for connected, empty, and unavailable broker states", () => {
    expect(
      formatConnectionStatus({
        ok: true,
        targets: [
          {
            targetId: "target-1",
            cwd: "/tmp/pi",
            pid: 123,
            connectedAt: 1,
            lastSeenAt: 2,
          },
        ],
      }),
    ).toBe("Pi подключён · целей: 1");
    expect(formatConnectionStatus({ ok: true, targets: [] })).toBe("Pi подключён · нет активных целей");
    expect(formatConnectionStatus({ ok: false, error: "offline" })).toBe("Pi недоступен");
    expect(formatConnectionStatus({})).toBe("Pi недоступен");
  });

  it("formats the last error summary", () => {
    expect(formatLastErrorSummary([])).toBe("Последняя ошибка: нет");
    expect(
      formatLastErrorSummary([
        {
          timestamp: 1_710_000_000_000,
          phase: "sendSelection",
          message: "Delivery failed",
        },
      ]),
    ).toBe("Последняя ошибка: sendSelection — Delivery failed");
  });

  it("includes the current send readiness in the summary", () => {
    expect(
      formatSummary(
        {
          ok: true,
          targets: [],
          selectedTargetId: "target-1",
          tokenConfigured: true,
        },
        [],
      ),
    ).toBe([
      "Доступно целей: 0",
      "Выбранная цель: target-1",
      "brokerToken настроен: да",
      "Отправка доступна: нет",
      "Последняя ошибка: нет",
    ].join("\n"));
  });

  it("formats diagnostics in reverse chronological order", () => {
    expect(formatDiagnostics([])).toBe("Недавних диагностических сообщений нет.");
    expect(
      formatDiagnostics([
        {
          timestamp: Date.UTC(2024, 0, 1, 10, 0, 0),
          phase: "listTargets",
          message: "Broker unavailable",
        },
        {
          timestamp: Date.UTC(2024, 0, 1, 11, 0, 0),
          phase: "sendSelection",
          message: "Timed out",
        },
      ]),
    ).toBe(
      "2024-01-01T11:00:00.000Z [sendSelection] Timed out\n2024-01-01T10:00:00.000Z [listTargets] Broker unavailable",
    );
  });
});

describe("popup interactions", () => {
  it("does not auto-select the first active target when saved and background selections are invalid", async () => {
    const targetOne = createTarget({ targetId: "target-1", alias: "Alpha" });
    const targetTwo = createTarget({ targetId: "target-2", alias: "Beta", cwd: "/tmp/pi-beta" });

    const { refs } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [targetOne, targetTwo],
        selectedTargetId: "missing-target",
      },
      storedSelectedTargetId: "stale-target",
    });

    expect(findTargetOption(refs.targetContainer, targetOne.targetId)?.getAttribute("aria-selected")).toBe("false");
    expect(findTargetOption(refs.targetContainer, targetTwo.targetId)?.getAttribute("aria-selected")).toBe("false");
    expect(refs.sendButton.disabled).toBe(true);
    expect(refs.sendButton.title).toBe("Выберите цель Pi, чтобы включить кнопку «Отправить в Pi»");
    expect(refs.statusText.textContent).toBe("Pi подключён · целей: 2 · Выберите цель Pi, затем нажмите «Отправить в Pi».");
  });

  it("renders targets returned from background", async () => {
    const targetOne = createTarget({ targetId: "target-1", alias: "Alpha" });
    const targetTwo = createTarget({ targetId: "target-2", alias: "Beta", cwd: "/tmp/pi-beta" });

    const { refs } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [targetOne, targetTwo],
        selectedTargetId: targetOne.targetId,
      },
    });

    expect(refs.targetContainer.children).toHaveLength(2);
    expect(refs.targetContainer.children[0]?.textContent).toContain("Alpha");
    expect(refs.targetContainer.children[1]?.textContent).toContain("Beta");
    expect(refs.statusText.textContent).toBe("Pi подключён · целей: 2");
  });

  it("keeps popup usable when storage read fails during refresh", async () => {
    const targetOne = createTarget({ targetId: "target-1", alias: "Alpha" });
    const targetTwo = createTarget({ targetId: "target-2", alias: "Beta", cwd: "/tmp/pi-beta" });

    const { refs } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [targetOne, targetTwo],
        selectedTargetId: targetOne.targetId,
      },
      storageGetError: new Error("storage read failed"),
    });

    expect(refs.targetContainer.children).toHaveLength(2);
    expect(refs.targetContainer.children[0]?.textContent).toContain("Alpha");
    expect(refs.targetContainer.children[1]?.textContent).toContain("Beta");
    expect(refs.statusText.textContent).toBe("Pi подключён · целей: 2");
    expect(refs.statusText.textContent).not.toBe("Фоновый скрипт недоступен");
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("ignores stale refresh results that resolve after a newer refresh", async () => {
    const staleListTargets = createDeferred<{
      ok?: boolean;
      error?: string;
      targets?: TargetMetadata[];
      selectedTargetId?: string;
      tokenConfigured?: boolean;
    }>();
    const staleDiagnostics = createDeferred<{ ok?: boolean; diagnostics?: DiagnosticEntry[] }>();
    const freshListTargets = createDeferred<{
      ok?: boolean;
      error?: string;
      targets?: TargetMetadata[];
      selectedTargetId?: string;
      tokenConfigured?: boolean;
    }>();
    const freshDiagnostics = createDeferred<{ ok?: boolean; diagnostics?: DiagnosticEntry[] }>();
    const responses = [
      staleListTargets.promise,
      staleDiagnostics.promise,
      freshListTargets.promise,
      freshDiagnostics.promise,
    ];
    const freshTarget = createTarget({ targetId: "fresh-target", alias: "Fresh" });
    const staleTarget = createTarget({ targetId: "stale-target", alias: "Stale", cwd: "/tmp/pi-stale" });

    const { popupModule, refs } = await setupPopup({
      runtimeSendMessage: (message) => {
        const nextResponse = responses.shift();

        if (!nextResponse) {
          throw new Error(`Unexpected message type: ${message.type}`);
        }

        return nextResponse;
      },
    });

    const secondRefresh = popupModule.refreshPopupState();
    await flushAsyncWork();

    freshListTargets.resolve({
      ok: true,
      targets: [freshTarget],
      selectedTargetId: freshTarget.targetId,
    });
    freshDiagnostics.resolve({
      ok: true,
      diagnostics: [
        {
          timestamp: Date.UTC(2024, 0, 1, 11, 0, 0),
          phase: "listTargets",
          message: "Fresh diagnostics",
        },
      ],
    });

    await secondRefresh;
    await flushAsyncWork();

    staleListTargets.resolve({
      ok: false,
      error: "Stale broker error",
      targets: [staleTarget],
      selectedTargetId: staleTarget.targetId,
    });
    staleDiagnostics.resolve({
      ok: true,
      diagnostics: [
        {
          timestamp: Date.UTC(2024, 0, 1, 10, 0, 0),
          phase: "listTargets",
          message: "Stale diagnostics",
        },
      ],
    });

    await flushAsyncWork();

    expect(refs.statusText.textContent).toBe("Pi подключён · целей: 1");
    expect(refs.sendButton.disabled).toBe(false);
    expect(refs.targetContainer.children).toHaveLength(1);
    expect(refs.targetContainer.children[0]?.textContent).toContain("Fresh");
    expect(refs.targetContainer.children[0]?.textContent).not.toContain("Stale");
    expect(refs.diagnosticsOutput.textContent).toBe(
      "2024-01-01T11:00:00.000Z [listTargets] Fresh diagnostics",
    );
  });

  it("renders background targets without waiting for a hung storage read", async () => {
    const targetOne = createTarget({ targetId: "target-1", alias: "Alpha" });
    const targetTwo = createTarget({ targetId: "target-2", alias: "Beta", cwd: "/tmp/pi-beta" });

    const { refs } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [targetOne, targetTwo],
        selectedTargetId: targetOne.targetId,
      },
      storageGetNeverResolves: true,
    });

    expect(refs.targetContainer.children).toHaveLength(2);
    expect(refs.targetContainer.children[0]?.textContent).toContain("Alpha");
    expect(refs.targetContainer.children[1]?.textContent).toContain("Beta");
    expect(refs.statusText.textContent).toBe("Pi подключён · целей: 2");
    expect(findTargetOption(refs.targetContainer, targetOne.targetId)?.getAttribute("aria-selected")).toBe("true");
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("restores the stored selected target when it is still active", async () => {
    const targetOne = createTarget({ targetId: "target-1", alias: "Alpha" });
    const targetTwo = createTarget({ targetId: "target-2", alias: "Beta", cwd: "/tmp/pi-beta" });

    const { refs } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [targetOne, targetTwo],
        selectedTargetId: targetOne.targetId,
      },
      storedSelectedTargetId: targetTwo.targetId,
    });

    expect(findTargetOption(refs.targetContainer, targetTwo.targetId)?.className).toContain("target-option--selected");
    expect(findTargetOption(refs.targetContainer, targetTwo.targetId)?.getAttribute("aria-selected")).toBe("true");
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("persists a newly clicked target before send is pressed", async () => {
    const targetOne = createTarget({ targetId: "target-1", alias: "Alpha" });
    const targetTwo = createTarget({ targetId: "target-2", alias: "Beta", cwd: "/tmp/pi-beta" });

    const { refs, sentMessages, storageSetCalls, storedValues } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [targetOne, targetTwo],
        selectedTargetId: targetOne.targetId,
      },
      storedSelectedTargetId: targetOne.targetId,
    });

    findTargetOption(refs.targetContainer, targetTwo.targetId)?.click();
    await flushAsyncWork();

    expect(storageSetCalls).toContainEqual({ selectedTargetId: targetTwo.targetId });
    expect(storedValues.get("selectedTargetId")).toBe(targetTwo.targetId);
    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toHaveLength(0);
    expect(findTargetOption(refs.targetContainer, targetTwo.targetId)?.getAttribute("aria-selected")).toBe("true");
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("updates the selected target immediately when storage write hangs", async () => {
    const targetOne = createTarget({ targetId: "target-1", alias: "Alpha" });
    const targetTwo = createTarget({ targetId: "target-2", alias: "Beta", cwd: "/tmp/pi-beta" });

    const { refs, storageSetCalls } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [targetOne, targetTwo],
        selectedTargetId: targetOne.targetId,
      },
      storedSelectedTargetId: targetOne.targetId,
      storageSetNeverResolves: true,
    });

    findTargetOption(refs.targetContainer, targetTwo.targetId)?.click();
    await flushAsyncWork();

    expect(storageSetCalls).toContainEqual({ selectedTargetId: targetTwo.targetId });
    expect(findTargetOption(refs.targetContainer, targetTwo.targetId)?.getAttribute("aria-selected")).toBe("true");
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("disables Send to Pi when there are no targets and enables it when a target is selected", async () => {
    const noTargetsPopup = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [],
      },
    });

    expect(noTargetsPopup.refs.sendButton.disabled).toBe(true);

    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).chrome;

    const selectedTargetPopup = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [createTarget()],
        selectedTargetId: "target-1",
      },
    });

    expect(selectedTargetPopup.refs.sendButton.disabled).toBe(false);
  });

  it("keeps Send to Pi disabled when targets exist but broker token is not configured", async () => {
    const target = createTarget();

    const { refs } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [target],
        selectedTargetId: target.targetId,
        tokenConfigured: false,
      },
    });

    expect(refs.targetContainer.children).toHaveLength(1);
    expect(findTargetOption(refs.targetContainer, target.targetId)?.getAttribute("aria-selected")).toBe("true");
    expect(refs.sendButton.disabled).toBe(true);
    expect(refs.sendButton.title).toBe("Для отправки настройте brokerToken в chrome.storage.local.");
  });

  it("shows an explicit token-required message instead of letting the user proceed", async () => {
    const { refs } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [createTarget()],
        selectedTargetId: "target-1",
        tokenConfigured: false,
      },
    });

    expect(refs.statusText.textContent).toContain("Для отправки настройте brokerToken в chrome.storage.local.");
    expect(refs.diagnosticsOutput.textContent).toContain("Для отправки настройте brokerToken в chrome.storage.local.");
  });

  it("lifts the disabled state when broker token becomes configured and target selection is valid", async () => {
    const target = createTarget();
    const responses = [
      {
        ok: true,
        targets: [target],
        selectedTargetId: target.targetId,
        tokenConfigured: false,
      },
      { ok: true, diagnostics: [] },
      {
        ok: true,
        targets: [target],
        selectedTargetId: target.targetId,
        tokenConfigured: true,
      },
      { ok: true, diagnostics: [] },
    ];

    const { popupModule, refs } = await setupPopup({
      runtimeSendMessage: () => {
        const response = responses.shift();

        if (!response) {
          throw new Error("Unexpected popup refresh request");
        }

        return response;
      },
    });

    expect(refs.sendButton.disabled).toBe(true);

    await popupModule.refreshPopupState();
    await flushAsyncWork();

    expect(refs.sendButton.disabled).toBe(false);
  });

  it("closes the popup after the DOM picker starts successfully", async () => {
    const diagnostics: DiagnosticEntry[] = [
      {
        timestamp: Date.UTC(2024, 0, 1, 10, 0, 0),
        phase: "listTargets",
        message: "Broker reachable",
      },
    ];
    const baseDiagnostics = formatDiagnostics(diagnostics);

    const { refs, sentMessages, closeWindow } = await setupPopup({
      diagnostics,
      listTargetsResponse: {
        ok: true,
        targets: [createTarget()],
        selectedTargetId: "target-1",
      },
      storageSetError: new Error("storage write failed"),
      startDomPickerResponses: [{ ok: true }],
    });

    refs.sendButton.click();
    await flushAsyncWork();

    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toEqual([
      { type: "startDomPicker", targetId: "target-1" },
    ]);
    expect(refs.statusText.textContent).toBe("Выберите элемент на странице, чтобы отправить его в Pi.");
    expect(refs.diagnosticsOutput.textContent).toBe(
      `${baseDiagnostics}\n\nПредупреждение хранилища: не удалось сохранить выбранную цель. storage write failed`,
    );
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("keeps the popup open when starting the DOM picker fails", async () => {
    const { refs, sentMessages, closeWindow } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [createTarget()],
        selectedTargetId: "target-1",
      },
      startDomPickerResponses: [{ ok: false, error: "Picker unavailable" }],
    });

    refs.sendButton.click();
    await flushAsyncWork();

    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toHaveLength(1);
    expect(refs.statusText.textContent).toBe("Не удалось запустить DOM picker");
    expect(refs.diagnosticsOutput.textContent).toContain("Ошибка DOM picker: Picker unavailable");
    expect(closeWindow).not.toHaveBeenCalled();
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("starts the DOM picker immediately when storage write hangs", async () => {
    const diagnostics: DiagnosticEntry[] = [
      {
        timestamp: Date.UTC(2024, 0, 1, 10, 0, 0),
        phase: "listTargets",
        message: "Broker reachable",
      },
    ];
    const baseDiagnostics = formatDiagnostics(diagnostics);

    const { refs, sentMessages, storageSetCalls } = await setupPopup({
      diagnostics,
      listTargetsResponse: {
        ok: true,
        targets: [createTarget()],
        selectedTargetId: "target-1",
      },
      storageSetNeverResolves: true,
      startDomPickerResponses: [{ ok: true }],
    });

    refs.sendButton.click();
    await flushAsyncWork();

    expect(storageSetCalls).toContainEqual({ selectedTargetId: "target-1" });
    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toHaveLength(1);
    expect(refs.statusText.textContent).toBe("Выберите элемент на странице, чтобы отправить его в Pi.");
    expect(refs.diagnosticsOutput.textContent).toBe(baseDiagnostics);
    expect(refs.sendButton.disabled).toBe(false);
  });

  it("starts the DOM picker and keeps diagnostics stable across repeated picker failures", async () => {
    const diagnostics: DiagnosticEntry[] = [
      {
        timestamp: Date.UTC(2024, 0, 1, 10, 0, 0),
        phase: "listTargets",
        message: "Broker reachable",
      },
    ];
    const baseDiagnostics = formatDiagnostics(diagnostics);

    const { refs, sentMessages } = await setupPopup({
      diagnostics,
      listTargetsResponse: {
        ok: true,
        targets: [createTarget()],
        selectedTargetId: "target-1",
      },
      startDomPickerResponses: [
        { ok: true },
        { ok: false, error: "Picker unavailable" },
        { ok: false, error: "Picker unavailable" },
      ],
    });

    refs.sendButton.click();
    await flushAsyncWork();

    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toHaveLength(1);
    expect(refs.statusText.textContent).toBe("Выберите элемент на странице, чтобы отправить его в Pi.");
    expect(refs.diagnosticsOutput.textContent).toBe(baseDiagnostics);

    refs.sendButton.click();
    await flushAsyncWork();

    const pickerFailureDiagnostics = `${baseDiagnostics}\n\nОшибка DOM picker: Picker unavailable`;

    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toHaveLength(2);
    expect(refs.statusText.textContent).toBe("Не удалось запустить DOM picker");
    expect(refs.diagnosticsOutput.textContent).toBe(pickerFailureDiagnostics);

    refs.sendButton.click();
    await flushAsyncWork();

    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toHaveLength(3);
    expect(refs.statusText.textContent).toBe("Не удалось запустить DOM picker");
    expect(refs.diagnosticsOutput.textContent).toBe(pickerFailureDiagnostics);
  });
});

describe("popup html", () => {
  it("shows the primary action label in Russian", () => {
    const popupHtml = readFileSync(new URL("./popup.html", import.meta.url), "utf8");

    expect(popupHtml).toContain('id="send-button"');
    expect(popupHtml).toContain(">Отправить в Pi<");
    expect(popupHtml).not.toContain(">Send<");
  });
});

describe("popup russian ui copy", () => {
  it("renders static popup labels and buttons in Russian", () => {
    const popupHtml = readFileSync(new URL("./popup.html", import.meta.url), "utf8");

    expect(popupHtml).toContain('<html lang="ru">');
    expect(popupHtml).toContain(">Статус<");
    expect(popupHtml).toContain(">Цель Pi<");
    expect(popupHtml).toContain(">Отправить в Pi<");
    expect(popupHtml).toContain(">Диагностика<");
    expect(popupHtml).toContain(">Цели появятся здесь.<");
    expect(popupHtml).toContain(">Диагностика ещё не запускалась.<");
  });

  it("shows main status, help, and diagnostics strings in Russian", async () => {
    const target = createTarget();
    const { refs, popupModule } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [target],
        selectedTargetId: target.targetId,
        tokenConfigured: false,
      },
      diagnostics: [],
    });

    expect(formatConnectionStatus({ ok: true, targets: [target] })).toBe("Pi подключён · целей: 1");
    expect(formatConnectionStatus({ ok: true, targets: [] })).toBe("Pi подключён · нет активных целей");
    expect(formatConnectionStatus({ ok: false })).toBe("Pi недоступен");
    expect(formatLastErrorSummary([])).toBe("Последняя ошибка: нет");
    expect(formatSummary({ ok: true, targets: [target], selectedTargetId: target.targetId, tokenConfigured: false }, [])).toBe([
      "Доступно целей: 1",
      `Выбранная цель: ${target.targetId}`,
      "brokerToken настроен: нет",
      "Отправка доступна: нет",
      "Последняя ошибка: нет",
    ].join("\n"));
    expect(formatDiagnostics([])).toBe("Недавних диагностических сообщений нет.");
    expect(refs.statusText.textContent).toContain("Для отправки настройте brokerToken в chrome.storage.local.");
    expect(refs.diagnosticsOutput.textContent).toContain("Недавних диагностических сообщений нет.");

    refs.diagnosticsButton.click();
    expect(refs.statusText.textContent).toBe("Обновляем диагностику...");
    await flushAsyncWork();

    await popupModule.refreshPopupState();
    await flushAsyncWork();
    refs.sendButton.click();
    await flushAsyncWork();

    expect(refs.statusText.textContent).toBe("Для отправки настройте brokerToken в chrome.storage.local.");
    expect(refs.diagnosticsOutput.textContent).toContain("Для отправки настройте brokerToken в chrome.storage.local.");
  });

  it("shows disabled button titles and picker guidance in Russian", async () => {
    const target = createTarget();
    const { refs, sentMessages } = await setupPopup({
      listTargetsResponse: {
        ok: true,
        targets: [target],
        selectedTargetId: undefined,
        tokenConfigured: true,
      },
      startDomPickerResponses: [{ ok: false, error: "Picker unavailable" }],
    });

    expect(refs.sendButton.title).toBe("Выберите цель Pi, чтобы включить кнопку «Отправить в Pi»");

    findTargetOption(refs.targetContainer, target.targetId)?.click();
    await flushAsyncWork();

    expect(refs.sendButton.title).toBe("Запустить DOM picker на активной вкладке");

    refs.sendButton.click();
    await flushAsyncWork();

    expect(sentMessages.filter((message) => message.type === "startDomPicker")).toHaveLength(1);
    expect(refs.statusText.textContent).toBe("Не удалось запустить DOM picker");
    expect(refs.diagnosticsOutput.textContent).toContain("Ошибка DOM picker: Picker unavailable");
  });
});
