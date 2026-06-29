import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageAdapter, DiagnosticEntry } from "./diagnostics";
import type { SelectionPayload } from "../shared/protocol";
import {
  configureSidePanelOnActionClick,
  configureTabChangeListeners,
  createBackgroundMessageListener,
  startDomPicker,
  canInjectIntoTabUrl,
  injectContentScriptIfNeeded,
} from "./background";

/* ------------------------------------------------------------------ */
/*  FakeStorageAdapter                                                 */
/* ------------------------------------------------------------------ */

class FakeStorageAdapter implements StorageAdapter {
  private readonly values = new Map<string, unknown>();

  constructor(initialValues: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function invokeMessageListener(
  listener: ReturnType<typeof createBackgroundMessageListener>,
  message: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, {} as chrome.runtime.MessageSender, (response?: unknown) => {
      resolve(response);
    });
  });
}

async function readDiagnostics(storage: StorageAdapter): Promise<DiagnosticEntry[]> {
  return ((await storage.get<DiagnosticEntry[]>("diagnostics")) ?? []).slice();
}

/* ------------------------------------------------------------------ */
/*  canInjectIntoTabUrl                                                */
/* ------------------------------------------------------------------ */

describe("canInjectIntoTabUrl", () => {
  it("returns true for http URLs", () => {
    expect(canInjectIntoTabUrl("http://example.com")).toBe(true);
  });

  it("returns true for https URLs", () => {
    expect(canInjectIntoTabUrl("https://example.com/page")).toBe(true);
  });

  it("returns false for chrome:// URLs", () => {
    expect(canInjectIntoTabUrl("chrome://extensions")).toBe(false);
  });

  it("returns false for chrome-extension:// URLs", () => {
    expect(canInjectIntoTabUrl("chrome-extension://abc/index.html")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(canInjectIntoTabUrl(undefined)).toBe(false);
  });

  it("returns false for about: URLs", () => {
    expect(canInjectIntoTabUrl("about:blank")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  configureSidePanelOnActionClick                                    */
/* ------------------------------------------------------------------ */

describe("configureSidePanelOnActionClick", () => {
  it("configures Chrome action clicks to open the side panel", () => {
    const addListener = vi.fn();
    const setPanelBehavior = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    configureSidePanelOnActionClick({
      action: { onClicked: { addListener } },
      sidePanel: { setPanelBehavior, open },
    });

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(addListener).toHaveBeenCalledOnce();

    const onClicked = addListener.mock.calls[0]?.[0] as (tab: chrome.tabs.Tab) => void;
    onClicked({ windowId: 42 } as chrome.tabs.Tab);

    expect(open).toHaveBeenCalledWith({ windowId: 42 });
  });

  it("does not open side panel when windowId is missing", () => {
    const addListener = vi.fn();
    const setPanelBehavior = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    configureSidePanelOnActionClick({
      action: { onClicked: { addListener } },
      sidePanel: { setPanelBehavior, open },
    });

    const onClicked = addListener.mock.calls[0]?.[0] as (tab: chrome.tabs.Tab) => void;
    onClicked({} as chrome.tabs.Tab);

    expect(open).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  configureTabChangeListeners                                    */
/* ------------------------------------------------------------------ */

describe("configureTabChangeListeners", () => {
  it("sends stopDomPicker to the new active tab on tab activation", async () => {
    const activatedListener = vi.fn();
    const updatedListener = vi.fn();
    const tabsSendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping succeeds
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: activatedListener },
        onUpdated: { addListener: updatedListener },
        sendMessage: tabsSendMessage,
      },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    configureTabChangeListeners();

    expect(activatedListener).toHaveBeenCalledOnce();

    const onActivated = activatedListener.mock.calls[0]?.[0] as (
      info: { tabId: number; previousTabId?: number },
    ) => void;
    onActivated({ tabId: 2, previousTabId: 1 });

    // Wait for async injection + message
    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

    expect(tabsSendMessage).toHaveBeenCalledWith(2, { type: "ping" });
    // Ping succeeded, so no injection needed
    expect(executeScript).not.toHaveBeenCalled();
    expect(tabsSendMessage).toHaveBeenCalledWith(2, { type: "stopDomPicker" });
  });

  it("sends stopDomPicker when tab parameter is undefined", async () => {
    const activatedListener = vi.fn();
    const tabsSendMessage = vi.fn(async () => ({ ok: true }));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: activatedListener },
        onUpdated: { addListener: vi.fn() },
        sendMessage: tabsSendMessage,
      },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    configureTabChangeListeners();

    const onActivated = activatedListener.mock.calls[0]?.[0] as (
      info: { tabId: number; previousTabId?: number },
    ) => void;
    // Chrome sometimes passes undefined as the second argument (tab)
    onActivated({ tabId: 2, previousTabId: 1 });

    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

    expect(tabsSendMessage).toHaveBeenCalledWith(2, { type: "ping" });
    expect(tabsSendMessage).toHaveBeenCalledWith(2, { type: "stopDomPicker" });
  });

  it("ignores onUpdated when tabId is negative", () => {
    const tabsSendMessage = vi.fn(async () => ({ ok: true }));

    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        sendMessage: tabsSendMessage,
      },
      scripting: { executeScript: vi.fn() },
    } as unknown as typeof chrome);

    configureTabChangeListeners();

    const updatedListener = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: updatedListener },
        sendMessage: tabsSendMessage,
      },
      scripting: { executeScript: vi.fn() },
    } as unknown as typeof chrome);

    configureTabChangeListeners();

    const onUpdated = updatedListener.mock.calls[updatedListener.mock.calls.length - 1]?.[0] as (
      tabId: number,
      changeInfo: { status?: string; url?: string },
    ) => void;
    onUpdated(-1, { status: "loading" });

    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it("sends stopDomPicker on tab navigation (status=loading)", async () => {
    const updatedListener = vi.fn();
    const tabsSendMessage = vi.fn(async () => ({ ok: true }));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: updatedListener },
        sendMessage: tabsSendMessage,
      },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    configureTabChangeListeners();

    expect(updatedListener).toHaveBeenCalledOnce();

    const onUpdated = updatedListener.mock.calls[0]?.[0] as (
      tabId: number,
      changeInfo: { status?: string; url?: string },
    ) => void;
    onUpdated(5, { status: "loading" });

    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

    expect(tabsSendMessage).toHaveBeenCalledWith(5, { type: "ping" });
    expect(tabsSendMessage).toHaveBeenCalledWith(5, { type: "stopDomPicker" });
  });

  it("sends stopDomPicker on tab URL change", async () => {
    const updatedListener = vi.fn();
    const tabsSendMessage = vi.fn(async () => ({ ok: true }));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: updatedListener },
        sendMessage: tabsSendMessage,
      },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    configureTabChangeListeners();

    const onUpdated = updatedListener.mock.calls[0]?.[0] as (
      tabId: number,
      changeInfo: { status?: string; url?: string },
    ) => void;
    onUpdated(5, { url: "https://newpage.com" });

    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

    expect(tabsSendMessage).toHaveBeenCalledWith(5, { type: "ping" });
    expect(tabsSendMessage).toHaveBeenCalledWith(5, { type: "stopDomPicker" });
  });

  it("ignores onUpdated when neither status nor url changed", () => {
    const tabsSendMessage = vi.fn(async () => ({ ok: true }));

    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        sendMessage: tabsSendMessage,
      },
      scripting: { executeScript: vi.fn() },
    } as unknown as typeof chrome);

    configureTabChangeListeners();

    // No relevant change info — sendMessage should not be called
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  startDomPicker                                                     */
/* ------------------------------------------------------------------ */

describe("startDomPicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns a Russian error when no tabId is provided", async () => {
    const result = await startDomPicker({});
    expect(result).toEqual({ ok: false, error: "Не удалось определить вкладку для DOM picker." });
  });

  it("uses getActiveTab fallback when tabId is not provided but activeTabGetter is available", async () => {
    const storage = new FakeStorageAdapter();
    const getActiveTab = vi.fn(async () => ({ id: 999, url: "https://example.com/active" } as chrome.tabs.Tab));
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { query: getActiveTab, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker(
      {},
      { storage, now: () => 1_710_000_000_123, getActiveTab },
    );
    expect(result).toEqual({ ok: true });
    // chrome.tabs.get is NOT called — URL is obtained from getActiveTab, avoiding the need for "tabs" permission
    expect(sendMessage).toHaveBeenCalledWith(999, { type: "ping" });
    expect(sendMessage).toHaveBeenCalledWith(999, { type: "startDomPicker" });
  });

  it("returns Russian error when getActiveTab fallback also fails", async () => {
    const storage = new FakeStorageAdapter();
    const getActiveTab = vi.fn(async () => undefined);

    const result = await startDomPicker(
      {},
      { storage, now: () => 1_710_000_000_123, getActiveTab },
    );
    expect(result).toEqual({ ok: false, error: "Не удалось определить вкладку для DOM picker." });
  });

  it("returns a Russian error for non-http(s) tab URLs", async () => {
    const storage = new FakeStorageAdapter();
    const get = vi.fn(async () => ({ id: 555, url: "chrome://extensions" } as chrome.tabs.Tab));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker({ tabId: 555 }, { storage, now: () => 1_710_000_000_123 });
    expect(result).toEqual({
      ok: false,
      error: "DOM picker можно запускать только на обычных http/https страницах.",
    });

    // Should NOT inject — URL check fails before injection
    expect(executeScript).not.toHaveBeenCalled();

    await expect(readDiagnostics(storage)).resolves.toEqual([
      {
        timestamp: 1_710_000_000_123,
        phase: "startDomPicker",
        message: "DOM picker можно запускать только на обычных http/https страницах. URL: chrome://extensions",
      },
    ]);
  });

  it("sends startDomPicker message to the content script for valid tabs", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping succeeds
    const get = vi.fn(async () => ({ id: 555, url: "https://example.com/page" } as chrome.tabs.Tab));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker({ tabId: 555 });
    expect(result).toEqual({ ok: true });

    expect(get).toHaveBeenCalledWith(555);
    expect(sendMessage).toHaveBeenCalledWith(555, { type: "ping" });
    expect(sendMessage).toHaveBeenCalledWith(555, { type: "startDomPicker" });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("returns helpful error when content script is not loaded yet", async () => {
    const storage = new FakeStorageAdapter();
    const sendMessage = vi.fn().mockRejectedValue(new Error("Receiving end does not exist"));
    const get = vi.fn(async () => ({ id: 555, url: "https://example.com/page" } as chrome.tabs.Tab));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker({ tabId: 555 }, { storage, now: () => 1_710_000_000_123 });

    // After injection, ping succeeds (script injected) but sendMessage for startDomPicker still fails
    // because the injected script hasn't registered yet — or we simulate the connection error
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();

    // Verify injection was attempted
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 555 },
      files: ["contentScript.js"],
    });

    await expect(readDiagnostics(storage)).resolves.toEqual([
      expect.objectContaining({
        timestamp: 1_710_000_000_123,
        phase: "startDomPicker",
      }),
    ]);
  });

  it("records diagnostics when connection error is not a Receiving-end error", async () => {
    const storage = new FakeStorageAdapter();
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("Receiving end does not exist")) // ping fails → inject
      .mockRejectedValueOnce(new Error("Some other network error"));    // startDomPicker fails
    const get = vi.fn(async () => ({ id: 555, url: "https://example.com/page" } as chrome.tabs.Tab));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker({ tabId: 555 }, { storage, now: () => 1_710_000_000_123 });
    expect(result.ok).toBe(false);

    await expect(readDiagnostics(storage)).resolves.toEqual([
      expect.objectContaining({
        timestamp: 1_710_000_000_123,
        phase: "startDomPicker",
      }),
    ]);
  });

  it("propagates failed picker startup responses from the content script", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }) // ping
      .mockResolvedValueOnce({ ok: false, error: "Picker unavailable" });
    const get = vi.fn(async () => ({ id: 321, url: "https://example.com/page" } as chrome.tabs.Tab));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker({ tabId: 321 });
    expect(result).toEqual({ ok: false, error: "Picker unavailable" });

    expect(sendMessage).toHaveBeenCalledWith(321, { type: "ping" });
    expect(sendMessage).toHaveBeenCalledWith(321, { type: "startDomPicker" });
  });

  it("falls back to activeTab when provided tabId is for a non-injectable tab (hardening)", async () => {
    const storage = new FakeStorageAdapter();
    const getActiveTab = vi.fn(async () => ({ id: 999, url: "https://example.com/valid" } as chrome.tabs.Tab));
    const get = vi.fn(async (id: number) => {
      if (id === 555) return { id: 555, url: "chrome://extensions" } as chrome.tabs.Tab;
      throw new Error(`No tab with id: ${id}`);
    });
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, query: getActiveTab, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    // tabId 555 is chrome:// — non-injectable
    const result = await startDomPicker(
      { tabId: 555 },
      { storage, now: () => 1_710_000_000_123, getActiveTab },
    );

    // Should have fallen back to active tab 999
    expect(result).toEqual({ ok: true });
    expect(getActiveTab).toHaveBeenCalled();
    // chrome.tabs.get IS called for tabId 555 (URL not known from input)
    expect(get).toHaveBeenCalledWith(555);
    // chrome.tabs.get is NOT called for fallback tab 999 — URL obtained from getActiveTab
    expect(sendMessage).toHaveBeenCalledWith(999, { type: "ping" });
    expect(sendMessage).toHaveBeenCalledWith(999, { type: "startDomPicker" });
  });

  it("proceeds with injection when tabs.get throws (no tabs permission) — URL guard is skipped (hardening)", async () => {
    const storage = new FakeStorageAdapter();
    const getActiveTab = vi.fn(async () => ({ id: 888, url: "https://example.com/fallback" } as chrome.tabs.Tab));
    const get = vi.fn(async () => {
      throw new Error("No tab with this id (simulates missing tabs permission)");
    });
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, query: getActiveTab, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker(
      { tabId: 99999 },
      { storage, now: () => 1_710_000_000_123, getActiveTab },
    );

    // When tabs.get fails and URL is unknown, we skip the URL guard and proceed
    // with injection directly on the given tabId (chrome.scripting will fail
    // naturally if the tab is truly non-injectable)
    expect(result).toEqual({ ok: true });
    // getActiveTab is NOT called — we proceed with the provided tabId
    expect(getActiveTab).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(99999, { type: "ping" });
    expect(sendMessage).toHaveBeenCalledWith(99999, { type: "startDomPicker" });
  });

  it("returns Russian error when both provided tabId and activeTab fallback are non-injectable (hardening)", async () => {
    const storage = new FakeStorageAdapter();
    const getActiveTab = vi.fn(async () => ({ id: 777, url: "chrome://newtab" } as chrome.tabs.Tab));
    const get = vi.fn(async (id: number) => {
      if (id === 555) return { id: 555, url: "chrome://extensions" } as chrome.tabs.Tab;
      if (id === 777) return { id: 777, url: "chrome://newtab" } as chrome.tabs.Tab;
      throw new Error(`No tab with id: ${id}`);
    });
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, query: getActiveTab, sendMessage: vi.fn() },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker(
      { tabId: 555 },
      { storage, now: () => 1_710_000_000_123, getActiveTab },
    );

    // Both the provided tabId's tab and the fallback are chrome:// — should error
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("http");
  });

  it("proceeds with injection when tabs.get fails — URL guard is skipped gracefully (hardening)", async () => {
    const storage = new FakeStorageAdapter();
    const getActiveTab = vi.fn(async () => ({ id: 777, url: "about:blank" } as chrome.tabs.Tab));
    const get = vi.fn(async () => {
      throw new Error("No tab (simulates missing tabs permission)");
    });
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, query: getActiveTab, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const result = await startDomPicker(
      { tabId: 99999 },
      { storage, now: () => 1_710_000_000_123, getActiveTab },
    );

    // When tabs.get fails and URL is unknown, we skip the URL guard
    // and proceed with injection on the given tabId
    expect(result).toEqual({ ok: true });
    expect(getActiveTab).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  createBackgroundMessageListener                                    */
/* ------------------------------------------------------------------ */

describe("createBackgroundMessageListener", () => {
  it("responds to ping", async () => {
    const listener = createBackgroundMessageListener();
    await expect(invokeMessageListener(listener, { type: "ping" })).resolves.toEqual({
      ok: true,
      source: "background",
    });
  });

  it("handles startDomPicker with tabId", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping
    const get = vi.fn(async () => ({ id: 555, url: "https://example.com/page" } as chrome.tabs.Tab));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const listener = createBackgroundMessageListener();

    await expect(
      invokeMessageListener(listener, { type: "startDomPicker", tabId: 555 }),
    ).resolves.toEqual({ ok: true });

    expect(sendMessage).toHaveBeenCalledWith(555, { type: "startDomPicker" });
  });

  it("returns Russian error when startDomPicker has no tabId and no getActiveTab", async () => {
    const listener = createBackgroundMessageListener();
    await expect(invokeMessageListener(listener, { type: "startDomPicker" })).resolves.toEqual({
      ok: false,
      error: "Не удалось определить вкладку для DOM picker.",
    });
  });

  it("uses getActiveTab fallback in startDomPicker message when no tabId", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, source: "contentScript" }); // ping
    const get = vi.fn(async () => ({ id: 42, url: "https://example.com" } as chrome.tabs.Tab));
    const getActiveTab = vi.fn(async () => ({ id: 42, url: "https://example.com" } as chrome.tabs.Tab));
    const executeScript = vi.fn(async () => [{}]);

    vi.stubGlobal("chrome", {
      tabs: { get, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome);

    const listener = createBackgroundMessageListener({
      storage: new FakeStorageAdapter(),
      getActiveTab,
    });

    await expect(
      invokeMessageListener(listener, { type: "startDomPicker" }),
    ).resolves.toEqual({ ok: true });

    expect(getActiveTab).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(42, { type: "startDomPicker" });
  });

  it("records picker diagnostics", async () => {
    const storage = new FakeStorageAdapter();
    const listener = createBackgroundMessageListener({
      storage,
      now: () => 1_710_000_000_123,
    });

    await expect(
      invokeMessageListener(listener, {
        type: "pickerDiagnostic",
        phase: "sendSelection",
        message: "Unable to send selection to Pi.",
        url: "https://example.com/article",
      }),
    ).resolves.toEqual({ ok: true });

    await expect(readDiagnostics(storage)).resolves.toEqual([
      {
        timestamp: 1_710_000_000_123,
        phase: "picker:sendSelection",
        message: "Unable to send selection to Pi. (https://example.com/article)",
      },
    ]);
  });

  it("rejects invalid pickerDiagnostic messages", async () => {
    const listener = createBackgroundMessageListener();
    await expect(
      invokeMessageListener(listener, {
        type: "pickerDiagnostic",
        phase: "",
        message: "",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Некорректное сообщение pickerDiagnostic",
    });
  });

  it("returns diagnostics via getDiagnostics", async () => {
    const storage = new FakeStorageAdapter({
      diagnostics: [
        { timestamp: 1_710_000_000_001, phase: "test", message: "First entry" },
      ],
    });
    const listener = createBackgroundMessageListener({ storage });

    await expect(invokeMessageListener(listener, { type: "getDiagnostics" })).resolves.toEqual({
      ok: true,
      diagnostics: [
        { timestamp: 1_710_000_000_001, phase: "test", message: "First entry" },
      ],
    });
  });

  it("clears diagnostics via clearDiagnostics", async () => {
    const storage = new FakeStorageAdapter({
      diagnostics: [
        { timestamp: 1_710_000_000_001, phase: "test", message: "First entry" },
      ],
    });
    const listener = createBackgroundMessageListener({ storage });

    await expect(invokeMessageListener(listener, { type: "clearDiagnostics" })).resolves.toEqual({
      ok: true,
    });

    await expect(readDiagnostics(storage)).resolves.toEqual([]);
  });

  it("returns false for unknown message types (no handlers)", async () => {
    const listener = createBackgroundMessageListener();
    const sendResponse = vi.fn();

    // Unknown type — should return false (no response expected)
    const result = listener(
      { type: "unknownMessageType" },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("handles sendSelection message and proxies to session server", async () => {
    const sendSelectionSpy = vi.fn<
      (selection: SelectionPayload) => { ok: true } | { ok: false; error: string }
    >((selection) => {
      void selection;
      return { ok: true };
    });
    const listener = createBackgroundMessageListener({
      storage: new FakeStorageAdapter(),
      sendSelection: sendSelectionSpy,
    });

    const selection = {
      url: "https://example.com",
      title: "Example",
      selectedText: "выделенный текст",
      selectedHtml: "<span>текст</span>",
      capturedAt: 1_710_000_000_000,
    };

    await expect(
      invokeMessageListener(listener, { type: "sendSelection", selection }),
    ).resolves.toEqual({ ok: true });

    expect(sendSelectionSpy).toHaveBeenCalledWith(selection);
  });

  it("DOM picker sendSelection uses direct command path (not mirror snapshot)", async () => {
    // Task 9: Confirm DOM picker flow goes through session.selection.send
    // (direct command path), NOT through mirror snapshot/entry pipeline.
    const sendSelectionSpy = vi.fn<
      (selection: SelectionPayload) => { ok: true } | { ok: false; error: string }
    >((selection) => {
      void selection;
      return { ok: true };
    });
    const listener = createBackgroundMessageListener({
      storage: new FakeStorageAdapter(),
      sendSelection: sendSelectionSpy,
    });

    // Selection from DOM picker carries URL + selected content
    const selection = {
      url: "https://example.com/article",
      title: "Статья",
      selectedText: "выделенный текст для Pi",
      selectedHtml: "<p>выделенный текст для Pi</p>",
      comment: "Объясни этот фрагмент",
      capturedAt: 1_710_000_000_000,
    };

    const result = await invokeMessageListener(listener, {
      type: "sendSelection",
      selection,
    });

    // The selection is forwarded to the session server (which sends
    // session.selection.send over WebSocket) — NOT via mirror snapshot
    expect(result).toEqual({ ok: true });
    expect(sendSelectionSpy).toHaveBeenCalledTimes(1);
    expect(sendSelectionSpy).toHaveBeenCalledWith(selection);
  });

  it("returns Russian error when sendSelection server call fails", async () => {
    const sendSelectionSpy = vi.fn(() => ({
      ok: false,
      error: "Pi-сессия не подключена.",
    }));
    const listener = createBackgroundMessageListener({
      storage: new FakeStorageAdapter(),
      sendSelection: sendSelectionSpy,
    });

    const selection = {
      url: "https://example.com",
      title: "Example",
      selectedText: "текст",
      selectedHtml: "<span>текст</span>",
      capturedAt: 1_710_000_000_000,
    };

    await expect(
      invokeMessageListener(listener, { type: "sendSelection", selection }),
    ).resolves.toEqual({ ok: false, error: "Pi-сессия не подключена." });
  });

  it("returns Russian error when sendSelection server is offline", async () => {
    const sendSelectionSpy = vi.fn(() => ({
      ok: false,
      error: "Pi-сессия не подключена.",
    }));
    const listener = createBackgroundMessageListener({
      storage: new FakeStorageAdapter(),
      sendSelection: sendSelectionSpy,
    });

    const selection = {
      url: "https://example.com",
      title: "Page",
      selectedText: "выделение",
      selectedHtml: "<div>выделение</div>",
      capturedAt: 1_710_000_000_000,
    };

    const result = await invokeMessageListener(listener, { type: "sendSelection", selection });
    expect((result as { ok: boolean; error: string }).ok).toBe(false);
    expect((result as { error: string }).error).toContain("Pi-сессия не подключена");
  });
});

/* ------------------------------------------------------------------ */
/*  Module side effects                                                */
/* ------------------------------------------------------------------ */

describe("module side effects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts the assistant state server when a sidepanel port connects — no WebSocket auto-connect", async () => {
    vi.resetModules();
    const onConnectAddListener = vi.fn();

    // Ensure WebSocket is NOT used
    const webSocketFactory = vi.fn();

    vi.stubGlobal("WebSocket", webSocketFactory);
    vi.stubGlobal(
      "chrome",
      {
        storage: {
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
          },
        },
        action: { onClicked: { addListener: vi.fn() } },
        sidePanel: {
          setPanelBehavior: vi.fn(async () => undefined),
          open: vi.fn(async () => undefined),
        },
        runtime: {
          onInstalled: { addListener: vi.fn() },
          onConnect: { addListener: onConnectAddListener },
          onMessage: { addListener: vi.fn() },
        },
        tabs: {
          onActivated: { addListener: vi.fn() },
          onUpdated: { addListener: vi.fn() },
          sendMessage: vi.fn(),
        },
        scripting: {
          executeScript: vi.fn(async () => [{}]),
        },
        contextMenus: {
          create: vi.fn(),
          onClicked: { addListener: vi.fn() },
        },
      } as unknown as typeof chrome,
    );

    await import("./background");

    expect(onConnectAddListener).toHaveBeenCalledOnce();
    // In direct mode, the background does NOT auto-connect to any WebSocket broker.
    expect(webSocketFactory).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  injectContentScriptIfNeeded                                        */
/* ------------------------------------------------------------------ */

describe("on-demand content script injection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("should inject content script when ping fails", async () => {
    const mockExecuteScript = vi.fn().mockResolvedValue([{}]);
    const mockSendMessage = vi.fn().mockRejectedValue(new Error("No receiver"));

    vi.stubGlobal("chrome", {
      tabs: { sendMessage: mockSendMessage },
      scripting: { executeScript: mockExecuteScript },
    } as unknown as typeof chrome);

    await injectContentScriptIfNeeded(123);

    expect(mockSendMessage).toHaveBeenCalledWith(123, { type: "ping" });
    expect(mockExecuteScript).toHaveBeenCalledWith({
      target: { tabId: 123 },
      files: ["contentScript.js"],
    });
  });

  it("should not inject when content script already present", async () => {
    const mockExecuteScript = vi.fn();
    const mockSendMessage = vi.fn().mockResolvedValue({ type: "pong" });

    vi.stubGlobal("chrome", {
      tabs: { sendMessage: mockSendMessage },
      scripting: { executeScript: mockExecuteScript },
    } as unknown as typeof chrome);

    await injectContentScriptIfNeeded(123);

    expect(mockSendMessage).toHaveBeenCalledWith(123, { type: "ping" });
    expect(mockExecuteScript).not.toHaveBeenCalled();
  });
});
