import { AppManager } from "./AppManager";
import { AppManifest } from "./AppManifest";
import { CreateAppOptions } from "./CreateAppOptions";
import { Exception, FileNotFoundException, quote } from "./helpers";
import { HostConfig } from "./HostConfig";
import { SSHClient } from "./SSHClient";

export class DeploymentManager {
  constructor(private readonly server: HostConfig) {}

  private readonly appsDir = this.server.appsDirectory ?? "/apps";
  private readonly sh = new SSHClient(this.server);

  async info(): Promise<Record<string, string | null>> {
    const node = await this.sh.execNoFail(`node --version`);
    const npm = await this.sh.execNoFail(`npm --version`);
    const tar = await this.sh.execNoFail(`tar --version`);
    const nginx = await this.sh.execNoFail(`nginx -v 2>&1`);
    const curl = await this.sh.execNoFail(`curl --version`);
    const user = await this.sh.execNoFail(`id -u appuser`);
    const supervisor = await this.sh.execNoFail(`supervisord --version`);
    const certbot = await this.sh.execNoFail(`certbot --version`);

    return { node, npm, tar, nginx, curl, user, certbot, supervisor };
  }

  async apps(): Promise<string[]> {
    if (await this.sh.exists(this.appsDir)) {
      const files = await this.sh.ls(this.appsDir);
      const prefixLength = this.appsDir.length + 1;

      return files.map((file) => file.substr(prefixLength));
    }
    return [];
  }

  async connect(app: string): Promise<AppManager> {
    try {
      const manifestFile = `${this.appsDir}/${app}/deploy.json`;
      const manifest = await this.sh.readJSON<AppManifest>(manifestFile);

      return new AppManager(manifest, manifestFile, this.sh);
    } catch (error) {
      if (error instanceof FileNotFoundException) {
        throw new Exception("AppNotFound", `No such app: ${quote(app)}`);
      }

      throw error;
    }
  }

  async create(options: CreateAppOptions): Promise<AppManager> {
    if (await this.sh.exists(`${this.appsDir}/${options.name}/deploy.json`)) {
      throw new Exception("DuplicateApp", `Another app with name (${quote(options.name)}) already exists.`);
    }

    const manifest: AppManifest = {
      name: options.name,
      repository: options.repository ?? "",
      domain: {
        email: options.email ?? `certbot-notif@${options.domain}`,
        primary: options.domain,
        aliases: options.domainAliases ?? [],
      },
      healthcheck: options.healthcheck ?? "curl -sSf http://localhost:${PORT}/health",
      releases: [],
      deployments: {
        current: [],
        history: [],
      },
      changelog: [],
      config: {
        maxReleases: options.maxReleases ?? 10,
        maxDeploymentHistory: options.maxDeploymentHistory ?? 100,
      },
      env: [],
    };

    await this.check();
    await this.sh.mkdir(`/apps/${manifest.name}`);
    await this.sh.mkdir(`/apps/${manifest.name}/releases`);
    await this.sh.mkdir(`/apps/${manifest.name}/deployments`);
    await this.sh.write(`/apps/${manifest.name}/.env`, ``);
    await this.sh.write(`/apps/${manifest.name}/deploy.json`, JSON.stringify(manifest, null, 2));

    const connection = await this.connect(manifest.name);

    await connection.createCertificates();

    return connection;
  }

  async check(): Promise<void> {
    const tools = Object.entries(await this.info())
      .filter(([_, version]) => version == null)
      .map(([tool]) => tool);

    if (tools.length > 0) {
      throw new Exception("UnsupportedServer", `Missing required programs: ${tools.join(", ")}`);
    }
  }
}
