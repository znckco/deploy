import chalk from "chalk";
import * as CP from "child_process";
import * as FS from "fs";
import * as OS from "os";
import * as Path from "path";
import * as Util from "util";
import { AppInstance } from "./AppInstance";
import { AppManifest } from "./AppManifest";
import { DeploymentHistoryItem } from "./DeploymentHistoryItem";
import { areObjectsEqual, Exception, getCreatedAt, importJSON, quote, uuid } from "./helpers";
import { AppInstanceId, ReleaseId } from "./Id";
import { Release } from "./Release";
import { SSHClient } from "./SSHClient";

export class AppManager {
  constructor(public readonly app: AppManifest, private readonly manifest: string, private readonly sh: SSHClient) {}

  private readonly appDir = Path.dirname(this.manifest);

  private async saveManifest(): Promise<void> {
    await this.sh.write(this.manifest, JSON.stringify(this.app, null, 2));
  }

  private async withManifestSync<T>(fn: () => Promise<T>): Promise<T> {
    const app = JSON.parse(JSON.stringify(this.app));

    try {
      const result = await fn();
      await this.saveManifest();
      return result;
    } catch (error) {
      if (!areObjectsEqual(app, this.app)) {
        FS.promises.writeFile(
          "deploy-debug.log",
          [
            `===== Current Manifest ====`,
            JSON.stringify(app, null, 2),
            `===== Unsaved Manifest ====`,
            JSON.stringify(this.app, null, 2),
          ].join("\n") + "\n",
        );
        console.warn(chalk.yellow(chalk.bold("CommandFailure: ", "reverting app manifest to previous state.")));
      }

      throw error;
    }
  }

  // -- Release Management
  async createCertificates(): Promise<void> {
    const cmd = (await this.instances()).length > 0 ? "run --installer nginx" : "certonly";
    const args = `-n --agree-tos --dns-digitalocean --dns-digitalocean-credentials /root/.secrets/certbot/digitalocean.ini`;
    const certFile = (domain: string) => `/etc/letsencrypt/live/${domain}/fullchain.pem`;
    const certbot = (domain: string, wildCard = true) =>
      `test -f ${quote(certFile(domain))} || certbot ${cmd} ${args} -m ${quote(this.app.domain.email)} -d ${quote(
        domain,
      )} ${wildCard ? `-d ${quote(`*.${domain}`)}` : ""};`;

    await this.sh.exec(
      [certbot(this.app.domain.primary), ...this.app.domain.aliases.map((alias) => certbot(alias))].join("\n"),
    );
  }

  async createRelease(options: Pick<Release, "commit" | "tag">, asset: string): Promise<Release> {
    if (!Path.isAbsolute(asset)) asset = Path.resolve(process.cwd(), asset);
    const stat = await FS.promises.stat(asset);
    let assetFilename = asset;
    let shouldUnlinkAssetFile = false;
    if (stat.isFile()) {
      const { stderr } = await Util.promisify(CP.exec)(`tar -tzf  ${quote(asset)}`);
      if (stderr.trim().length > 0) {
        throw new Exception("InvalidArchive", stderr);
      }
    } else if (stat.isDirectory()) {
      const pkg = await importJSON<{ name: string; version: string }>(Path.resolve(asset, "package.json"));
      assetFilename = Path.resolve(asset, `${pkg.name}-${pkg.version}.tgz`.replace("@", "").replace("/", "-"));
      const cmd = `npm pack`;
      console.log(chalk.gray(chalk.bold("Execute (localhost): "), cmd));
      const { stderr } = await Util.promisify(CP.exec)(cmd, {
        env: { ...process.env, COPYFILE_DISABLE: "true" },
        cwd: asset,
      });

      if (stderr.trim().length > 0) {
        throw new Exception("InvalidArchive", stderr);
      }
    }

    const release: Release = {
      id: (this.app.releases.length > 0 ? this.app.releases[0].id + 1 : 1) as ReleaseId,
      commit: options.commit,
      tag: options.tag,
      createdAt: getCreatedAt(),
    };

    return this.withManifestSync(async () => {
      await this.sh.upload(assetFilename, Path.join(this.appDir, "releases", `v${release.id}.tar.gz`));
      if (shouldUnlinkAssetFile) await FS.promises.unlink(assetFilename);

      this.log(
        `Create release v${release.id} from ${this.app.repository}/commit/${release.commit} (version: ${release.tag})`,
      );
      this.app.releases.unshift(release);

      return release;
    });
  }

  private log(line: string): void {
    this.app.changelog.push({
      info: `${OS.userInfo().username}@${OS.hostname()}`,
      message: line,
      timestamp: getCreatedAt(),
    });
  }

  async setEnv(key: string, value: string): Promise<void> {
    return this.withManifestSync(async () => {
      if (!/^[a-z][a-z0-9_]*$/.test(key))
        throw new Exception(
          "InvalidEnvironmentVariableName",
          `Invalid characters in environment variable name: ${key}`,
        );
      await this.sh.exec(
        [
          `sed -i ${quote(`/^${key}=.*$//g`)} ${this.appDir}/.env`,
          `echo ${quote(`${key}=${quote(value)}\n`)} >> ${this.appDir}/.env`,
        ].join("\n"),
      );

      if (!this.app.env.includes(key)) {
        this.app.env.push(key);
        this.log(`Set environment variables ${quote(key)}`);
      } else {
        this.log(`Update environment variables ${quote(key)}`);
      }
    });
  }

  // -- Instance Management
  async instances(): Promise<AppInstance[]> {
    return this.app.deployments.current;
  }

  async getInstance(instanceId: AppInstanceId): Promise<AppInstance | undefined> {
    return this.app.deployments.current.find((instance) => instance.id === instanceId);
  }

  async getInstancesByReleaseId(releaseId: ReleaseId): Promise<AppInstance[]> {
    return this.app.deployments.current.filter((instance) => instance.releaseId === releaseId);
  }

  async getRelease(releaseId: ReleaseId): Promise<Release | undefined> {
    return this.app.releases.find((release) => release.id === releaseId);
  }

  async getReleasesByTag(tag: string): Promise<Release[]> {
    return this.app.releases.filter((release) => release.tag === tag);
  }

  async current(): Promise<AppInstance | undefined> {
    const id = this.app.deployments.active;
    if (id != null) {
      return this.app.deployments.current.find((instance) => instance.id === id);
    }
  }

  async createInstance(releaseId: ReleaseId): Promise<AppInstance> {
    const release = this.app.releases.find((release) => release.id);
    if (release == null) throw new Exception("UnknownRelease", `Cannot find release v${releaseId}`);

    return this.withManifestSync(async () => {
      const id = uuid<AppInstanceId>();
      const usedPorts = this.app.deployments.current.map((instance) => instance.internal.port);
      usedPorts.sort((a, b) => a - b);
      let port = 3000;
      for (const usedPort of usedPorts) {
        if (usedPort > port) break;
        port++;
      }

      const directory = `${this.appDir}/instances/${id}`;
      const logs = `/var/log/${this.app.name}/${id}.log`;
      const errors = `/var/log/${this.app.name}/${id}-error.log`;
      const instance: AppInstance = {
        id: id,
        releaseId: releaseId,
        preview: `https://preview-${id}.${this.app.domain.primary}/`,
        createdAt: getCreatedAt(),
        internal: {
          directory,
          port,
          logs,
          errors,
        },
      };

      const artefact = `${this.appDir}/releases/v${releaseId}.tar.gz`;
      if (!(await this.sh.exists(artefact))) {
        throw new Exception("MissingReleaseArtefact", `Cannot find artefact for release v${releaseId}`);
      }

      const supervisorFile = `/etc/supervisor/conf.d/${this.app.name}-${id}.conf`;
      const supervisorConfig =
        [
          `[program:${this.app.name}-${id}]`,
          `directory=${directory}/package`,
          `command=bash -c "set -a; source ${this.appDir}/.env; set +a; n auto; npm start"`,
          `stderr_logfile=${logs}`,
          `stdout_logfile=${errors}`,
          `user=appuser`,
          `stopasgroup=true`,
        ].join("\n") + "\n";

      const nginxFile = `/etc/nginx/sites-enabled/${instance.id}.${this.app.domain.primary}.conf`;
      const nginxConfig =
        [
          `upstream ${this.app.name}-${instance.id} {`,
          `  server 127.0.0.1:${port};`,
          `  keepalive 64;`,
          `}`,
          `server {`,
          `  listen 80;`,
          `  server_name preview-${instance.id}.${this.app.domain.primary};`,
          `  return 301 https://$host$request_uri;`,
          `}`,
          `server {`,
          `  listen 443 ssl;`,
          `  server_name preview-${instance.id}.${this.app.domain.primary};`,
          `  ssl_certificate /etc/letsencrypt/live/${this.app.domain.primary}/fullchain.pem;`,
          `  ssl_certificate_key /etc/letsencrypt/live/${this.app.domain.primary}/privkey.pem;`,
          `  include /etc/deploy/nginx/options-ssl.conf;`,
          `  location / {`,
          `    proxy_redirect     off;`,
          `    proxy_set_header   X-Real-IP          $remote_addr;`,
          `    proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;`,
          `    proxy_set_header   X-Forwarded-Proto  $scheme;`,
          `    proxy_set_header   Host               $http_host;`,
          `    proxy_set_header   X-NginX-Proxy      true;`,
          `    proxy_set_header   Connection         "";`,
          `    proxy_http_version 1.1;`,
          `    proxy_pass         http://${this.app.name}-${instance.id};`,
          `  }`,
          `}`,
        ].join("\n") + "\n";

      this.app.deployments.current.push(instance);
      this.app.deployments.history.unshift({
        active: this.app.deployments.active,
        deployments: this.app.deployments.current.map((instance) => instance.id),
        createdAt: getCreatedAt(),
      });
      this.app.deployments.history = this.app.deployments.history.slice(0, this.app.config.maxDeploymentHistory);

      await this.sh.exec(
        [
          `type n || npm install --global n`,
          `mkdir -p ${quote(Path.dirname(logs))}`,
          `mkdir -p ${quote(directory)}`,
          `tar -zxf ${quote(artefact)} -C ${quote(directory)}`,
          `cat <<- 'EOF' > ${quote(supervisorFile)}\n${supervisorConfig}\nEOF\n`,
          `cat <<- 'EOF' > ${quote(nginxFile)}\n${nginxConfig}\nEOF\n`,
          `supervisorctl reread`,
          `supervisorctl update`,
          `nginx -t`,
        ].join("\n"),
      );

      await this.createCertificates();
      await this.sh.exec("service nginx reload");

      this.log(`Create new app instance ${quote(instance.id)} from release v${releaseId}.`);

      return instance;
    });
  }

  async start(instanceId: AppInstanceId): Promise<void> {
    await this.withManifestSync(async () => {
      this.log(`Start app instance ${this.app.name}-${instanceId}`);
      await this.sh.exec(`supervisorctl start ${this.app.name}-${instanceId}`);
    });
  }

  async restart(instanceId: AppInstanceId): Promise<void> {
    await this.withManifestSync(async () => {
      this.log(`Restart app instance ${this.app.name}-${instanceId}`);
      await this.sh.exec(`supervisorctl restart ${this.app.name}-${instanceId}`);
    });
  }

  async status(instanceId: AppInstanceId): Promise<{ status: string; text: string }> {
    return await this.withManifestSync(async () => {
      this.log(`Status app instance ${this.app.name}-${instanceId}`);
      const statusText = await this.sh.execNoFail(`supervisorctl status ${this.app.name}-${instanceId}`);
      if (statusText != null) {
        const match = /^[\S]+\s+([\S]+)\s+(.*)$/i.exec(statusText.trim());

        return match == null ? { status: "UNKNOWN", text: statusText } : { status: match[1], text: statusText };
      }
      return { status: "SSH_ERROR", text: "Error in SSH command." };
    });
  }

  async stop(instanceId: AppInstanceId): Promise<void> {
    await this.withManifestSync(async () => {
      this.log(`Stop app instance ${this.app.name}-${instanceId}`);
      await this.sh.exec(`supervisorctl stop ${this.app.name}-${instanceId}`);
    });
  }

  async destroyRelease(releaseId: ReleaseId): Promise<void> {
    await this.withManifestSync(async () => {
      const release = await this.getRelease(releaseId);
      if (release == null) {
        throw new Exception("UnknownRelease", `There is no such release.`);
      }

      const instances = await this.instances();
      const matchedInstances = instances.filter((instance) => instance.releaseId === releaseId);

      if (matchedInstances.length > 0) {
        throw new Exception("ReleaseInUse", `There are ${matchedInstances.length} active instance(s).`);
      }

      this.app.releases = this.app.releases.filter((release) => release.id !== releaseId);

      await this.sh.exec(`
        rm -f ${quote(`${this.appDir}/releases/v${release.id}.tar.gz`)};
      `);

      this.log(`Delete release v${release.id}`);
    });
  }

  async destroyInstance(instanceId: AppInstanceId): Promise<void> {
    const supervisorFile = `/etc/supervisor/conf.d/${this.app.name}-${instanceId}.conf`;
    const nginxFile = `/etc/nginx/sites-enabled/${instanceId}.${this.app.domain.primary}.conf`;
    await this.withManifestSync(async () => {
      const instance = await this.getInstance(instanceId);
      const instances = await this.instances();

      if (instance == null) throw new Exception("UnknownAppInstance", `No such instance: ${instanceId}`);

      this.app.deployments.current = instances.filter((instance) => instance.id !== instanceId);
      this.app.deployments.history.push(this.createHistoryItem());

      await this.sh.exec(`
        rm -f ${quote(supervisorFile)};
        rm -f ${quote(nginxFile)};
        rm -rf ${quote(instance.internal.directory)};
        supervisorctl reread;
        supervisorctl update;
        service nginx reload;
      `);

      this.log(`Destroy app instance ${this.app.name}-${instanceId}`);
    });
  }

  private createHistoryItem(): DeploymentHistoryItem {
    return {
      active: this.app.deployments.active,
      deployments: this.app.deployments.current.map((instance) => instance.id),
      createdAt: getCreatedAt(),
    };
  }

  async logs(instanceId: AppInstanceId): Promise<ReadableStream> {
    throw new Error("Unimplemented");
  }

  // -- Deployment Management
  async deploy(instanceId: AppInstanceId): Promise<DeploymentHistoryItem> {
    const instance = await this.getInstance(instanceId);
    if (instance == null) throw new Exception("UnknownAppInstance");

    return await this.withManifestSync(async () => {
      this.app.deployments.active = instanceId;
      const historyItem = this.createHistoryItem();
      const config =
        [
          `server {`,
          `  listen 80;`,
          `  server_name ${this.app.domain.primary} ${this.app.domain.aliases.join(" ")};`,
          `  return 301 https://$host$request_uri;`,
          `}`,
          `server {`,
          `  listen 443 ssl;`,
          `  server_name ${this.app.domain.primary} ${this.app.domain.aliases.join(" ")};`,
          `  ssl_certificate /etc/letsencrypt/live/${this.app.domain.primary}/fullchain.pem;`,
          `  ssl_certificate_key /etc/letsencrypt/live/${this.app.domain.primary}/privkey.pem;`,
          `  include /etc/deploy/nginx/options-ssl.conf`,
          `  location / {`,
          `    proxy_redirect     off;`,
          `    proxy_set_header   X-Real-IP          $remote_addr;`,
          `    proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;`,
          `    proxy_set_header   X-Forwarded-Proto  $scheme;`,
          `    proxy_set_header   Host               $http_host;`,
          `    proxy_set_header   X-NginX-Proxy      true;`,
          `    proxy_set_header   Connection         "";`,
          `    proxy_http_version 1.1;`,
          `    proxy_pass         http://${this.app.name}-${instance.id};`,
          `  }`,
          `}`,
        ].join("\n") + "\n";

      await this.sh.exec(
        [
          `cat <<- 'EOF' > /etc/nginx/sites-enabled/${this.app.name}.conf\n${config}\nEOF\n`,
          `service nginx reload`, //
        ].join("\n") + "\n",
      );

      return historyItem;
    });
  }

  async rollback(): Promise<DeploymentHistoryItem> {
    if (this.app.deployments.history.length === 0) throw new Exception("NoHistoryFound");
    const lastVersion = this.app.deployments.history[0].active;
    if (lastVersion == null) throw new Exception("NoDeploymentFound");
    const instance = await this.getInstance(lastVersion);
    if (instance == null) throw new Exception("NoDeploymentFound");
    this.log(`Rollback from ${quote(this.app.deployments.active ?? "none")} to ${quote(instance.id)}`);

    return await this.deploy(lastVersion);
  }
}
