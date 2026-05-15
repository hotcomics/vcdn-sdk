import { describe, it, expect } from "vitest";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { TempWorkspace } from "../normalize/temp.js";

describe("TempWorkspace", () => {
  it("should create an isolated temp directory", async () => {
    const ws = await TempWorkspace.create();

    expect(ws.dir).toBeTruthy();
    expect(ws.dir.includes("vcdn-normalize-")).toBe(true);

    // Directory should exist
    const st = await stat(ws.dir);
    expect(st.isDirectory()).toBe(true);

    await ws.cleanup();
  });

  it("should use custom root directory", async () => {
    const customRoot = tmpdir();
    const ws = await TempWorkspace.create({ root: customRoot });

    expect(ws.dir.startsWith(customRoot)).toBe(true);

    await ws.cleanup();
  });

  it("should use custom prefix", async () => {
    const ws = await TempWorkspace.create({ prefix: "test-prefix-" });

    expect(path.basename(ws.dir).startsWith("test-prefix-")).toBe(true);

    await ws.cleanup();
  });

  it("should resolve paths within workspace", async () => {
    const ws = await TempWorkspace.create();

    const resolved = ws.resolve("subdir", "file.mp4");
    expect(resolved).toBe(path.join(ws.dir, "subdir", "file.mp4"));

    await ws.cleanup();
  });

  it("should cleanup directory and contents", async () => {
    const ws = await TempWorkspace.create();
    const dir = ws.dir;

    // Verify it exists
    await access(dir);

    // Cleanup
    await ws.cleanup();

    // Should no longer exist
    await expect(access(dir)).rejects.toThrow();
  });

  it("should be safe to call cleanup multiple times", async () => {
    const ws = await TempWorkspace.create();

    await ws.cleanup();
    // Second call should not throw
    await ws.cleanup();
  });

  it("should create unique directories for concurrent workspaces", async () => {
    const ws1 = await TempWorkspace.create();
    const ws2 = await TempWorkspace.create();

    expect(ws1.dir).not.toBe(ws2.dir);

    await ws1.cleanup();
    await ws2.cleanup();
  });
});
