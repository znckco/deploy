import chalk from "chalk";
import * as CP from "child_process";
import * as FS from "fs";
import * as OS from "os";
import * as Path from "path";
import * as Util from "util";
export class SSHClient {
    constructor(server) {
        this.server = {
            port: 22,
            user: "root",
            privateKey: "~/.ssh/id_rsa",
            appsDirectory: "/apps",
            ...server,
        };
    }
    async ls(expr) {
        const output = await this.exec(`find ${quote(expr)} -mindepth 1 -maxdepth 1 -type d`);
        const lines = output.trim().split(/\r?\n/);
        return lines.map((line) => line.trim());
    }
    async mkdir(path) {
        await this.exec(`mkdir -p ${quote(path)}`);
    }
    async exists(file) {
        const result = (await this.exec(`
      test -f ${quote(file)} && echo 'file'  || echo ''
      test -d ${quote(file)} && echo 'dir'   || echo ''
      `)).trim();
        return result === "file" || result === "dir";
    }
    async read(file) {
        if (await this.exists(file)) {
            const output = await this.exec(`cat ${quote(file)}`);
            return output;
        }
        throw new Error("FileNotFound");
    }
    async write(file, contents) {
        console.debug(chalk.gray(`Writing file: ${chalk.bold(file)}`));
        await this.exec(`cat <<- EOF > ${quote(file)}\n${contents}\nEOF\n`);
    }
    async readJSON(file) {
        return JSON.parse(await this.read(file));
    }
    async upload(localFile, remoteFile) {
        try {
            const { stdout, stderr } = await Util.promisify(CP.exec)(`scp -q -i ${quote(this.server.privateKey)} -P ${this.server.port} ${quote(localFile)} ${this.server.user}@${this.server.host}:${quote(remoteFile)}`);
            if (stderr !== "")
                console.error(chalk.red(stderr));
            if (stdout !== "")
                console.log(chalk.gray(stdout));
        }
        catch (error) {
            throw new Exception("SCPError", error.message);
        }
    }
    async exec(script) {
        try {
            console.debug(chalk.gray(chalk.bold("Execute: "), script));
            const boundary = `END_OF_SCRIPT_${Date.now()}`;
            const outputBoundary = `-------------SSH-OUTPUT-----`;
            const { stdout, stderr } = await Util.promisify(CP.exec)(`ssh -q -i ${quote(this.server.privateKey)} -p ${this.server.port} ${this.server.user}@${this.server.host} <<'${boundary}'\n` +
                `echo ${quote(outputBoundary)};\n` +
                script +
                "\n" +
                boundary +
                "\n");
            if (stderr !== "")
                console.error(chalk.red(stderr));
            const index = stdout.indexOf(outputBoundary);
            if (index >= 0)
                return stdout.substr(index + outputBoundary.length + 1);
            return stdout;
        }
        catch (error) {
            throw new Exception("SCPError", error.message);
        }
    }
    async execNoFail(script) {
        try {
            return await this.exec(script);
        }
        catch {
            return null;
        }
    }
}
function quote(text) {
    return JSON.stringify(text);
}
class Exception extends Error {
    constructor(code, message = code) {
        super(message);
        this.code = code;
    }
}
class FileNotFoundException extends Exception {
    constructor(fileName) {
        super("FileNotFound", `No such file ${quote(fileName)}`);
        this.fileName = fileName;
    }
}
function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0, v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
function areObjectsEqual(a, b, depth = 0) {
    if (typeof a !== typeof b)
        return false;
    const type = typeof a;
    if (type === "object") {
        if (a === null || b === null) {
            return a === b;
        }
        if (depth > 20)
            throw new Exception("PossibleCircularObject");
        if (Array.isArray(a) || Array.isArray(b)) {
            if (Array.isArray(a) && Array.isArray(b)) {
                if (a.length !== b.length)
                    return false;
                return a.every((_, index) => areObjectsEqual(a[index], b[index], depth + 1));
            }
            return false;
        }
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length)
            return false;
        return keys.every((key) => areObjectsEqual(a[key], b[key], depth + 1));
    }
    return a === b;
}
class AppManager {
    constructor(app, manifest, sh) {
        this.app = app;
        this.manifest = manifest;
        this.sh = sh;
        this.appDir = Path.dirname(this.manifest);
    }
    async saveManifest() {
        await this.sh.write(this.manifest, JSON.stringify(this.app, null, 2));
    }
    async withManifestSync(fn) {
        const app = JSON.parse(JSON.stringify(this.app));
        try {
            const result = await fn();
            await this.saveManifest();
            return result;
        }
        catch (error) {
            if (!areObjectsEqual(app, this.app)) {
                FS.promises.writeFile("deploy-debug.log", [
                    `===== Current Manifest ====`,
                    JSON.stringify(app, null, 2),
                    `===== Unsaved Manifest ====`,
                    JSON.stringify(this.app, null, 2),
                ].join("\n") + "\n");
                console.warn(chalk.yellow(chalk.bold("CommandFailure: ", "reverting app manifest to previous state.")));
            }
            throw error;
        }
    }
    // -- Release Management
    async createRelease(options, asset) {
        const stat = await FS.promises.stat(asset);
        let assetFilename = asset;
        let shouldUnlinkAssetFile = false;
        if (stat.isFile()) {
            const { stderr } = await Util.promisify(CP.exec)(`tar -tzf  ${quote(asset)}`);
            if (stderr.trim().length > 0) {
                throw new Exception("InvalidArchive", stderr);
            }
        }
        else if (stat.isDirectory()) {
            assetFilename = Path.join(await FS.promises.mkdtemp("deployer-"), "archive.tar.gz");
            shouldUnlinkAssetFile = true;
            const ignoreFiles = [
                Path.resolve(asset, ".deployignore"),
                Path.resolve(process.cwd(), ".deployignore"),
            ].filter((file) => FS.existsSync(file));
            const extraArgs = ignoreFiles.map((file) => `--exclude-from=${quote(file)}`).join(" ");
            const { stderr } = await Util.promisify(CP.exec)(`tar -c ${extraArgs} -zf ${quote(assetFilename)} ${quote(asset)}`, {
                env: { ...process.env, COPYFILE_DISABLE: "true" },
            });
            if (stderr.trim().length > 0) {
                throw new Exception("InvalidArchive", stderr);
            }
        }
        const release = {
            id: this.app.releases.length > 0 ? this.app.releases[0].id + 1 : 1,
            commit: options.commit,
            version: options.version,
            createdAt: getCreatedAt(),
        };
        return this.withManifestSync(async () => {
            await this.sh.upload(assetFilename, Path.join(this.appDir, "releases", `v${release.id}.tar.gz`));
            if (shouldUnlinkAssetFile)
                await FS.promises.unlink(assetFilename);
            this.log(`Create release v${release.id} from ${this.app.repository}/commit/${release.commit} (version: ${release.version})`);
            this.app.releases.unshift(release);
            this.app.releases = this.app.releases.slice(0, this.app.config.maxReleases);
            return release;
        });
    }
    log(line) {
        this.app.changelog.push({
            info: `${OS.userInfo().username}@${OS.hostname()}`,
            message: line,
            timestamp: getCreatedAt(),
        });
    }
    async setEnv(key, value) {
        return this.withManifestSync(async () => {
            if (!/^[a-z][a-z0-9_]*$/.test(key))
                throw new Exception("InvalidEnvironmentVariableName", `Invalid characters in environment variable name: ${key}`);
            await this.sh.exec([
                `sed -i ${quote(`/^${key}=.*$//g`)} ${this.appDir}/.env`,
                `echo ${quote(`${key}=${quote(value)}\n`)} >> ${this.appDir}/.env`,
            ].join("\n"));
            if (!this.app.env.includes(key)) {
                this.app.env.push(key);
                this.log(`Set environment variables ${quote(key)}`);
            }
            else {
                this.log(`Update environment variables ${quote(key)}`);
            }
        });
    }
    // -- Instance Management
    async instances() {
        return this.app.deployments.current;
    }
    async getInstance(instanceId) {
        return this.app.deployments.current.find((instance) => instance.id === instanceId);
    }
    async current() {
        const id = this.app.deployments.active;
        if (id != null) {
            return this.app.deployments.current.find((instance) => instance.id === id);
        }
    }
    async createInstance(releaseId) {
        const release = this.app.releases.find((release) => release.id);
        if (release == null)
            throw new Exception("UnknownRelease", `Cannot find release v${releaseId}`);
        return this.withManifestSync(async () => {
            const id = uuid();
            const usedPorts = this.app.deployments.current.map((instance) => instance.internal.port);
            usedPorts.sort((a, b) => a - b);
            let port = 3000;
            for (const usedPort of usedPorts) {
                if (usedPort > port)
                    break;
                port++;
            }
            const directory = `${this.appDir}/instances/${id}`;
            const logs = `/var/logs/${this.app.name}/${id}.log`;
            const errors = `/var/logs/${this.app.name}/${id}-error.log`;
            const instance = {
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
            const supervisorConfig = [
                `[program:${this.app.name}-${id}]`,
                `command=sh -c "set -a; source ${this.appDir}/.env; set +a; npm start"`,
                `directory=${directory}`,
                `stderr_logfile=${logs}`,
                `stdout_logfile=${errors}`,
                `user=appuser`,
            ].join("\n") + "\n";
            const nginxFile = `/etc/nginx/sites-enabled/${instance.id}.${this.app.domain.primary}.conf`;
            const nginxConfig = [
                `upstream ${this.app.name}-${instance.id} {`,
                `  server 127.0.0.1:${port};`,
                `  keepalive 64;`,
                `}`,
                `server {`,
                `  listen 80;`,
                `  server_name ${instance.id}.${this.app.domain.primary};`,
                `  return 301 https://$host$request_uri;`,
                `}`,
                `server {`,
                `  listen 443 ssl;`,
                `  server_name ${instance.id}.${this.app.domain.primary};`,
                `  location / {`,
                `    proxy_redirect     off;`,
                `    proxy_set_header   X-Real-IP          $remote_addr;`,
                `    proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;`,
                `    proxy_set_header   X-Forwarded-Proto  $scheme;`,
                `    proxy_set_header   Host               $http_host;`,
                `    proxy_set_header   X-NginX-Proxy      true;`,
                `    proxy_set_header   Connection         "";`,
                `    proxy_http_version 1.1;`,
                `    proxy_cache        one;`,
                `    proxy_cache_key    sfs$request_uri$scheme;`,
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
            await this.sh.exec([
                `mkdir -p ${quote(Path.dirname(logs))}`,
                `mkdir -p ${quote(directory)}`,
                `tar -zxf ${quote(artefact)} -C ${quote(directory)}`,
                `cat <<- EOF > ${quote(supervisorFile)}\n${supervisorConfig}\nEOF\n`,
                `cat <<- EOF > ${quote(nginxFile)}\n${nginxConfig}\nEOF\n`,
                `supervisorctl reread`,
                `supervisorctl update`,
                `service nginx reload`,
            ].join("\n"));
            this.log(`Create new app instance ${quote(instance.id)} from release v${releaseId}.`);
            return instance;
        });
    }
    async start(instanceId) {
        await this.withManifestSync(async () => {
            this.log(`Start app instance ${this.app.name}-${instanceId}`);
            await this.sh.exec(`supervisorctl start ${this.app.name}-${instanceId}`);
        });
    }
    async restart(instanceId) {
        await this.withManifestSync(async () => {
            this.log(`Restart app instance ${this.app.name}-${instanceId}`);
            await this.sh.exec(`supervisorctl restart ${this.app.name}-${instanceId}`);
        });
    }
    async status(instanceId) {
        return await this.withManifestSync(async () => {
            this.log(`Status app instance ${this.app.name}-${instanceId}`);
            return await this.sh.exec(`supervisorctl status ${this.app.name}-${instanceId}`);
        });
    }
    async stop(instanceId) {
        await this.withManifestSync(async () => {
            this.log(`Stop app instance ${this.app.name}-${instanceId}`);
            await this.sh.exec(`supervisorctl status ${this.app.name}-${instanceId}`);
        });
    }
    async destroy(instanceId) {
        const supervisorFile = `/etc/supervisor/conf.d/${this.app.name}-${instanceId}.conf`;
        await this.withManifestSync(async () => {
            const instance = await this.getInstance(instanceId);
            const instances = await this.instances();
            if (instance == null)
                throw new Exception("UnknownAppInstance");
            this.app.deployments.current = instances.filter((instance) => instance.id !== instanceId);
            this.app.deployments.history.push(this.createHistoryItem());
            await this.stop(instanceId);
            await this.sh.exec(`rm ${quote(supervisorFile)}`);
            await this.sh.exec(`rm -r ${quote(instance.internal.directory)}`);
            this.log(`Destroy app instance ${this.app.name}-${instanceId}`);
        });
    }
    createHistoryItem() {
        return {
            active: this.app.deployments.active,
            deployments: this.app.deployments.current.map((instance) => instance.id),
            createdAt: getCreatedAt(),
        };
    }
    async logs(instanceId) {
        throw new Error("Unimplemented");
    }
    // -- Deployment Management
    async deploy(instanceId) {
        const instance = await this.getInstance(instanceId);
        if (instance == null)
            throw new Exception("UnknownAppInstance");
        return await this.withManifestSync(async () => {
            this.app.deployments.active = instanceId;
            const historyItem = this.createHistoryItem();
            const config = [
                `server {`,
                `  listen 80;`,
                `  server_name ${this.app.domain.primary} ${this.app.domain.aliases.join(" ")};`,
                `  return 301 https://$host$request_uri;`,
                `}`,
                `server {`,
                `  listen 443 ssl;`,
                `  server_name ${this.app.domain.primary} ${this.app.domain.aliases.join(" ")};`,
                `  location / {`,
                `    proxy_redirect     off;`,
                `    proxy_set_header   X-Real-IP          $remote_addr;`,
                `    proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;`,
                `    proxy_set_header   X-Forwarded-Proto  $scheme;`,
                `    proxy_set_header   Host               $http_host;`,
                `    proxy_set_header   X-NginX-Proxy      true;`,
                `    proxy_set_header   Connection         "";`,
                `    proxy_http_version 1.1;`,
                `    proxy_cache        one;`,
                `    proxy_cache_key    sfs$request_uri$scheme;`,
                `    proxy_pass         http://${this.app.name}-${instance.id};`,
                `  }`,
                `}`,
            ].join("\n") + "\n";
            await this.sh.exec([
                `cat <<- EOF > /etc/nginx/sites-enabled/${this.app.name}.conf\n${config}\nEOF\n`,
                `service nginx reload`, //
            ].join("\n") + "\n");
            return historyItem;
        });
    }
    async rollback() {
        if (this.app.deployments.history.length === 0)
            throw new Exception("NoHistoryFound");
        const lastVersion = this.app.deployments.history[0].active;
        if (lastVersion == null)
            throw new Exception("NoDeploymentFound");
        const instance = await this.getInstance(lastVersion);
        if (instance == null)
            throw new Exception("NoDeploymentFound");
        this.log(`Rollback from ${quote(this.app.deployments.active ?? "none")} to ${quote(instance.id)}`);
        return await this.deploy(lastVersion);
    }
}
export class DeploymentManager {
    constructor(server) {
        this.server = server;
        this.appsDir = this.server.appsDirectory ?? "/apps";
        this.sh = new SSHClient(this.server);
    }
    async info() {
        const node = await this.sh.execNoFail(`node --version`);
        const npm = await this.sh.execNoFail(`npm --version`);
        const tar = await this.sh.execNoFail(`tar --version`);
        const nginx = await this.sh.execNoFail(`nginx -v 2>&1`);
        const curl = await this.sh.execNoFail(`curl --version`);
        const user = await this.sh.execNoFail(`id -u appuser`);
        return { node, npm, tar, nginx, curl, user };
    }
    async apps() {
        if (await this.sh.exists(this.appsDir)) {
            const files = await this.sh.ls(this.appsDir);
            const prefixLength = this.appsDir.length + 1;
            return files.map((file) => file.substr(prefixLength));
        }
        return [];
    }
    async connect(app) {
        try {
            const manifestFile = `${this.appsDir}/${app}/deploy.json`;
            const manifest = await this.sh.readJSON(manifestFile);
            return new AppManager(manifest, manifestFile, this.sh);
        }
        catch (error) {
            if (error instanceof FileNotFoundException) {
                throw new Exception("AppNotFound", `No such app: ${quote(app)}`);
            }
            throw error;
        }
    }
    async create(options) {
        if (await this.sh.exists(`${this.appsDir}/${options.name}/deploy.json`)) {
            throw new Exception("DuplicateApp", `Another app with name (${quote(options.name)}) already exists.`);
        }
        const manifest = {
            name: options.name,
            repository: options.repository ?? "",
            domain: {
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
        return this.connect(manifest.name);
    }
    async check() {
        const tools = Object.entries(await this.info())
            .filter(([_, version]) => version == null)
            .map(([tool]) => tool);
        if (tools.length > 0) {
            throw new Exception("UnsupportedServer", `Missing required programs: ${tools.join(", ")}`);
        }
    }
}
function getCreatedAt() {
    return new Date().toUTCString();
}
export async function cli(args) {
    const yargs = await import("yargs");
    const prompts = await import("prompts");
    const configFile = Path.resolve(process.cwd(), "deploy.json");
    if (!FS.existsSync(configFile)) {
        throw new Exception("MissingConfigFile", "Cannot find deploy.json in current directory.");
    }
    const config = await importJSON(configFile);
    const deployer = new DeploymentManager(config);
    yargs
        .default(args)
        .scriptName("deployer")
        .command("apps create", "create a new app", {
        builder: {
        // TODO: Use args...
        },
        handler: async () => {
            const { name, domain, domainAliases, repository, healthcheck, maxReleases, maxDeploymentHistory, } = await prompts.default([
                {
                    type: "text",
                    name: "name",
                    message: "Short app name",
                },
                {
                    type: "text",
                    name: "domain",
                    message: "Primary application domain",
                },
                {
                    type: "list",
                    name: "domainAliases",
                    message: "Other domains",
                },
                {
                    type: "text",
                    name: "repository",
                    message: "GitHub repository",
                },
                {
                    type: "text",
                    name: "healthcheck",
                    message: "Healthcheck URL",
                    initial: 'curl -sSf "http://localhost:${PORT}/health"',
                },
                {
                    type: "number",
                    name: "maxReleases",
                    message: "Max number of releases to keep",
                    increment: 1,
                    initial: 5,
                },
                {
                    type: "number",
                    name: "maxDeploymentHistory",
                    message: "Max number of releases to keep",
                    increment: 1,
                    initial: 50,
                },
            ]);
            const app = await deployer.create({
                name,
                domain,
                domainAliases,
                repository,
                healthcheck,
                maxReleases,
                maxDeploymentHistory,
            });
            console.log(chalk.gray(`Application ${chalk.white(quote(app.app.name))} created.`));
        },
    })
        .command("apps", "show available apps", {
        builder: {},
        handler: async () => {
            const apps = await deployer.apps();
            for (const app of apps) {
                console.log(`- ${app}`);
            }
            if (apps.length === 0)
                console.warn(chalk.yellow("No apps found."));
        },
    })
        .command("releases create", "create a new release", {
        builder: {
            app: {
                alias: ["a"],
                demandOption: true,
                description: "App name",
            },
            commit: {
                demandOption: true,
                description: "Commit SHA",
            },
            version: {
                demandOption: true,
                description: "Human readable version",
            },
            artefact: {
                demandOption: true,
                description: "A tar file containing npm package with bundled dependencies.",
            },
        },
        handler: async ({ app, commit, version, artefact }) => {
            const manager = await deployer.connect(app);
            const release = await manager.createRelease({ commit, version }, artefact);
            console.log(`Created release v${release.id} `);
        },
    })
        .command("releases", "show releases of an app", {
        builder: {
            app: {
                alias: ["a"],
                demandOption: true,
                description: "App name",
            },
        },
        handler: async ({ app }) => {
            const appManager = await deployer.connect(app);
            const releases = appManager.app.releases;
            const instances = await appManager.instances();
            // TODO: Use some lib to show tables
            if (releases.length > 0) {
                console.log(chalk.gray("Id \tVersion     \tCreated At      \tCommit                  \tInstances"));
                for (const release of releases) {
                    console.log([
                        release.id,
                        release.version,
                        release.createdAt,
                        release.commit,
                        instances
                            .filter((instance) => instance.releaseId === release.id)
                            .map((instance) => instance.id)
                            .join(", "),
                    ].join("\t"));
                }
            }
            else {
                console.warn(chalk.yellow("No releases found."));
            }
        },
    })
        .demandCommand(1).argv;
}
async function importJSON(configFile) {
    const contents = await FS.promises.readFile(configFile, "utf-8");
    try {
        return JSON.parse(contents);
    }
    catch (error) {
        throw new Exception("InvalidJSONObject", error.message);
    }
}
