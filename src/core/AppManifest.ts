import { AppInstance } from "./AppInstance";
import { DeploymentHistoryItem } from "./DeploymentHistoryItem";
import { DateString } from "./helpers";
import { AppInstanceId } from "./Id";
import { Release } from "./Release";

export interface AppManifest {
  name: string;
  repository: string;

  domain: {
    email: string;
    primary: string;
    aliases: string[];
  };

  healthcheck: string;

  releases: Release[];

  deployments: {
    active?: AppInstanceId;
    current: AppInstance[];
    history: DeploymentHistoryItem[];
  };

  changelog: Array<{
    info: string;
    message: string;
    timestamp: DateString;
  }>;

  config: {
    maxReleases: number;
    maxDeploymentHistory: number;
  };

  env: string[];
}
