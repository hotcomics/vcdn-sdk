/**
 * Temp workspace manager for the normalize pipeline.
 *
 * Creates isolated temporary directories, registers cleanup handlers for
 * SIGINT/SIGTERM/uncaughtException, and provides deterministic cleanup.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Set of active workspaces for crash cleanup. */
const activeWorkspaces = new Set<string>();
let handlersRegistered = false;

function registerGlobalCleanupHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  const cleanup = () => {
    for (const dir of activeWorkspaces) {
      try {
        // Synchronous best-effort cleanup on process exit
        // We use rm with force to avoid errors on missing dirs
        rm(dir, { recursive: true, force: true }).catch(() => {});
      } catch {
        // Ignore — process is exiting
      }
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  process.on("uncaughtException", (err) => {
    cleanup();
    console.error("[vcdn] uncaughtException during normalize:", err);
    process.exit(1);
  });
}

export class TempWorkspace {
  readonly dir: string;
  private cleaned = false;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Create a new isolated temp workspace.
   *
   * @param options.root - Base directory for temp files. Defaults to os.tmpdir().
   * @param options.prefix - Directory name prefix. Defaults to 'vcdn-normalize-'.
   */
  static async create(options?: {
    root?: string;
    prefix?: string;
  }): Promise<TempWorkspace> {
    registerGlobalCleanupHandlers();

    const root = options?.root ?? tmpdir();
    const prefix = options?.prefix ?? "vcdn-normalize-";
    const dir = await mkdtemp(path.join(root, prefix));

    activeWorkspaces.add(dir);
    return new TempWorkspace(dir);
  }

  /**
   * Remove the temp directory and all contents.
   * Safe to call multiple times.
   */
  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    activeWorkspaces.delete(this.dir);
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Returns a path within this workspace. */
  resolve(...segments: string[]): string {
    return path.join(this.dir, ...segments);
  }
}
