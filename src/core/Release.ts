import { ReleaseId } from "./Id";
import { DateString } from "./helpers";

export interface Release {
  id: ReleaseId;
  commit: string;
  tag: string;
  createdAt: DateString;
}
