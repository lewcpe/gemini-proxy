import { describe, expect, it } from "vitest";
import { packToolUseId, unpackToolUseId } from "../src/translate/ids.js";

describe("tool_use id packing", () => {
  it("returns the bare id when there is no signature", () => {
    expect(packToolUseId({ id: "toolu_abc" })).toBe("toolu_abc");
    expect(unpackToolUseId("toolu_abc")).toEqual({ cleanId: "toolu_abc", signature: null });
  });

  it("round-trips real base64 signatures at every padding length", () => {
    // Covers the +/= alphabet that base64url has to escape, and all three
    // padding cases, at a size comparable to a real thoughtSignature.
    const signatures = [1, 2, 3, 4, 255, 256, 257].map((length) =>
      Buffer.from(Array.from({ length }, (_, i) => (i * 37) % 256)).toString("base64"),
    );
    for (const signature of signatures) {
      const packed = packToolUseId({ id: "toolu_abc" }, signature);
      expect(unpackToolUseId(packed)).toEqual({ cleanId: "toolu_abc", signature });
    }
    expect(signatures.some((s) => s.includes("+") || s.includes("/"))).toBe(true);
    expect(signatures.some((s) => s.endsWith("=="))).toBe(true);
  });

  it("keeps the id intact when it already contains the separator", () => {
    const packed = packToolUseId({ id: "toolu__ts__weird" }, "YWJj");
    expect(unpackToolUseId(packed)).toEqual({ cleanId: "toolu__ts__weird", signature: "YWJj" });
  });

  it("treats a non-base64url tail as part of the id, not a signature", () => {
    expect(unpackToolUseId("toolu_abc__ts__")).toEqual({ cleanId: "toolu_abc__ts__", signature: null });
    expect(unpackToolUseId("toolu_abc__ts__not valid!")).toEqual({
      cleanId: "toolu_abc__ts__not valid!",
      signature: null,
    });
  });

  it("mints an id when Gemini supplies none", () => {
    expect(packToolUseId({})).toMatch(/^toolu_[0-9a-f]{26}$/);
  });

  it("survives non-string input", () => {
    expect(unpackToolUseId(undefined)).toEqual({ cleanId: null, signature: null });
    expect(unpackToolUseId("")).toEqual({ cleanId: null, signature: null });
  });
});
