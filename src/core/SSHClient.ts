import chalk from "chalk";
import * as OS from "os";
import * as FileSystem from "fs";
import * as Path from "path";
import * as CP from "child_process";
import * as Util from "util";
import { Exception, FileNotFoundException, quote } from "./helpers";
import { HostConfig } from "./HostConfig";

export class SSHClient {
  private readonly server: Required<HostConfig>;
  private readonly binSSH = process.env.SSH_BIN_PATH ?? "/usr/bin/ssh";
  private readonly binSCP = process.env.SCP_BIN_PATH ?? "/usr/bin/scp";
  constructor(server: HostConfig) {
    this.server = {
      port: 22,
      user: "root",
      privateKey: "~/.ssh/id_rsa",
      appsDirectory: "/apps",
      ...server,
    };

    if (process.env.DEPLOYER_SSH_KEY != null) {
      this.server.privateKey = Path.resolve(OS.tmpdir(), "deployer", Date.now() + ".pem");
      FileSystem.mkdirSync(Path.dirname(this.server.privateKey), { recursive: true });
      FileSystem.writeFileSync(this.server.privateKey, process.env.DEPLOYER_SSH_KEY, { mode: 0o600, encoding: "utf8" });
    }
  }

  async ls(expr: string): Promise<string[]> {
    const output = await this.exec(`find ${quote(expr)} -mindepth 1 -maxdepth 1 -type d`);
    const lines = output.trim().split(/\r?\n/);

    return lines.map((line) => line.trim());
  }

  async mkdir(path: string): Promise<void> {
    await this.exec(`mkdir -p ${quote(path)}`);
  }

  async exists(file: string): Promise<boolean> {
    const result = (
      await this.exec(`
      test -f ${quote(file)} && echo 'file'  || echo ''
      test -d ${quote(file)} && echo 'dir'   || echo ''
      `)
    ).trim();

    return result === "file" || result === "dir";
  }

  async read(file: string): Promise<string> {
    if (await this.exists(file)) {
      const output = await this.exec(`cat ${quote(file)}`);

      return output;
    }

    throw new FileNotFoundException(file);
  }

  async write(file: string, contents: string): Promise<void> {
    console.debug(chalk.gray(`Writing file: ${chalk.bold(file)}`));
    await this.exec(`cat <<- EOF > ${quote(file)}\n${contents}\nEOF\n`);
  }

  async readJSON<T extends Record<string, any> = any>(file: string): Promise<T> {
    return JSON.parse(await this.read(file));
  }

  async upload(localFile: string, remoteFile: string): Promise<void> {
    try {
      const { stdout, stderr } = await Util.promisify(CP.exec)(
        `${this.binSCP} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -q -i ${quote(
          this.server.privateKey,
        )} -P ${this.server.port} ${quote(localFile)} ${this.server.user}@${this.server.host}:${quote(remoteFile)}`,
      );
      if (stderr !== "") console.error(chalk.red(stderr));
      if (stdout !== "") console.log(chalk.gray(stdout));
    } catch (error) {
      throw new Exception("SCPError", error.message);
    }
  }

  async exec(script: string): Promise<string> {
    try {
      console.debug(chalk.gray(chalk.bold(`Execute (${this.server.host}): `), script));
      const boundary = `END_OF_SCRIPT_${Date.now()}`;
      const outputBoundary = `-------------SSH-OUTPUT-----`;
      const { stdout, stderr } = await Util.promisify(CP.exec)(
        `${this.binSSH} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -q -i ${quote(
          this.server.privateKey,
        )} -p ${this.server.port} ${this.server.user}@${this.server.host} <<'${boundary}'\n` +
          `echo ${quote(outputBoundary)};\n` +
          script +
          "\n" +
          boundary +
          "\n",
      );
      if (stderr !== "") console.error(chalk.red(stderr));
      const index = stdout.indexOf(outputBoundary);
      if (index >= 0) return stdout.substr(index + outputBoundary.length + 1);
      return stdout;
    } catch (error) {
      throw new Exception("SCPError", error.message);
    }
  }

  async execNoFail(script: string): Promise<string | null> {
    try {
      return await this.exec(script);
    } catch {
      return null;
    }
  }
}
