import { describe, expect, it } from "vitest";

import {
  BROKER_UNAVAILABLE_TOAST_MESSAGE,
  BROWSER_AUTH_REQUIRED_TOAST_MESSAGE,
  MISSING_BROWSER_TOKEN_TOAST_MESSAGE,
  MISSING_TARGET_TOAST_MESSAGE,
  SEND_SELECTION_SUCCESS_TOAST_MESSAGE,
  formatSendSelectionErrorToastMessage,
} from "./contentScriptMessages";

describe("contentScriptMessages", () => {
  it("uses the agreed success toast copy", () => {
    expect(SEND_SELECTION_SUCCESS_TOAST_MESSAGE).toBe("Отправлено в Pi");
  });

  it("maps missing target errors to the agreed picker guidance", () => {
    expect(formatSendSelectionErrorToastMessage("No selected target configured in chrome.storage.local")).toBe(
      MISSING_TARGET_TOAST_MESSAGE,
    );
    expect(formatSendSelectionErrorToastMessage("Target not found")).toBe(
      MISSING_TARGET_TOAST_MESSAGE,
    );
  });

  it("maps broker connectivity issues to the agreed broker guidance", () => {
    expect(MISSING_BROWSER_TOKEN_TOAST_MESSAGE).toBe("Для отправки настройте browserToken в chrome.storage.local.");
    expect(formatSendSelectionErrorToastMessage("No browser token configured in chrome.storage.local")).toBe(
      MISSING_BROWSER_TOKEN_TOAST_MESSAGE,
    );
    expect(formatSendSelectionErrorToastMessage("No broker token configured in chrome.storage.local")).toBe(
      MISSING_BROWSER_TOKEN_TOAST_MESSAGE,
    );
    expect(BROKER_UNAVAILABLE_TOAST_MESSAGE).toBe("Pi не подключён. Выполните /chrome-assistent-connect в терминале.");
    expect(formatSendSelectionErrorToastMessage("Broker connection timed out: ws://127.0.0.1:17345")).toBe(
      BROKER_UNAVAILABLE_TOAST_MESSAGE,
    );
  });

  it("maps browser auth failures to the agreed auth guidance", () => {
    expect(BROWSER_AUTH_REQUIRED_TOAST_MESSAGE).toBe(
      "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.",
    );
    expect(formatSendSelectionErrorToastMessage("Браузер не авторизован в Pi")).toBe(
      BROWSER_AUTH_REQUIRED_TOAST_MESSAGE,
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
});
