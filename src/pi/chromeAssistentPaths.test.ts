import { describe, expect, it } from "vitest";

import {
  getChromeAssistentLogPath,
  getChromeAssistentRuntimeDir,
} from "./chromeAssistentPaths";

describe("chromeAssistentPaths", () => {
  it("resolves Chrome Assistent runtime paths under the global Pi home area", () => {
    expect(getChromeAssistentRuntimeDir("/home/tester")).toBe("/home/tester/.pi/chrome-assistent");
    expect(getChromeAssistentLogPath("/home/tester")).toBe("/home/tester/.pi/chrome-assistent/chrome-assistent.log");
  });
});
