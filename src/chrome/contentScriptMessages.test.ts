import { describe, expect, it } from "vitest";

import {
  BROKER_UNAVAILABLE_TOAST_MESSAGE,
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
    expect(BROKER_UNAVAILABLE_TOAST_MESSAGE).toBe("Pi не подключён. Выполните /chrome-assistent-connect в терминале.");
    expect(formatSendSelectionErrorToastMessage("No broker token configured in chrome.storage.local")).toBe(
      BROKER_UNAVAILABLE_TOAST_MESSAGE,
    );
    expect(formatSendSelectionErrorToastMessage("Broker connection timed out: ws://127.0.0.1:17345")).toBe(
      BROKER_UNAVAILABLE_TOAST_MESSAGE,
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
