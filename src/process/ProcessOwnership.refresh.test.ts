import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ownership } from "./ProcessOwnership.fixture.js";

const launcher: ProcessTableEntry = {
  pid: 100,
  parentPid: 1,
  processGroupId: 100,
  state: "S",
  command: "fixture",
};

describe("ownership validation refreshes complete group membership", () => {
  it.each([
    { phase: "planning", token: "owned" },
    { phase: "signaling", token: "owned" },
    { phase: "planning", token: "foreign" },
    { phase: "signaling", token: "foreign" },
    { phase: "planning", token: "missing" },
    { phase: "signaling", token: "missing" },
  ])(
    "classifies a new detached $token group during $phase without stale cleanup authority",
    async ({ phase, token }) => {
      const child = { ...launcher, pid: 200, processGroupId: 200 };
      let exited = false;
      let childExited = false;
      let launcherReads = 0;
      const environment = vi.fn(async (pid: number) => {
        if (pid === child.pid) {
          if (token === "missing") return {};
          if (token === "foreign") return { REA_PROCESS_RUN_ID: "other-run" };
        }
        if (pid === launcher.pid) {
          launcherReads++;
          if (launcherReads === (phase === "planning" ? 2 : 3)) {
            exited = true;
            return {};
          }
        }
        return { REA_PROCESS_RUN_ID: ownership.runId };
      });
      const signalGroup = vi.fn((groupId: number) => {
        if (groupId === child.processGroupId) childExited = true;
      });
      const adapter: ProcessOwnershipHost = {
        listProcesses: async () =>
          childExited ? [] : exited ? [child] : [launcher],
        environment,
        signalGroup,
      };
      const swept = { ...ownership, sweepTokenOwnedProcesses: true };
      const first = await cleanupOwnedProcessGroup(swept, adapter);
      expect(first).toMatchObject({ cleaned: token === "foreign" });
      expect(environment).toHaveBeenCalledWith(child.pid);
      expect(signalGroup).not.toHaveBeenCalled();
      if (token === "owned") {
        await expect(cleanupOwnedProcessGroup(swept, adapter)).resolves.toEqual(
          {
            cleaned: true,
            signaled: true,
          },
        );
        expect(signalGroup).toHaveBeenCalledExactlyOnceWith(200, "SIGKILL");
      } else if (token === "missing")
        expect(first).toMatchObject({
          failures: [{ pid: child.pid, reason: "environment-unreadable" }],
        });
    },
  );
});

describe("ownership sweeps reconcile later group validation", () => {
  it.each(["owned", "exited", "foreign", "reused"])(
    "reconciles a missing-token sweep failure when later group validation is %s",
    async (state) => {
      const child = { ...launcher, pid: 101, parentPid: launcher.pid };
      let childReads = 0;
      const signalGroup = vi.fn();
      const result = await cleanupOwnedProcessGroup(
        { ...ownership, captureBaseline: [], sweepTokenOwnedProcesses: true },
        {
          listProcesses: async () =>
            state === "exited" && childReads >= 5
              ? [launcher]
              : [launcher, child],
          processIdentities: async (members) =>
            new Map(
              members.map(({ pid }) => [
                pid,
                {
                  state: "readable" as const,
                  identity:
                    pid === child.pid && state === "reused" && childReads >= 5
                      ? "replacement-start"
                      : `start-${String(pid)}`,
                },
              ]),
            ),
          environment: async (pid) => {
            if (pid === child.pid) {
              childReads++;
              if (childReads <= 4 || state === "exited") return {};
              if (state === "foreign")
                return { REA_PROCESS_RUN_ID: "other-run" };
            }
            return { REA_PROCESS_RUN_ID: ownership.runId };
          },
          signalGroup,
        },
      );
      if (state === "owned" || state === "exited") {
        expect(result).toEqual({ cleaned: true, signaled: true });
        expect(signalGroup).toHaveBeenCalledExactlyOnceWith(100, "SIGKILL");
      } else {
        expect(result).toMatchObject({
          cleaned: false,
          failures: [
            expect.objectContaining({
              pid: child.pid,
              reason:
                state === "foreign"
                  ? "run-token-mismatch"
                  : "process-identity-unavailable",
            }),
          ],
        });
        expect(signalGroup).not.toHaveBeenCalled();
      }
    },
  );
});

describe("ownership validation refreshes surviving members", () => {
  it.each(["planning", "signaling"])(
    "validates new owned and foreign members discovered during %s",
    async (phase) => {
      for (const token of [ownership.runId, "other-run"]) {
        const child = { ...launcher, pid: 101 };
        let exited = false;
        let launcherReads = 0;
        const environment = vi.fn(async (pid: number) => {
          if (pid === child.pid) return { REA_PROCESS_RUN_ID: token };
          launcherReads++;
          if (launcherReads === (phase === "planning" ? 1 : 2)) {
            exited = true;
            return {};
          }
          return { REA_PROCESS_RUN_ID: ownership.runId };
        });
        const signalGroup = vi.fn();
        const result = await cleanupOwnedProcessGroup(ownership, {
          listProcesses: async () => (exited ? [child] : [launcher]),
          environment,
          signalGroup,
        });
        expect(environment).toHaveBeenCalledWith(child.pid);
        if (token === ownership.runId) {
          expect(result).toEqual({ cleaned: true, signaled: true });
          expect(signalGroup).toHaveBeenCalledExactlyOnceWith(100, "SIGKILL");
        } else {
          expect(result).toMatchObject({
            cleaned: false,
            failures: [{ pid: child.pid, reason: "run-token-mismatch" }],
          });
          expect(signalGroup).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("retains uncertainty when new members keep joining during validation", async () => {
    let current = launcher;
    const signalGroup = vi.fn();
    const result = await cleanupOwnedProcessGroup(ownership, {
      listProcesses: async () => [current],
      environment: async () => {
        current = { ...current, pid: current.pid + 1 };
        return {};
      },
      signalGroup,
    });
    expect(result).toMatchObject({
      cleaned: false,
      failures: [{ pid: current.pid, reason: "process-identity-unavailable" }],
    });
    expect(signalGroup).not.toHaveBeenCalled();
    expect(current.pid).toBeLessThan(110);
  });
});

describe("ownership sweeps preserve missing-token uncertainty", () => {
  const old = { ...launcher, pid: 50, processGroupId: 50 };
  const child = { ...launcher, pid: 200, processGroupId: 200 };
  const baseline = [{ pid: old.pid, identity: "old-start" }];

  it.each(["missing", "unreadable-then-missing", "foreign", "exited"])(
    "settles a post-baseline detached candidate whose token is %s",
    async (state) => {
      const makeHost = (): ProcessOwnershipHost => {
        let reads = 0;
        return {
          listProcesses: async () =>
            state === "exited" && reads > 0 ? [old] : [old, child],
          processIdentities: async (members) =>
            new Map(
              members.map(({ pid }) => [
                pid,
                {
                  state: "readable" as const,
                  identity: pid === old.pid ? "old-start" : "child-start",
                },
              ]),
            ),
          environment: async (pid) => {
            if (pid === old.pid)
              throw new Error(
                "Baseline identities must not be reread for tokens",
              );
            reads++;
            if (state === "unreadable-then-missing" && reads === 1)
              throw new Error("transient environment read failure");
            return state === "foreign"
              ? { REA_PROCESS_RUN_ID: "other-run" }
              : {};
          },
          signalGroup: vi.fn(),
        };
      };
      const cleanup = await cleanupOwnedProcessGroup(
        {
          ...ownership,
          captureBaseline: baseline,
          sweepTokenOwnedProcesses: true,
        },
        makeHost(),
      );
      const verification = await verifyNoTokenOwnedProcesses(
        ownership.runId,
        makeHost(),
        baseline,
      );
      for (const result of [cleanup, verification]) {
        if (state === "foreign" || state === "exited")
          expect(result).toEqual({ cleaned: true, signaled: false });
        else
          expect(result).toMatchObject({
            cleaned: false,
            failures: [
              {
                pid: child.pid,
                reason: "environment-unreadable",
                diagnostic: "run_token_missing",
              },
            ],
          });
      }
    },
  );
});
