type OpaqueId<T, K extends number | string> = K & { __type: T };
export type ReleaseId = OpaqueId<"Release", number>;
export function parseReleaseId(id: string | number): ReleaseId {
  return Number(id) as ReleaseId;
}
export type AppInstanceId = OpaqueId<"AppInstance", string>;
export function parseAppInstanceId(id: string | number): AppInstanceId {
  return String(id) as AppInstanceId;
}
