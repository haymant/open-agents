/**
 * Coolify workspace orchestrator.
 *
 * Handles provisioning Coolify-backed sandbox sessions:
 * 1. Create a Coolify Docker-image application
 * 2. Start the application
 * 3. Wait for deployment to complete
 * 4. Wait for the health URL to respond
 * 5. Return the sandbox state with preview URLs
 */

import { nanoid } from "nanoid";
import {
  createCoolifyDockerImageApplication,
  startCoolifyApplication,
  waitForCoolifyDeployment,
  waitForCoolifyPreview,
  stopCoolifyApplication,
  type CoolifyRequestConfig,
  type CoolifyPreviewUrls as ApiPreviewUrls,
} from "./coolify-api";
import {
  getCoolifyConnectorConfig,
  validateCoolifyConnectorConfig,
  type CoolifyConnectorConfig,
} from "./coolify-connector";
import type {
  CoolifyState,
  CoolifyPreviewUrls,
} from "@open-agents/sandbox-coolify/sandbox";

// ── types ────────────────────────────────────────────────

export interface CoolifyProvisionParams {
  /** Connector config ID (e.g., "default") */
  connectorId: string;
  /** Session ID for naming */
  sessionId: string;
  /** Optional GitHub repo URL to clone */
  repoUrl?: string;
  /** Optional branch to checkout */
  branch?: string;
  /** Port the application listens on inside the container */
  port?: number;
}

export interface CoolifyProvisionResult {
  state: CoolifyState;
  /** Time in ms when the sandbox was provisioned */
  provisionedAt: number;
}

// ── defaults ─────────────────────────────────────────────

const DEFAULT_APP_PORT = 3000;
const DEFAULT_START_COMMAND = "node /app/fs.js";
const DEFAULT_PACKAGE_PATH = "headless";

// ── orchestrator ─────────────────────────────────────────

export async function provisionCoolifyWorkspace(
  params: CoolifyProvisionParams,
): Promise<CoolifyProvisionResult> {
  const config = getCoolifyConnectorConfig(params.connectorId);
  if (!config) {
    throw new Error(
      `Coolify connector "${params.connectorId}" not found. Set TEST_COOLIFY_* or COOLIFY_* env vars.`,
    );
  }

  const validationError = validateCoolifyConnectorConfig(config);
  if (validationError) throw new Error(validationError);

  const apiConfig: CoolifyRequestConfig = {
    apiToken: config.apiToken,
    baseUrl: config.baseUrl,
  };

  const appPort = params.port ?? DEFAULT_APP_PORT;

  // 1. Create the Coolify Docker-image application
  const { applicationUuid, urls } = await createCoolifyDockerImageApplication(
    apiConfig,
    {
      destinationUuid: config.destinationUuid,
      image: config.dockerImage,
      packagePath: DEFAULT_PACKAGE_PATH,
      port: appPort,
      projectUuid: config.projectUuid,
      serverUuid: config.serverUuid ?? null,
      sessionId: params.sessionId,
      startCommand: DEFAULT_START_COMMAND,
    },
  );

  // 2. Start the application
  const deploymentUuid = await startCoolifyApplication(
    apiConfig,
    applicationUuid,
  );

  // 3. Wait for deployment
  await waitForCoolifyDeployment(apiConfig, deploymentUuid);

  // 4. Wait for preview URLs (app + health) with TLS fallback probing
  const resolvedUrls = await waitForCoolifyPreview(
    apiConfig,
    applicationUuid,
    urls,
  );

  // Build the final state
  const previewUrls: CoolifyPreviewUrls = {
    app: resolvedUrls.app,
    health: resolvedUrls.health,
    codeServer: resolvedUrls.codeServer,
  };

  const state: CoolifyState = {
    type: "coolify",
    connectorConfigId: config.id,
    connectorName: config.name,
    coolifyApplicationId: applicationUuid,
    coolifyApplicationUrl: resolvedUrls.app,
    coolifyPreviewUrls: previewUrls,
    sandboxName: `coolify-${params.sessionId}`,
    sandboxId: params.sessionId,
  };

  return {
    state,
    provisionedAt: Date.now(),
  };
}

/**
 * Stop and clean up a Coolify workspace.
 */
export async function deprovisionCoolifyWorkspace(
  connectorId: string,
  applicationUuid: string,
): Promise<void> {
  const config = getCoolifyConnectorConfig(connectorId);
  if (!config) {
    console.warn(
      `Coolify connector "${connectorId}" not found; cannot deprovision app ${applicationUuid}`,
    );
    return;
  }

  const apiConfig: CoolifyRequestConfig = {
    apiToken: config.apiToken,
    baseUrl: config.baseUrl,
  };

  try {
    await stopCoolifyApplication(apiConfig, applicationUuid);
  } catch (error) {
    console.warn(
      `Failed to stop Coolify app ${applicationUuid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
