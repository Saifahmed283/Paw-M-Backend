import { describe, it, expect } from "vitest";
import { isValidBase64Image, getBase64ByteLength, fawryReference } from "../../src/lib/utils.js";

describe("utils", () => {
  describe("isValidBase64Image", () => {
    it("accepts valid data URLs", () => {
      const valid = "data:image/png;base64,iVBORw0KGgo=";
      expect(isValidBase64Image(valid)).toBe(true);
    });

    it("accepts jpeg", () => {
      const valid = "data:image/jpeg;base64,/9j/4AAQ=";
      expect(isValidBase64Image(valid)).toBe(true);
    });

    it("rejects non-image strings", () => {
      expect(isValidBase64Image("hello")).toBe(false);
      expect(isValidBase64Image("")).toBe(false);
      expect(isValidBase64Image(null)).toBe(false);
    });

    it("rejects non-base64 encoding", () => {
      expect(isValidBase64Image("data:image/png;ascii,data")).toBe(false);
    });
  });

  describe("getBase64ByteLength", () => {
    it("returns correct byte length for base64 data", () => {
      const dataUrl = "data:image/png;base64,AAAA";
      const len = getBase64ByteLength(dataUrl);
      expect(len).toBeGreaterThan(0);
    });

    it("returns 0 for invalid input", () => {
      expect(getBase64ByteLength("not-a-data-url")).toBe(0);
    });
  });

  describe("fawryReference", () => {
    it("starts with PAW-", () => {
      const ref = fawryReference();
      expect(ref).toMatch(/^PAW-[A-Z0-9]{6}$/);
    });

    it("generates unique references", () => {
      const refs = new Set(Array.from({ length: 100 }, () => fawryReference()));
      expect(refs.size).toBe(100);
    });
  });
});
