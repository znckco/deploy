export interface CreateAppOptions {
  name: string;
  domain: string;
  email?: string;
  repository?: string;
  domainAliases?: string[];
  healthcheck?: string;
  maxReleases?: number;
  maxDeploymentHistory?: number;
}
