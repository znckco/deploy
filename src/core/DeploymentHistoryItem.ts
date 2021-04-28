import { AppInstanceId } from "./Id";
import { DateString } from "./helpers";

export interface DeploymentHistoryItem {
  active?: AppInstanceId;
  deployments: AppInstanceId[];
  createdAt: DateString;
}
