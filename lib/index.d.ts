export interface HostConfig {
    host: string;
    port?: number;
    user?: string;
    privateKey?: string;
    appsDirectory?: string;
}
export declare class SSHClient {
    private readonly server;
    constructor(server: HostConfig);
    ls(expr: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    exists(file: string): Promise<boolean>;
    read(file: string): Promise<string>;
    write(file: string, contents: string): Promise<void>;
    readJSON<T extends Record<string, any> = any>(file: string): Promise<T>;
    upload(localFile: string, remoteFile: string): Promise<void>;
    exec(script: string): Promise<string>;
    execNoFail(script: string): Promise<string | null>;
}
interface AppManifest {
    name: string;
    repository: string;
    domain: {
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
declare type OpaqueId<T, K extends number | string> = K & {
    __type: T;
};
declare type ReleaseId = OpaqueId<"Release", number>;
declare type AppInstanceId = OpaqueId<"AppInstance", string>;
declare type DateString = string;
interface Release {
    id: number;
    commit: string;
    version: string;
    createdAt: DateString;
}
interface AppInstance {
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
interface DeploymentHistoryItem {
    active?: AppInstanceId;
    deployments: AppInstanceId[];
    createdAt: DateString;
}
declare class AppManager {
    readonly app: AppManifest;
    private readonly manifest;
    private readonly sh;
    constructor(app: AppManifest, manifest: string, sh: SSHClient);
    private readonly appDir;
    private saveManifest;
    private withManifestSync;
    createRelease(options: Pick<Release, "commit" | "version">, asset: string): Promise<Release>;
    private log;
    setEnv(key: string, value: string): Promise<void>;
    instances(): Promise<AppInstance[]>;
    getInstance(instanceId: AppInstanceId): Promise<AppInstance | undefined>;
    current(): Promise<AppInstance | undefined>;
    createInstance(releaseId: ReleaseId): Promise<AppInstance>;
    start(instanceId: AppInstanceId): Promise<void>;
    restart(instanceId: AppInstanceId): Promise<void>;
    status(instanceId: AppInstanceId): Promise<string>;
    stop(instanceId: AppInstanceId): Promise<void>;
    destroy(instanceId: AppInstanceId): Promise<void>;
    private createHistoryItem;
    logs(instanceId: AppInstanceId): Promise<ReadableStream>;
    deploy(instanceId: AppInstanceId): Promise<DeploymentHistoryItem>;
    rollback(): Promise<DeploymentHistoryItem>;
}
interface CreateAppOptions {
    name: string;
    domain: string;
    repository?: string;
    domainAliases?: string[];
    healthcheck?: string;
    maxReleases?: number;
    maxDeploymentHistory?: number;
}
export declare class DeploymentManager {
    private readonly server;
    constructor(server: HostConfig);
    private readonly appsDir;
    private readonly sh;
    info(): Promise<Record<string, string | null>>;
    apps(): Promise<string[]>;
    connect(app: string): Promise<AppManager>;
    create(options: CreateAppOptions): Promise<AppManager>;
    private check;
}
export declare function cli(args: string[]): Promise<void>;
export {};
