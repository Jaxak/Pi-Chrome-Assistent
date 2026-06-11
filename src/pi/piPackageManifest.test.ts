import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Pi package manifest", () => {
  it("declares the browser connect extension entrypoint for pi install", () => {
    const packageJsonPath = join(process.cwd(), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      keywords?: string[];
      peerDependencies?: Record<string, string>;
      pi?: {
        extensions?: string[];
      };
    };

    expect(packageJson.keywords).toContain("pi-package");
    expect(packageJson.pi?.extensions).toContain("./src/pi/browserConnectExtension.ts");
    expect(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(existsSync(join(process.cwd(), ".pi", "extensions", "browser-connect", "index.ts"))).toBe(false);
  });
});
