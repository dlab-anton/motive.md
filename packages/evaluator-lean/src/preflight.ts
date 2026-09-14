import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter } from "node:path";

export type CheckStatus = "pass" | "fail" | "unresolved";

export type PrerequisiteCheck = {
  id: string;
  status: CheckStatus;
  observed: string;
  requirement: string;
};

export type EvaluatorPreflight = {
  status: "ready" | "blocked";
  checkedAt: string;
  host: { platform: NodeJS.Platform; arch: string; release: string };
  checks: PrerequisiteCheck[];
  caveats: string[];
};

export type HostProbe = {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  uid: number | null;
  commandPaths: Record<string, string | null>;
  systemdUserProbe: { code: number | null; detail: string } | null;
};

function findOnPath(command: string): Promise<string | null> {
  const executableNames = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command] : [command];
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return (async () => {
    for (const directory of directories) {
      for (const executable of executableNames) {
        const candidate = `${directory}/${executable}`;
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Continue searching.
        }
      }
    }
    return null;
  })();
}

async function runSystemdProbe(): Promise<{ code: number | null; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn("systemd-run", ["--user", "--wait", "--quiet", "--property=RestrictAddressFamilies=~AF_UNIX", "true"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let detail = "";
    let settled = false;
    const capture = (chunk: Buffer) => {
      if (Buffer.byteLength(detail) < 64 * 1024) detail += chunk.subarray(0, 64 * 1024 - Buffer.byteLength(detail)).toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const finish = (code: number | null, suffix = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, detail: `${detail.trim()}${suffix}`.trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, " systemd probe exceeded 5000ms");
    }, 5_000);
    child.on("error", (error) => finish(null, ` ${error.message}`));
    child.on("close", (code) => finish(code));
  });
}

export async function probeCurrentHost(): Promise<HostProbe> {
  const os = await import("node:os");
  const names = ["lean", "lake", "landrun", "lean4export", "systemd-run", "bash"];
  const commandPaths = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await findOnPath(name)])));
  const systemdUserProbe = process.platform === "linux" && commandPaths["systemd-run"] ? await runSystemdProbe() : null;
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    commandPaths,
    systemdUserProbe,
  };
}

export function evaluatePrerequisites(probe: HostProbe, checkedAt = new Date().toISOString()): EvaluatorPreflight {
  const checks: PrerequisiteCheck[] = [];
  checks.push({
    id: "linux-host",
    status: probe.platform === "linux" ? "pass" : "fail",
    observed: `${probe.platform}/${probe.arch} ${probe.release}`,
    requirement: "Comparator and Landrun must run on the actual supported Linux evaluator host.",
  });
  checks.push({
    id: "nonprivileged-user",
    status: probe.uid === null ? "unresolved" : probe.uid === 0 ? "fail" : "pass",
    observed: probe.uid === null ? "UID unavailable on this host" : `uid=${probe.uid}`,
    requirement: "Comparator must not run as a privileged user.",
  });
  for (const name of ["lean", "lake", "landrun", "lean4export"] as const) {
    const path = probe.commandPaths[name];
    checks.push({
      id: `binary-${name}`,
      status: path ? "pass" : "fail",
      observed: path ?? "not found on PATH",
      requirement: `${name} must be version-pinned and executable on the evaluator host.`,
    });
  }
  const systemdPath = probe.commandPaths["systemd-run"];
  checks.push({
    id: "systemd-af-unix-mitigation",
    status: !systemdPath || !probe.systemdUserProbe ? "fail" : probe.systemdUserProbe.code === 0 ? "pass" : "fail",
    observed: !systemdPath
      ? "systemd-run not found"
      : !probe.systemdUserProbe
        ? "restriction probe not executed on this host"
        : `exit=${String(probe.systemdUserProbe.code)} ${probe.systemdUserProbe.detail}`.trim(),
    requirement: "A user unit must enforce RestrictAddressFamilies=~AF_UNIX around Comparator.",
  });
  checks.push({
    id: "trusted-fixture-suite",
    status: "unresolved",
    observed: "No Comparator execution was attempted by this host-only preflight.",
    requirement: "Run pinned positive and required negative fixtures in a clean evaluator after host prerequisites pass.",
  });
  return {
    status: checks.every((check) => check.status === "pass") ? "ready" : "blocked",
    checkedAt,
    host: { platform: probe.platform, arch: probe.arch, release: probe.release },
    checks,
    caveats: [
      "Binary presence does not prove Landrun confinement, kernel correctness, or challenge/source integrity.",
      "The development fake-landrun script is deliberately not accepted by this preflight.",
      "Lean, lean4export, Comparator, challenge dependencies, and permitted axioms must be pinned together.",
    ],
  };
}

export async function runEvaluatorPreflight(): Promise<EvaluatorPreflight> {
  return evaluatePrerequisites(await probeCurrentHost());
}
