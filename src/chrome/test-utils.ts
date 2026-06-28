import type { DirectSessionSnapshot } from "../shared/protocol";

/**
 * Create a default DirectSessionSnapshot for tests.
 * Override any sub-object or leaf field by passing partial overrides.
 */
export function createDirectSnapshot(
  overrides: Partial<DirectSessionSnapshot> = {},
): DirectSessionSnapshot {
  return {
    session: {
      cwd: "/repo",
      gitBranch: "main",
      pid: 1234,
      sessionName: "test-session",
      alias: "frontend",
      connectedAt: 1_710_000_000_000,
      ...overrides.session,
    },
    chat: {
      entries: [],
      agentBusy: false,
      busyLabel: "Агент работает в фоне…",
      ...overrides.chat,
    },
    runtime: {
      model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      ],
      contextUsage: { tokens: 1000, maxTokens: 200000, percent: 0.5 },
      isIdle: true,
      updatedAt: 1_710_000_000_500,
      ...overrides.runtime,
    },
    ...overrides,
  };
}
