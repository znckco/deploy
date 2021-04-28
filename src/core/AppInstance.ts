import { ReleaseId, AppInstanceId } from "./Id";
import { DateString } from "./helpers";

export interface AppInstance {
  id: AppInstanceId;
  preview: string;

  internal: {
    directory: string;
    port: number;
    logs: string;
    errors: string;
  };

  releaseId: ReleaseId;
  createdAt: DateString;
}
