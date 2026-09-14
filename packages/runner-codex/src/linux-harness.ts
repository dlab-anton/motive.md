import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { HarnessEvidence } from "./harness.ts";

const BASE_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const DOCKER_TIMEOUT_MS = 180_000;
const PURPOSE_LABEL = "motive.purpose=codex-profile-repair";

type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

export type LinuxHarnessEvidence = {
  format: "motive.codex-linux-compatibility/0.1";
  status: "passed" | "failed";
  capturedAt: string;
  baseImage: string;
  imageDigest: string | null;
  sourceDigests: Record<string, string>;
  isolation: {
    user: string | null;
    networkMode: string | null;
    readOnlyRootfs: boolean | null;
    binds: string[];
    capDrop: string[];
    noNewPrivileges: boolean;
    pidsLimit: number | null;
    memoryBytes: number | null;
  } | null;
  harness: HarnessEvidence | null;
  diagnostics: string[];
  cleanup: { containerRemoved: boolean; imageRemoved: boolean; buildContextRemoved: boolean };
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function runDocker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => {
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - captured);
      const accepted = chunk.subarray(0, remaining);
      captured += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
      return current + accepted.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut, truncated });
    });
  });
}

function diagnostic(label: string, result: CommandResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return `${label}: exit=${result.code} timedOut=${result.timedOut} truncated=${result.truncated}${detail ? `\n${detail}` : ""}`;
}

export async function runLinuxCompatibilityHarness(): Promise<LinuxHarnessEvidence> {
  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  const containerName = `motive-codex-lab-${nonce}`;
  const imageTag = `motive-codex-lab:${nonce}`;
  const buildContext = await mkdtemp(join(tmpdir(), "motive-codex-linux-build-"));
  const sourceRoot = resolve("packages/runner-codex/src");
  const sourceNames = ["catalog.ts", "harness.ts", "linux-entry.ts", "mock-provider.ts", "protocol.ts"];
  const diagnostics: string[] = [];
  let containerCreated = false;
  let imageBuilt = false;
  let harness: HarnessEvidence | null = null;
  let imageDigest: string | null = null;
  let isolation: LinuxHarnessEvidence["isolation"] = null;
  let containerRemoved = false;
  let imageRemoved = false;
  let buildContextRemoved = false;

  try {
    await Promise.all(sourceNames.map((name) => copyFile(join(sourceRoot, name), join(buildContext, name))));
    const dockerfile = [
      `FROM ${BASE_IMAGE}`,
      `LABEL ${PURPOSE_LABEL}`,
      "RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.153.4 \\",
      " && test \"$(codex --version)\" = \"codex-cli 0.153.4\"",
      "WORKDIR /opt/motive-codex-probe",
      "COPY --chown=node:node catalog.ts harness.ts linux-entry.ts mock-provider.ts protocol.ts ./",
      "USER node",
      "ENTRYPOINT [\"node\", \"linux-entry.ts\"]",
      "",
    ].join("\n");
    await writeFile(join(buildContext, "Dockerfile"), dockerfile, "utf8");

    const build = await runDocker(["build", "--pull=false", "--label", PURPOSE_LABEL, "--tag", imageTag, buildContext]);
    if (build.code !== 0 || build.timedOut || build.truncated) {
      diagnostics.push(diagnostic("docker build", build));
      throw new Error("Pinned Codex lab image build failed");
    }
    imageBuilt = true;
    const imageInspect = await runDocker(["image", "inspect", "--format", "{{.Id}}", imageTag], 30_000);
    imageDigest = imageInspect.code === 0 ? imageInspect.stdout.trim() : null;

    const create = await runDocker([
      "create",
      "--name", containerName,
      "--label", PURPOSE_LABEL,
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "64",
      "--memory", "512m",
      "--cpus", "1",
      imageTag,
    ], 30_000);
    if (create.code !== 0) {
      diagnostics.push(diagnostic("docker create", create));
      throw new Error("Pinned Codex lab container creation failed");
    }
    containerCreated = true;

    const inspect = await runDocker(["inspect", containerName], 30_000);
    if (inspect.code !== 0) {
      diagnostics.push(diagnostic("docker inspect", inspect));
      throw new Error("Could not inspect Codex lab isolation");
    }
    const inspected = JSON.parse(inspect.stdout)[0] as Record<string, any>;
    const securityOpt = Array.isArray(inspected.HostConfig?.SecurityOpt) ? inspected.HostConfig.SecurityOpt.map(String) : [];
    isolation = {
      user: inspected.Config?.User ?? null,
      networkMode: inspected.HostConfig?.NetworkMode ?? null,
      readOnlyRootfs: inspected.HostConfig?.ReadonlyRootfs ?? null,
      binds: Array.isArray(inspected.HostConfig?.Binds) ? inspected.HostConfig.Binds.map(String) : [],
      capDrop: Array.isArray(inspected.HostConfig?.CapDrop) ? inspected.HostConfig.CapDrop.map(String) : [],
      noNewPrivileges: securityOpt.some((value: string) => value === "no-new-privileges" || value === "no-new-privileges:true"),
      pidsLimit: inspected.HostConfig?.PidsLimit ?? null,
      memoryBytes: inspected.HostConfig?.Memory ?? null,
    };

    const execution = await runDocker(["start", "--attach", containerName], 60_000);
    if (execution.timedOut || execution.truncated) diagnostics.push(diagnostic("docker execution", execution));
    const jsonLine = execution.stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{"));
    if (jsonLine) {
      try { harness = JSON.parse(jsonLine) as HarnessEvidence; }
      catch (error) { diagnostics.push(`Harness JSON parse failed: ${String(error)}`); }
    } else {
      diagnostics.push(diagnostic("docker execution", execution));
    }
    if (execution.code !== 0 && diagnostics.length === 0) diagnostics.push(diagnostic("docker execution", execution));
  } catch (error) {
    diagnostics.push(String(error));
  } finally {
    if (containerCreated && containerName.startsWith("motive-codex-lab-")) {
      const cleanup = await runDocker(["rm", "--force", containerName], 30_000);
      containerRemoved = cleanup.code === 0;
      if (!containerRemoved) diagnostics.push(diagnostic("container cleanup", cleanup));
    }
    if (imageBuilt && imageTag.startsWith("motive-codex-lab:")) {
      const cleanup = await runDocker(["image", "rm", "--force", imageTag], 30_000);
      imageRemoved = cleanup.code === 0;
      if (!imageRemoved) diagnostics.push(diagnostic("image cleanup", cleanup));
    }
    const resolvedBuildContext = resolve(buildContext);
    if (resolvedBuildContext.startsWith(`${resolve(tmpdir())}${sep}`) && basename(resolvedBuildContext).startsWith("motive-codex-linux-build-")) {
      await rm(resolvedBuildContext, { recursive: true, force: true });
      buildContextRemoved = true;
    } else {
      diagnostics.push(`Refused to remove unexpected build context: ${resolvedBuildContext}`);
    }
  }

  const sourceDigests = Object.fromEntries(await Promise.all(sourceNames.map(async (name) => [name, sha256(await readFile(join(sourceRoot, name)))])));
  const cleanupComplete = containerRemoved && imageRemoved && buildContextRemoved;
  return {
    format: "motive.codex-linux-compatibility/0.1",
    status: harness?.status === "passed" && cleanupComplete ? "passed" : "failed",
    capturedAt: new Date().toISOString(),
    baseImage: BASE_IMAGE,
    imageDigest,
    sourceDigests,
    isolation,
    harness,
    diagnostics,
    cleanup: { containerRemoved, imageRemoved, buildContextRemoved },
  };
}
