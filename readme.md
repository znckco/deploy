# Deploy

A minimal continuous deployment tool.

## CLI commands

```
deploy <command>

Commands:
  deploy check                      check server compatibility
  deploy apps                       show available apps
  deploy releases                   show releases of an app
  deploy instances                  show instances of an app
  deploy create-app                 create a new app
  deploy create-release [artefact]  create a new release
  deploy create-instance <id>       create an instance of a release
  deploy delete-instance <id>       delete an instance of a release
  deploy delete-release <id>        delete a release
  deploy status                     app/instance status

Options:
  --help     Show help                                                 [boolean]
  --version  Show version number                                       [boolean]
```
