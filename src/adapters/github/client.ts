import { Octokit } from "@octokit/rest";
import { logger } from "../../utils/logger.js";

let instance: Octokit | null = null;

export function getOctokit(): Octokit {
  if (instance) return instance;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN must be set for GitHub operations");
  }

  instance = new Octokit({ auth: token });
  logger.info("GitHub client initialized");
  return instance;
}

export function isGitHubWriteEnabled(): boolean {
  return process.env.ENABLE_GITHUB_WRITE === "true";
}
