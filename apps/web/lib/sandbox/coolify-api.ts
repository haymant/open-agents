import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";

// ── constants ────────────────────────────────────────────

/** Port code-server listens on inside the container */
const CODE_SERVER_PORT = 1222;
/** Default health-check port for the fs.js API */
const DEFAULT_HEALTH_PORT = 1223;

// ── error ────────────────────────────────────────────────

export class CoolifyApiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "CoolifyApiError";
    this.status = status;
  }
}

// ── in-flight deployment dedup ───────────────────────────

const inFlightDeployments = new Map<string, Promise<string>>();

function dedupeDeployment(
  appUuid: string,
  action: () => Promise<string>,
): Promise<string> {
  const existing = inFlightDeployments.get(appUuid);
  if (existing) return existing;
  const p = action().finally(() => {
    if (inFlightDeployments.get(appUuid) === p) {
      inFlightDeployments.delete(appUuid);
    }
  });
  inFlightDeployments.set(appUuid, p);
  return p;
}

// ── types ────────────────────────────────────────────────

export type CoolifyRequestConfig = {
  apiToken: string;
  baseUrl: string;
};

type CoolifyAppStatus =
  | "running"
  | "running:unknown"
  | "restarting:unknown"
  | "exited:unhealthy"
  | string;

export type CoolifyApplication = {
  domains?: string | null;
  fqdn: string | null;
  name?: string | null;
  ports_exposes?: string | null;
  ports_mappings?: string | null;
  status: CoolifyAppStatus;
  uuid: string;
  limits_memory?: string | null;
  limits_memory_swap?: string | null;
  limits_memory_swappiness?: number | null;
  limits_memory_reservation?: string | null;
  limits_cpus?: string | null;
  limits_cpuset?: string | null;
  limits_cpu_shares?: number | null;
};

export type CoolifyApplicationEnv = {
  is_buildtime?: boolean | null;
  is_literal?: boolean | null;
  is_multiline?: boolean | null;
  is_preview?: boolean | null;
  is_runtime?: boolean | null;
  key: string;
  value: string;
};

export type CoolifyBulkEnvPayload = {
  isBuildtime?: boolean;
  isLiteral?: boolean;
  isMultiline?: boolean;
  isPreview?: boolean;
  isRuntime?: boolean;
  key: string;
  value: string;
};

type CoolifyDeployment = {
  logs: string | null;
  status: string;
};

type CoolifyProjectResponse = {
  environments?: Array<{ name?: string | null }>;
};

type CoolifyServerResponse = Array<{
  name?: string | null;
  settings?: {
    is_reachable?: boolean | null;
    is_usable?: boolean | null;
  } | null;
  uuid?: string | null;
}>;

export type CoolifyDockerImageTarget = {
  bootstrapCommandB64?: string;
  destinationUuid: string;
  image: string;
  packagePath: string;
  port: number;
  projectUuid: string;
  serverUuid?: string | null;
  sessionId: string;
  serviceName?: string;
  startCommand: string;
};

export type CoolifyPreviewUrls = {
  app: string;
  codeServer: string;
  health: string;
};

type CreateApplicationPayload = {
  destination_uuid: string;
  docker_registry_image_name: string;
  docker_registry_image_tag?: string;
  domains: string;
  environment_name: string;
  health_check_enabled: boolean;
  health_check_path: string;
  health_check_port?: number;
  health_check_protocol?: string;
  is_force_https_enabled: boolean;
  name: string;
  ports_exposes: string;
  project_uuid: string;
  server_uuid: string;
  start_command: string;
};

type CreateEnvPayload = {
  is_buildtime: boolean;
  is_literal: boolean;
  is_multiline: boolean;
  is_preview: boolean;
  is_runtime: boolean;
  is_shown_once: boolean;
  key: string;
  value: string;
};

type PatchApplicationRoutingPayload = {
  domains: string;
  health_check_enabled: boolean;
  health_check_path: string;
  health_check_port: number;
  is_force_https_enabled: boolean;
  ports_exposes: string;
};

// ── helpers ──────────────────────────────────────────────

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function buildHeaders(apiToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

async function coolifyRequest<T>(
  config: CoolifyRequestConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(`${normalizeBaseUrl(config.baseUrl)}${path}`, {
    ...init,
    headers: { ...buildHeaders(config.apiToken), ...init?.headers },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new CoolifyApiError(
      body || `Coolify API request failed with ${resp.status}`,
      resp.status,
    );
  }
  if (resp.status === 204) return undefined as T;
  try {
    return (await resp.json()) as T;
  } catch {
    throw new CoolifyApiError(
      `Coolify API returned ${resp.status} with unreadable body`,
      resp.status,
    );
  }
}

function parseDockerImageReference(image: string): {
  name: string;
  tag: string | undefined;
} {
  if (image.includes("@")) {
    const [name, digest] = image.split("@", 2);
    return {
      name,
      tag: digest ? digest.replace(/^sha256:/, "sha256-") : undefined,
    };
  }
  const li = image.lastIndexOf(":");
  const ls = image.lastIndexOf("/");
  if (li > ls) {
    return { name: image.slice(0, li), tag: image.slice(li + 1) };
  }
  return { name: image, tag: undefined };
}

function getApplicationSubdomain(
  sessionId: string,
  packagePath: string,
): string {
  const sessionPrefix = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
  const packageSuffix = packagePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  const entropy = randomUUID().replaceAll("-", "").slice(0, 6);
  return [sessionPrefix || "session", packageSuffix || "app", entropy].join(
    "-",
  );
}

function buildPreviewUrls(
  baseUrl: string,
  sessionId: string,
  packagePath: string,
): CoolifyPreviewUrls {
  const base = new URL(baseUrl);
  const subdomain = getApplicationSubdomain(sessionId, packagePath);
  const healthPort = Number(
    process.env.COOLIFY_HEALTH_PORT ?? String(DEFAULT_HEALTH_PORT),
  );
  return {
    app: `https://${subdomain}.${base.hostname}`,
    health: `https://${subdomain}-health.${base.hostname}:${healthPort}`,
    codeServer: `https://${subdomain}-ide.${base.hostname}:${CODE_SERVER_PORT}`,
  };
}

function normalizePreviewUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function stripPortFromPreviewUrl(value: string): string {
  const url = new URL(normalizePreviewUrl(value));
  url.port = "";
  return url.toString().replace(/\/$/, "");
}

function buildRoutedPreviewDomains(
  urls: CoolifyPreviewUrls,
  appPort: number,
  healthPort: number,
): string {
  return [
    stripPortFromPreviewUrl(urls.app),
    `${stripPortFromPreviewUrl(urls.codeServer)}:${CODE_SERVER_PORT}`,
    `${stripPortFromPreviewUrl(urls.health)}:${healthPort}`,
  ].join(",");
}

function resolveCoolifyPreviewUrls(
  domains: string | null | undefined,
  fallback: CoolifyPreviewUrls,
): CoolifyPreviewUrls {
  if (!domains) return fallback;
  const candidates = domains
    .split(",")
    .map(normalizePreviewUrl)
    .filter((v) => v.length > 0);
  if (candidates.length === 0) return fallback;
  return {
    app: stripPortFromPreviewUrl(
      candidates.find((v) => !v.includes("-health.") && !v.includes("-ide.")) ??
        fallback.app,
    ),
    health: stripPortFromPreviewUrl(
      candidates.find((v) => v.includes("-health.")) ?? fallback.health,
    ),
    codeServer: stripPortFromPreviewUrl(
      candidates.find((v) => v.includes("-ide.")) ?? fallback.codeServer,
    ),
  };
}

function getCoolifyApplicationDomains(
  app: CoolifyApplication | null | undefined,
): string | null {
  if (typeof app?.domains === "string" && app.domains.length > 0) {
    return app.domains;
  }
  return app?.fqdn ?? null;
}

function isCoolifyServerUsable(
  s: CoolifyServerResponse[number] | null | undefined,
): boolean {
  return Boolean(
    s?.uuid &&
    s.settings?.is_usable !== false &&
    s.settings?.is_reachable !== false,
  );
}

// ── self-signed TLS probing ──────────────────────────────

function isSelfSignedTlsError(error: Error): boolean {
  const e = error as Error & { cause?: { code?: string }; code?: string };
  return (
    e.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    e.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  );
}

async function probeUrlWithoutTlsValidation(
  url: string,
  redirectCount: number,
): Promise<boolean> {
  if (redirectCount > 3) return false;
  const target = new URL(url);
  return new Promise((resolve) => {
    const req =
      target.protocol === "https:"
        ? https.request(target, { method: "GET", rejectUnauthorized: false })
        : http.request(target, { method: "GET" });
    req.setTimeout(5_000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("response", (resp) => {
      const sc = resp.statusCode ?? 0;
      const loc = resp.headers.location;
      resp.resume();
      if (sc >= 300 && sc < 400 && typeof loc === "string") {
        resolve(
          probeUrlWithoutTlsValidation(
            new URL(loc, target).toString(),
            redirectCount + 1,
          ),
        );
        return;
      }
      resolve(sc >= 200 && sc < 300);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function probeUrl(url: string): Promise<boolean> {
  const resp = await fetch(url, { method: "GET", redirect: "follow" }).catch(
    () => null,
  );
  if (resp) return resp.ok;
  return probeUrlWithoutTlsValidation(url, 0);
}

// ── deployment log helpers ───────────────────────────────

function extractLogMessages(logs: string | null): string[] {
  if (!logs) return [];
  try {
    const parsed = JSON.parse(logs) as Array<{ output?: string }>;
    return parsed.flatMap((e) => {
      const m = e.output?.trim();
      return m ? [m] : [];
    });
  } catch {
    return [logs];
  }
}

function isOpaqueDeployMessage(message: string): boolean {
  const n = message.trim();
  if (n.length === 0) return true;
  return /^[a-z0-9_-]{8,}$/i.test(n);
}

const DOCKER_DEPRECATION_PATTERNS = [
  /flag --time has been deprecated, use --timeout instead/i,
  /flag --time is deprecated/i,
  /--time.*deprecated/i,
];

function isDockerDeprecationMessage(message: string): boolean {
  return DOCKER_DEPRECATION_PATTERNS.some((p) => p.test(message.trim()));
}

function isBenignDeployMessage(message: string): boolean {
  const n = message.trim().toLowerCase();
  return n === "rolling update completed." || n === "rolling update completed";
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── env helpers ──────────────────────────────────────────

export async function setCoolifyAppEnv(
  config: CoolifyRequestConfig,
  appUuid: string,
  key: string,
  value: string,
  opts?: { isBuildtime?: boolean; isLiteral?: boolean },
): Promise<void> {
  const payload: CreateEnvPayload = {
    is_buildtime: opts?.isBuildtime ?? false,
    is_literal: opts?.isLiteral ?? true,
    is_multiline: false,
    is_preview: false,
    is_runtime: true,
    is_shown_once: false,
    key,
    value,
  };
  await coolifyRequest(config, `/v1/applications/${appUuid}/envs`, {
    body: JSON.stringify(payload),
    method: "POST",
  });
}

async function patchCoolifyRouting(
  config: CoolifyRequestConfig,
  appUuid: string,
  payload: PatchApplicationRoutingPayload,
): Promise<void> {
  await coolifyRequest(config, `/v1/applications/${appUuid}`, {
    body: JSON.stringify(payload),
    method: "PATCH",
  });
}

// ── public API ───────────────────────────────────────────

export async function getCoolifyEnvironmentName(
  config: CoolifyRequestConfig,
  projectUuid: string,
): Promise<string> {
  const proj = await coolifyRequest<CoolifyProjectResponse>(
    config,
    `/v1/projects/${projectUuid}`,
  );
  const env = proj.environments?.[0]?.name?.trim();
  return env && env.length > 0 ? env : "production";
}

export async function getCoolifyServerUuid(
  config: CoolifyRequestConfig,
): Promise<string> {
  const servers = await coolifyRequest<CoolifyServerResponse>(
    config,
    "/v1/servers",
  );
  const usable = servers.find(isCoolifyServerUsable);
  if (!usable?.uuid)
    throw new CoolifyApiError("Coolify server is not available", 503);
  return usable.uuid;
}

export async function validateCoolifyServerUuid(
  config: CoolifyRequestConfig,
  serverUuid: string,
): Promise<string> {
  const servers = await coolifyRequest<CoolifyServerResponse>(
    config,
    "/v1/servers",
  );
  const server = servers.find((c) => c.uuid === serverUuid);
  if (!server) throw new CoolifyApiError("Coolify server was not found", 404);
  if (!isCoolifyServerUsable(server)) {
    const label = server.name?.trim() || server.uuid;
    throw new CoolifyApiError(`Coolify server ${label} is not available`, 503);
  }
  return server.uuid!;
}

export async function getCoolifyApplication(
  config: CoolifyRequestConfig,
  appUuid: string,
): Promise<CoolifyApplication | null> {
  try {
    return await coolifyRequest<CoolifyApplication>(
      config,
      `/v1/applications/${appUuid}`,
    );
  } catch (error) {
    if (error instanceof CoolifyApiError && error.status === 404) return null;
    throw error;
  }
}

export async function getCoolifyApplicationEnvs(
  config: CoolifyRequestConfig,
  appUuid: string,
): Promise<CoolifyApplicationEnv[]> {
  return coolifyRequest<CoolifyApplicationEnv[]>(
    config,
    `/v1/applications/${appUuid}/envs`,
  );
}

export async function bulkUpdateCoolifyApplicationEnvs(
  config: CoolifyRequestConfig,
  appUuid: string,
  envs: CoolifyBulkEnvPayload[],
): Promise<void> {
  await coolifyRequest(config, `/v1/applications/${appUuid}/envs/bulk`, {
    body: JSON.stringify({
      data: envs.map((env) => ({
        is_buildtime: env.isBuildtime ?? false,
        is_literal: env.isLiteral ?? true,
        is_multiline: env.isMultiline ?? false,
        is_preview: env.isPreview ?? false,
        is_runtime: env.isRuntime ?? true,
        key: env.key,
        value: env.value,
      })),
    }),
    method: "PATCH",
  });
}

export async function createCoolifyDockerImageApplication(
  config: CoolifyRequestConfig,
  target: CoolifyDockerImageTarget,
): Promise<{ applicationUuid: string; urls: CoolifyPreviewUrls }> {
  const serverUuid = target.serverUuid
    ? await validateCoolifyServerUuid(config, target.serverUuid)
    : await getCoolifyServerUuid(config);
  const environmentName = await getCoolifyEnvironmentName(
    config,
    target.projectUuid,
  );
  const image = parseDockerImageReference(target.image);
  const urls = buildPreviewUrls(
    config.baseUrl,
    target.sessionId,
    target.packagePath,
  );
  const healthPort = Number(
    process.env.COOLIFY_HEALTH_PORT ?? String(DEFAULT_HEALTH_PORT),
  );
  const routedDomains = buildRoutedPreviewDomains(
    urls,
    target.port,
    healthPort,
  );

  const payload: CreateApplicationPayload = {
    destination_uuid: target.destinationUuid,
    docker_registry_image_name: image.name,
    ...(image.tag ? { docker_registry_image_tag: image.tag } : {}),
    domains: routedDomains,
    environment_name: environmentName,
    health_check_enabled: true,
    health_check_path: "/health",
    health_check_port: healthPort,
    is_force_https_enabled: true,
    name:
      target.serviceName?.trim() ||
      `open-agents-${target.sessionId.slice(0, 12)}`,
    ports_exposes: String(
      [target.port, CODE_SERVER_PORT, healthPort].join(","),
    ),
    project_uuid: target.projectUuid,
    server_uuid: serverUuid,
    start_command: target.startCommand,
  };

  const created = await coolifyRequest<{ domains?: string; uuid: string }>(
    config,
    "/v1/applications/dockerimage",
    { body: JSON.stringify(payload), method: "POST" },
  );
  const resolvedUrls = resolveCoolifyPreviewUrls(created.domains, urls);

  // Set bootstrap command if provided
  if (target.bootstrapCommandB64) {
    await setCoolifyAppEnv(
      config,
      created.uuid,
      "OA_BOOTSTRAP_B64",
      target.bootstrapCommandB64,
      {
        isLiteral: false,
      },
    );
  }

  // Set PORT env
  try {
    await setCoolifyAppEnv(config, created.uuid, "PORT", String(target.port));
  } catch (error) {
    console.warn(
      `Failed to set PORT env on Coolify app ${created.uuid}:`,
      error,
    );
  }

  // Patch routing
  try {
    await patchCoolifyRouting(config, created.uuid, {
      domains: buildRoutedPreviewDomains(resolvedUrls, target.port, healthPort),
      health_check_enabled: true,
      health_check_path: "/health",
      health_check_port: healthPort,
      is_force_https_enabled: true,
      ports_exposes: String(
        [target.port, CODE_SERVER_PORT, healthPort].join(","),
      ),
    });
  } catch (error) {
    console.warn(
      `Failed to patch routing on Coolify app ${created.uuid}:`,
      error,
    );
  }

  // Set SANDBOX_URL_* env vars
  for (const [key, value] of [
    [`SANDBOX_URL_${target.port}`, resolvedUrls.app],
    [`SANDBOX_URL_${healthPort}`, resolvedUrls.health],
    [`SANDBOX_URL_${CODE_SERVER_PORT}`, resolvedUrls.codeServer],
  ]) {
    try {
      await setCoolifyAppEnv(config, created.uuid, key, value);
    } catch (error) {
      console.warn(
        `Failed to set ${key} env on Coolify app ${created.uuid}:`,
        error,
      );
    }
  }

  return { applicationUuid: created.uuid, urls: resolvedUrls };
}

export async function startCoolifyApplication(
  config: CoolifyRequestConfig,
  appUuid: string,
): Promise<string> {
  return dedupeDeployment(appUuid, () =>
    coolifyRequest<{ deployment_uuid: string }>(
      config,
      `/v1/applications/${appUuid}/start`,
      { method: "POST" },
    ).then((r) => r.deployment_uuid),
  );
}

export async function stopCoolifyApplication(
  config: CoolifyRequestConfig,
  appUuid: string,
): Promise<string> {
  return dedupeDeployment(appUuid, () =>
    coolifyRequest<{ deployment_uuid: string }>(
      config,
      `/v1/applications/${appUuid}/stop`,
      { method: "POST" },
    ).then((r) => r.deployment_uuid),
  );
}

export async function restartCoolifyApplication(
  config: CoolifyRequestConfig,
  appUuid: string,
): Promise<string> {
  return dedupeDeployment(appUuid, () =>
    coolifyRequest<{ deployment_uuid: string }>(
      config,
      `/v1/applications/${appUuid}/restart`,
      { method: "POST" },
    ).then((r) => r.deployment_uuid),
  );
}

export async function patchCoolifyApplication(
  config: CoolifyRequestConfig,
  appUuid: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await coolifyRequest(config, `/v1/applications/${appUuid}`, {
    body: JSON.stringify(payload),
    method: "PATCH",
  });
}

export async function deleteCoolifyApplication(
  config: CoolifyRequestConfig,
  appUuid: string,
): Promise<void> {
  await coolifyRequest(config, `/v1/applications/${appUuid}`, {
    method: "DELETE",
  });
}

// ── deployment waiting ───────────────────────────────────

export async function waitForCoolifyDeployment(
  config: CoolifyRequestConfig,
  deploymentUuid: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const deployment = await coolifyRequest<CoolifyDeployment>(
      config,
      `/v1/deployments/${deploymentUuid}`,
    );
    if (deployment.status === "finished") {
      const messages = extractLogMessages(deployment.logs);
      const serverError = messages.find((m) =>
        m.includes("Server is not functional."),
      );
      if (serverError) {
        throw new CoolifyApiError(
          `${serverError} (deployment=${deploymentUuid})`,
          503,
        );
      }
      return;
    }
    if (deployment.status === "failed" || deployment.status === "cancelled") {
      const messages = extractLogMessages(deployment.logs);
      const meaningful = [...messages]
        .toReversed()
        .find(
          (m) =>
            !isOpaqueDeployMessage(m) &&
            !isBenignDeployMessage(m) &&
            !isDockerDeprecationMessage(m),
        );
      if (!meaningful) return; // all benign — treat as success
      throw new CoolifyApiError(meaningful, 502);
    }
    await wait(2_000);
  }
  throw new CoolifyApiError("Timed out waiting for Coolify deployment", 504);
}

export async function waitForCoolifyPreview(
  config: CoolifyRequestConfig,
  appUuid: string,
  urls: CoolifyPreviewUrls,
): Promise<CoolifyPreviewUrls> {
  const deadline = Date.now() + 180_000;
  let healthyStreak = 0;

  while (Date.now() < deadline) {
    const app = await getCoolifyApplication(config, appUuid);
    if (!app)
      throw new CoolifyApiError("Coolify application no longer exists", 404);

    healthyStreak = app.status === "running:healthy" ? healthyStreak + 1 : 0;
    const routedDomains = getCoolifyApplicationDomains(app);
    const resolved = resolveCoolifyPreviewUrls(routedDomains, urls);

    // Try primary app URLs first
    for (const target of [`${resolved.app}/health`, resolved.app]) {
      if (await probeUrl(target)) return resolved;
    }

    // Also probe health endpoint (necessary but not sufficient alone)
    for (const target of [`${resolved.health}/health`, resolved.health]) {
      if (await probeUrl(target)) break;
    }

    if (healthyStreak >= 3) return resolved;
    await wait(5_000);
  }

  throw new CoolifyApiError("Timed out waiting for Coolify preview URLs", 504);
}

export async function waitForCoolifyHealthUrl(
  config: CoolifyRequestConfig,
  appUuid: string,
  healthUrl: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const app = await getCoolifyApplication(config, appUuid);
    if (!app)
      throw new CoolifyApiError("Coolify application no longer exists", 404);

    if (app.status === "exited:unhealthy") {
      throw new CoolifyApiError(
        "Coolify application exited with unhealthy status",
        503,
      );
    }

    if (await probeUrl(healthUrl)) return;
    await wait(3_000);
  }
  throw new CoolifyApiError("Timed out waiting for Coolify health URL", 504);
}
