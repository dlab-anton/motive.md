import { describe, expect, it } from "vitest";
import { evaluatePrerequisites, type HostProbe } from "./preflight.ts";

const readyProbe: HostProbe = {
  platform: "linux",
  arch: "x64",
  release: "6.12.0",
  uid: 1000,
  commandPaths: {
    lean: "/bin/lean",
    lake: "/bin/lake",
    landrun: "/bin/landrun",
    lean4export: "/bin/lean4export",
    "systemd-run": "/bin/systemd-run",
    bash: "/bin/bash",
  },
  systemdUserProbe: { code: 0, detail: "" },
};

describe("Lean evaluator prerequisite policy", () => {
  it("does not claim readiness before the trusted fixture suite runs", () => {
    const result = evaluatePrerequisites(readyProbe, "2026-09-06T00:00:00.000Z");
    expect(result.status).toBe("blocked");
    expect(result.checks.find((check) => check.id === "trusted-fixture-suite")?.status).toBe("unresolved");
  });

  it("rejects root and missing confinement tools", () => {
    const result = evaluatePrerequisites({
      ...readyProbe,
      uid: 0,
      commandPaths: { ...readyProbe.commandPaths, landrun: null, "systemd-run": null },
      systemdUserProbe: null,
    });
    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "nonprivileged-user", status: "fail" }),
      expect.objectContaining({ id: "binary-landrun", status: "fail" }),
      expect.objectContaining({ id: "systemd-af-unix-mitigation", status: "fail" }),
    ]));
  });
});
