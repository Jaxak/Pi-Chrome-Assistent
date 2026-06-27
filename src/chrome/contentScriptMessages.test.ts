import { describe, expect, it } from "vitest";

import {
  DIRECT_UNAVAILABLE_TOAST_MESSAGE,
  SEND_SELECTION_SUCCESS_TOAST_MESSAGE,
  formatSendSelectionErrorToastMessage,
} from "./contentScriptMessages";

describe("contentScriptMessages", () => {
  it("uses the agreed success toast copy", () => {
    expect(SEND_SELECTION_SUCCESS_TOAST_MESSAGE).toBe("Отправлено в Pi");
  });

  it("maps direct unavailability errors to the agreed guidance", () => {
    expect(DIRECT_UNAVAILABLE_TOAST_MESSAGE).toBe("Pi-сессия не подключена.");
    expect(formatSendSelectionErrorToastMessage("Pi-сессия не подключена")).toBe(
      DIRECT_UNAVAILABLE_TOAST_MESSAGE,
    );
    expect(formatSendSelectionErrorToastMessage("Pi недоступен")).toBe(
      DIRECT_UNAVAILABLE_TOAST_MESSAGE,
    );
    expect(formatSendSelectionErrorToastMessage("not connected")).toBe(
      DIRECT_UNAVAILABLE_TOAST_MESSAGE,
    );
    expect(formatSendSelectionErrorToastMessage("connection failed")).toBe(
      DIRECT_UNAVAILABLE_TOAST_MESSAGE,
    );
    expect(formatSendSelectionErrorToastMessage("websocket closed")).toBe(
      DIRECT_UNAVAILABLE_TOAST_MESSAGE,
    );
  });

  it("keeps a short reason for generic failures without exposing prefixes", () => {
    expect(formatSendSelectionErrorToastMessage("Payload rejected: selection too large")).toBe(
      "Не удалось отправить в Pi: selection too large.",
    );
  });

  it("falls back to a short generic reason when the raw error is not useful", () => {
    expect(formatSendSelectionErrorToastMessage("Unable to send selection to Pi.")).toBe(
      "Не удалось отправить в Pi: без подробностей.",
    );
  });

  it("sanitizes internal errors with generic reason mappings", () => {
    // chrome.storage.local triggers internal pattern -> "внутренняя ошибка" when no sub-pattern matches
    expect(formatSendSelectionErrorToastMessage("Failed reading chrome.storage.local")).toBe(
      "Не удалось отправить в Pi: внутренняя ошибка.",
    );
    // client.* triggers internal pattern -> "внутренняя ошибка" (no sub-pattern match)
    expect(formatSendSelectionErrorToastMessage("client.sendMessage failed")).toBe(
      "Не удалось отправить в Pi: внутренняя ошибка.",
    );
  });

  it("truncates long generic errors", () => {
    const longError = "A".repeat(100);
    const result = formatSendSelectionErrorToastMessage(longError);
    expect(result).toContain("Не удалось отправить в Pi");
    expect(result).toContain("…");
  });
});
