import { describe, it, expect } from "vitest";

import { calculateHlsTime } from "../normalize/remux.js";

describe("calculateHlsTime", () => {
  it("should calculate correct duration for 10 Mbps / 5MB max", () => {
    // 5MB * 8 / 10_000_000 = 4.194s → floor → 4
    const result = calculateHlsTime(10_000_000, 5);
    expect(result).toBe(4);
  });

  it("should calculate correct duration for 2 Mbps / 5MB max", () => {
    // 5MB * 8 / 2_000_000 = 20.97s → clamped to 6
    const result = calculateHlsTime(2_000_000, 5);
    expect(result).toBe(6);
  });

  it("should calculate correct duration for 50 Mbps / 5MB max", () => {
    // 5MB * 8 / 50_000_000 = 0.838s → clamped to 2
    const result = calculateHlsTime(50_000_000, 5);
    expect(result).toBe(2);
  });

  it("should clamp minimum to 2 seconds", () => {
    // Very high bitrate → very short duration → clamped to 2
    const result = calculateHlsTime(100_000_000, 1);
    expect(result).toBe(2);
  });

  it("should clamp maximum to 6 seconds", () => {
    // Very low bitrate → very long duration → clamped to 6
    const result = calculateHlsTime(500_000, 5);
    expect(result).toBe(6);
  });

  it("should return 4 when bitrate is 0 (unknown)", () => {
    const result = calculateHlsTime(0, 5);
    expect(result).toBe(4);
  });

  it("should return 4 when bitrate is negative", () => {
    const result = calculateHlsTime(-1000, 5);
    expect(result).toBe(4);
  });

  it("should handle 1MB max segment size", () => {
    // 1MB * 8 / 10_000_000 = 0.838s → clamped to 2
    const result = calculateHlsTime(10_000_000, 1);
    expect(result).toBe(2);
  });

  it("should handle 3 Mbps / 3MB max", () => {
    // 3MB * 8 / 3_000_000 = 8.388s → clamped to 6
    const result = calculateHlsTime(3_000_000, 3);
    expect(result).toBe(6);
  });

  it("should handle exact boundary at 5 Mbps / 5MB", () => {
    // 5MB * 8 / 5_000_000 = 8.388s → clamped to 6
    const result = calculateHlsTime(5_000_000, 5);
    expect(result).toBe(6);
  });

  it("should handle 8 Mbps / 5MB (common case)", () => {
    // 5MB * 8 / 8_000_000 = 5.24s → floor → 5
    const result = calculateHlsTime(8_000_000, 5);
    expect(result).toBe(5);
  });

  it("should handle 15 Mbps / 5MB", () => {
    // 5MB * 8 / 15_000_000 = 2.79s → floor → 2
    const result = calculateHlsTime(15_000_000, 5);
    expect(result).toBe(2);
  });
});
