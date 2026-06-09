import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "./constants";

describe("shared constants", () => {
  it("defines the protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
