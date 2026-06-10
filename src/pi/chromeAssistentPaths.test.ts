import { describe, expect, it } from "vitest";

import {
  getChromeAssistentLogPath,
  getChromeAssistentRuntimeDir,
  getGlobalBrokerTokenPath,
  getTrustedBrowsersPath,
} from "./chromeAssistentPaths";

describe("chromeAssistentPaths", () => {
  it("resolves Chrome Assistent runtime paths under the global Pi home area", () => {
    expect(getChromeAssistentRuntimeDir("/home/tester")).toBe("/home/tester/.pi/chrome-assistent");
    expect(getGlobalBrokerTokenPath("/home/tester")).toBe("/home/tester/.pi/chrome-assistent/broker.token");
    expect(getTrustedBrowsersPath("/home/tester")).toBe("/home/tester/.pi/chrome-assistent/trusted-browsers.json");
    expect(getChromeAssistentLogPath("/home/tester")).toBe("/home/tester/.pi/chrome-assistent/chrome-assistent.log");
  });
});
