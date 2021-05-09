import Action from "@actions/core";
import GitHub from "@actions/github";
import Path from "path";
import { AppInstanceId, DeploymentManager, HostConfig, parseAppInstanceId, parseReleaseId, ReleaseId } from "./core";
import { Exception, importJSON } from "./core/helpers";

interface Command {
  action: string;
}

interface CreateReleaseCommand extends Command {
  action: "create-release";
  app: string;
  commit: string;
  tag: string;
  artefact: string;
}

interface CreateInstanceCommand extends Command {
  action: "create-instance";
  app: string;
  releaseId: ReleaseId;
}

interface DestroyInstanceCommand extends Command {
  action: "destroy-instance";
  app: string;
  instanceId: AppInstanceId;
}

interface PromoteInstanceCommand extends Command {
  action: "promote-instance";
  app: string;
  instanceId: AppInstanceId;
}

function getCommand(): CreateInstanceCommand | CreateReleaseCommand | PromoteInstanceCommand | DestroyInstanceCommand {
  const action = Action.getInput("action", { required: true });
  switch (action) {
    case "create-release":
      return {
        action,
        app: Action.getInput("app", { required: true }),
        commit: Action.getInput("commit") ?? GitHub.context.sha,
        tag:
          // FIXME: add support for main branch in deploy.json
          /^refs\/heads\/(master|main)$/.test(GitHub.context.ref) ? "production" : `preview:${GitHub.context.ref}`,
        artefact: Action.getInput("artefact") ?? process.cwd(),
      };
    case "create-instance":
      return {
        action,
        app: Action.getInput("app", { required: true }),
        releaseId: parseReleaseId(Action.getInput("release_id", { required: true })),
      };
    case "promote-instance":
    case "destroy-instance":
      return {
        action,
        app: Action.getInput("app", { required: true }),
        instanceId: parseAppInstanceId(Action.getInput("instance_id", { required: true })),
      };
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function main(): Promise<void> {
  const workingDir = process.cwd();
  const configFile = Path.resolve(workingDir, Action.getInput("deploy_config") ?? "deploy.json");
  const contents = await importJSON<HostConfig | HostConfig[]>(configFile);
  const config = Array.isArray(contents) ? contents[0] : contents;
  const command = getCommand();

  const server = new DeploymentManager(config);

  switch (command.action) {
    case "create-release": {
      const app = await server.connect(command.app);
      const previousReleases = await app.getReleasesByTag(command.tag);

      // Delete previous release if it's preview build.
      if (command.tag.startsWith("preview:") && previousReleases.length > 0) {
        for (const release of previousReleases) {
          const instances = await app.getInstancesByReleaseId(release.id);
          for (const instance of instances) {
            await app.destroyInstance(instance.id);
          }

          await app.destroyRelease(release.id);
        }
      }

      const release = await app.createRelease(command, command.artefact);

      Action.info(`Created release v${release.id} from ${release.commit} (tag: ${release.tag}).`);
      Action.setOutput("release_id", release.id);
      break;
    }

    case "create-instance": {
      const app = await server.connect(command.app);
      const instance = await app.createInstance(command.releaseId);

      Action.info(`Created instance ${instance.id} from release v${instance.releaseId}.`);
      Action.setOutput("instance_id", instance.id);
      Action.setOutput("preview_url", instance.preview);
      break;
    }

    case "promote-instance": {
      const app = await server.connect(command.app);
      const status = await app.deploy(command.instanceId);

      Action.info(`Deployed instance ${status.active} to production.`);
      break;
    }

    case "destroy-instance": {
      const app = await server.connect(command.app);
      if (command.instanceId === app.app.deployments.active) throw Exception;
      await app.destroyInstance(command.instanceId);

      Action.info(`Deleted instance ${command.instanceId}.`);
      break;
    }
  }
}

main().catch((error) => {
  Action.error(error);
  process.exit(Action.ExitCode.Failure);
});
