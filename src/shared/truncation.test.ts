import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "./truncation";

describe("truncateUtf8", () => {
  it("does not rely on Node Buffer in the shared implementation", () => {
    const source = readFileSync(new URL("./truncation.ts", import.meta.url), "utf8");
    expect(source).not.toContain("Buffer");
  });

  it("keeps short strings unchanged", () => {
    expect(truncateUtf8("hello", 100)).toEqual({ value: "hello", truncated: false, originalBytes: 5 });
  });

  it("truncates long strings, marks them, and keeps the final value within maxBytes", () => {
    const input = "abcdef".repeat(20);
    const maxBytes = 64;
    const result = truncateUtf8(input, maxBytes);

    expect(result.truncated).toBe(true);
    expect(result.value).toContain(`[truncated: original ${new TextEncoder().encode(input).length} bytes, limit ${maxBytes} bytes]`);
    expect(new TextEncoder().encode(result.value).length).toBeLessThanOrEqual(maxBytes);
  });

  it("does not split unicode into invalid replacement characters and stays within maxBytes", () => {
    const input = "😀".repeat(30);
    const maxBytes = 64;
    const result = truncateUtf8(input, maxBytes);

    expect(result.truncated).toBe(true);
    expect(result.value).not.toContain("�");
    expect(new TextEncoder().encode(result.value).length).toBeLessThanOrEqual(maxBytes);
  });

  it("keeps the final value within maxBytes when the byte budget is smaller than the full suffix", () => {
    const input = "😀".repeat(10);
    const maxBytes = 3;
    const result = truncateUtf8(input, maxBytes);

    expect(new TextEncoder().encode(result.value).length).toBeLessThanOrEqual(maxBytes);
    expect(result.truncated).toBe(true);
    expect(result.value).not.toContain("�");
  });
});
