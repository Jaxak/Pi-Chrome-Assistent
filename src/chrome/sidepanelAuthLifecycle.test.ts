// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const brokerMock = vi.hoisted(() => {
  const instances: Array<{
    options: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    setSelectedTargetId: ReturnType<typeof vi.fn>;
    sendChatMessage: ReturnType<typeof vi.fn>;
  }> = [];

  return { instances };
});

vi.mock("./sidepanelBrokerClient", () => ({
  SidePanelBrokerClient: class MockSidePanelBrokerClient {
    readonly connect = vi.fn();
    readonly close = vi.fn();
    readonly setSelectedTargetId = vi.fn();
    readonly sendChatMessage = vi.fn(() => true);

    constructor(readonly options: Record<string, unknown>) {
      brokerMock.instances.push(this);
    }
  },
}));

function loadSidePanelHtml(): void {
  const html = readFileSync(resolve(process.cwd(), "src/chrome/sidepanel.html"), "utf8");
  document.documentElement.innerHTML = html;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type AuthResponse = {
  ok?: boolean;
  browserToken?: string;
  tokenConfigured?: boolean;
};

type TargetMetadataLike = {
  targetId: string;
  alias?: string;
  cwd: string;
  gitBranch?: string;
  pid: number;
  sessionName?: string;
  connectedAt: number;
  lastSeenAt: number;
};

function createTarget(overrides: Partial<TargetMetadataLike> = {}): TargetMetadataLike {
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

function mockChrome(authResponses: AuthResponse[]): void {
  let mutationResponseIndex = 1;
  const runtimeSendMessage = vi.fn(async (message: { type: string }) => {
    if (message.type === "getBrowserAuthState") {
      return authResponses[0] ?? { ok: true, browserToken: "token-1", tokenConfigured: true };
    }

    if (message.type === "clearBrowserToken") {
      return authResponses[mutationResponseIndex++] ?? { ok: true, tokenConfigured: false };
    }

    if (message.type === "regenerateBrowserToken") {
      return authResponses[mutationResponseIndex++] ?? { ok: true, browserToken: "token-2", tokenConfigured: true };
    }

    if (message.type === "listTargets") {
      return { ok: true, targets: [], tokenConfigured: true };
    }

    if (message.type === "getDiagnostics") {
      return { ok: true, diagnostics: [] };
    }

    return { ok: false, error: "Неизвестный запрос" };
  });

  vi.stubGlobal("chrome", {
    runtime: { sendMessage: runtimeSendMessage },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1 }]),
    },
  });
}

async function importInitializedSidePanel(): Promise<void> {
  vi.resetModules();
  await import("./sidepanel");
  await flush();
}

describe("sidepanel auth lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    brokerMock.instances.length = 0;
    document.documentElement.innerHTML = "";
  });

  it("renders unsolicited dynamic targets from the persistent broker client without reopening sidepanel", async () => {
    loadSidePanelHtml();
    mockChrome([{ ok: true, browserToken: "token-1", tokenConfigured: true }]);
    await importInitializedSidePanel();

    expect(brokerMock.instances).toHaveLength(1);
    const brokerClient = brokerMock.instances[0];
    const onTargets = brokerClient.options.onTargets as ((targets: TargetMetadataLike[]) => void) | undefined;

    expect(onTargets).toBeTypeOf("function");
    expect(document.querySelector("#target-container")?.textContent).toContain("Нет активных целей");

    onTargets?.([createTarget()]);
    await flush();

    expect(document.querySelector("#target-container")?.textContent).toContain("Alpha");
    expect(document.querySelector("#target-container")?.textContent).toContain("/tmp/pi-alpha");
  });

  it("does not close and recreate broker client when rendering the same token repeatedly", async () => {
    loadSidePanelHtml();
    mockChrome([{ ok: true, browserToken: "token-1", tokenConfigured: true }]);
    await importInitializedSidePanel();

    expect(brokerMock.instances).toHaveLength(1);
    const firstClient = brokerMock.instances[0];

    document.querySelector<HTMLButtonElement>("#header-auth-button")?.click();
    await flush();

    expect(brokerMock.instances).toHaveLength(1);
    expect(firstClient.close).not.toHaveBeenCalled();
  });

  it("closes the current broker client when the browser token is cleared", async () => {
    loadSidePanelHtml();
    mockChrome([
      { ok: true, browserToken: "token-1", tokenConfigured: true },
      { ok: true, tokenConfigured: false },
    ]);
    await importInitializedSidePanel();

    const firstClient = brokerMock.instances[0];
    document.querySelector<HTMLButtonElement>("#clear-browser-token-button")?.click();
    await flush();

    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>("#chat-send-button")?.disabled).toBe(true);
  });

  it("reconnects exactly once when the browser token is regenerated", async () => {
    loadSidePanelHtml();
    mockChrome([
      { ok: true, browserToken: "token-1", tokenConfigured: true },
      { ok: true, browserToken: "token-2", tokenConfigured: true },
    ]);
    await importInitializedSidePanel();

    const firstClient = brokerMock.instances[0];
    document.querySelector<HTMLButtonElement>("#regenerate-browser-token-button")?.click();
    await flush();

    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(brokerMock.instances).toHaveLength(2);
    expect(brokerMock.instances[1].connect).toHaveBeenCalledTimes(1);
  });
});
