import chalk from "chalk";
import * as FS from "fs";
import * as Path from "path";
import { version } from "../package.json";
import { AppInstanceId, DeploymentManager, HostConfig, ReleaseId } from "./core";
import { Exception, importJSON, quote } from "./core/helpers";

export async function cli(args: string[]): Promise<void> {
  const yargs = await import("yargs");
  const prompts = await import("prompts");
  const Table = await import("cli-table");
  const configFile = Path.resolve(process.cwd(), "deploy.json");
  if (!FS.existsSync(configFile)) {
    throw new Exception("MissingConfigFile", "Cannot find deploy.json in current directory.");
  }

  const config = await importJSON<HostConfig>(configFile);
  const deployer = new DeploymentManager(config);

  yargs
    .default(args)
    .scriptName("deploy")
    .version(version)

    .command("check", "check server compatibility", {
      builder: {},
      handler: async () => {
        await deployer.check();
        console.log(chalk.green("OK."));
      },
    })

    .command("apps", "show available apps", {
      builder: {},
      handler: async () => {
        const apps = await deployer.apps();

        const table = new Table.default({ head: ["App Name"] });
        for (const app of apps) {
          table.push([app]);
        }

        if (apps.length === 0) console.warn(chalk.yellow("No apps found."));
        else console.log(table.toString());
      },
    })
    .command<{ app: string }>("releases", "show releases of an app", {
      builder: {
        app: {
          alias: ["a"],
          default: process.env.DEPLOYER_APP,
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
          const table = new Table.default({
            head: ["Id", "Created At", "Commit", "Tag", "Instances"],
          });
          for (const release of releases) {
            table.push([
              release.id,
              release.createdAt,
              release.commit,
              release.tag,
              instances
                .filter((instance) => instance.releaseId === release.id)
                .map((instance) => instance.id)
                .join(", "),
            ]);
          }

          console.log(table.toString());
        } else {
          console.warn(chalk.yellow("No releases found."));
        }
      },
    })
    .command<{ app: string }>("instances", "show instances of an app", {
      builder: {
        app: {
          alias: ["a"],
          default: process.env.DEPLOYER_APP,
          demandOption: true,
          description: "App name",
        },
      },
      handler: async ({ app }) => {
        const appManager = await deployer.connect(app);
        const instances = await appManager.instances();

        if (instances.length > 0) {
          const table = new Table.default({
            head: ["Id", "Release", "Created At", "Preview"],
          });
          for (const instance of instances) {
            table.push([instance.id.slice(-6), `v${instance.releaseId}`, instance.createdAt, instance.preview]);
          }
          console.log(table.toString());
        } else {
          console.warn(chalk.yellow("No releases found."));
        }
      },
    })
    .command("create-app", "create a new app", {
      builder: {},
      handler: async () => {
        const {
          name,
          domain,
          email,
          domainAliases,
          repository,
          healthcheck,
          maxReleases,
          maxDeploymentHistory,
        } = await prompts.default([
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
            type: "text",
            name: "email",
            message: "Email address for SSL certificate notifications",
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
            message: "Max deployment history to keep",
            increment: 1,
            initial: 100,
          },
        ]);

        const app = await deployer.create({
          name,
          domain,
          email,
          domainAliases: domainAliases.filter(Boolean),
          repository,
          healthcheck,
          maxReleases,
          maxDeploymentHistory,
        });

        console.log(
          chalk.gray(
            `Application ${chalk.white(quote(app.app.name))} created. Set ${chalk.green(
              `DEPLOYER_APP=${app.app.name}`,
            )} to use as default app.`,
          ),
        );
      },
    })

    .command<{ app: string; commit: string; tag: string; artefact: string }>(
      "create-release [artefact]",
      "create a new release",
      {
        builder: (yargs) =>
          yargs
            .positional("artefact", { default: ".", description: "Directory or a tar file" })
            .option("app", {
              alias: ["a"],
              default: process.env.DEPLOYER_APP,
              demandOption: true,
              description: "App name",
            })
            .option("commit", { demandOption: true, description: "Commit SHA", alias: ["c"] })
            .option("tag", { description: "Release tag or version", alias: ["t"] }) as any,
        handler: async ({ app, commit, tag = "main", artefact }) => {
          if (!Path.isAbsolute(artefact)) {
            artefact = Path.resolve(process.cwd(), artefact);
          }
          const manager = await deployer.connect(app);
          const release = await manager.createRelease({ commit, tag }, artefact);

          console.log(`Created release v${release.id} `);
        },
      },
    )

    .command<{ app: string; id: ReleaseId }>("create-instance <id>", "create an instance of a release", {
      builder: (yargs) =>
        yargs
          .positional("id", {
            demandOption: true,
            description: "Release ID",
            number: true,
          })
          .option("app", {
            alias: ["a"],
            default: process.env.DEPLOYER_APP,
            demandOption: true,
            description: "App name",
          }) as any,
      handler: async ({ app, id }) => {
        const manager = await deployer.connect(app);
        const instance = await manager.createInstance(id);

        console.log(`Created instance (id: ${instance.id.slice(-6)}) from v${instance.releaseId} of ${app}.`);
        console.log(`Instance URL: ${chalk.green(instance.preview)}`);
      },
    })

    .command<{ app: string; id: AppInstanceId }>(
      "promote-instance <id>",
      "promote an instance of a release to production",
      {
        builder: (yargs) =>
          yargs
            .positional("id", {
              demandOption: true,
              description: "App instance ID",
            })
            .option("app", {
              alias: ["a"],
              default: process.env.DEPLOYER_APP,
              demandOption: true,
              description: "App name",
            }) as any,
        handler: async ({ app, id }) => {
          const manager = await deployer.connect(app);
          const instances = await manager.instances();
          const matchingInstances = instances.filter((instance) => instance.id.endsWith(id));

          if (matchingInstances.length > 1) throw new Exception("InstanceShortIDCollision", "Provide full instance id");
          if (matchingInstances.length === 0) {
            await manager.deploy(id);
          } else {
            await manager.deploy(matchingInstances[0].id);
          }

          console.log(chalk.gray(`Done.`));
        },
      },
    )
    .command<{ app: string; id: AppInstanceId }>("delete-instance <id>", "delete an instance of a release", {
      builder: (yargs) =>
        yargs
          .positional("id", {
            demandOption: true,
            description: "App instance ID",
          })
          .option("app", {
            alias: ["a"],
            default: process.env.DEPLOYER_APP,
            demandOption: true,
            description: "App name",
          }) as any,
      handler: async ({ app, id }) => {
        const manager = await deployer.connect(app);
        const instances = await manager.instances();
        const matchingInstances = instances.filter((instance) => instance.id.endsWith(id));

        if (matchingInstances.length > 1) throw new Exception("InstanceShortIDCollision", "Provide full instance id");
        if (matchingInstances.length === 0) {
          await manager.destroyInstance(id);
        } else {
          await manager.destroyInstance(matchingInstances[0].id);
        }

        console.log(chalk.gray(`Done.`));
      },
    })

    .command<{ app: string; id: ReleaseId }>("delete-release <id>", "delete a release", {
      builder: (yargs) =>
        yargs
          .positional("id", {
            demandOption: true,
            description: "Release ID",
            number: true,
          })
          .option("app", {
            alias: ["a"],
            default: process.env.DEPLOYER_APP,
            demandOption: true,
            description: "App name",
          }) as any,
      handler: async ({ app, id }) => {
        const manager = await deployer.connect(app);

        await manager.destroyRelease(id);

        console.log(chalk.gray("Done."));
      },
    })

    .command<{ app: string; instance: string }>("status", "app/instance status", {
      builder: {
        app: {
          alias: ["a"],
          default: process.env.DEPLOYER_APP,
          demandOption: true,
          description: "App name",
        },
        instance: {
          alias: ["i"],
          description: "App instance ID",
        },
      },
      handler: async ({ app, instance: id }) => {
        const manager = await deployer.connect(app);

        const instances = await manager.instances();
        const matchingInstances = id != null ? instances.filter((instance) => instance.id.endsWith(id)) : instances;
        const statuses = await Promise.all(matchingInstances.map((instance) => manager.status(instance.id)));

        const table = new Table.default({
          head: ["ID", "Release", "Status", "Preview"],
        });

        table.push(
          ...matchingInstances.map((instance, index) => [
            instance.id.slice(-6),
            `v${instance.releaseId}`,
            statuses[index].status,
            instance.preview,
          ]),
        );

        console.log(table.toString());
      },
    })

    .completion("completion", false)
    .demandCommand(1).argv;
}
