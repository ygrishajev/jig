# Documentation

[Project home](../README.md) · [Quickstart](../README.md#quickstart)

- [Installation](installation.md)
- [Commands and options](commands.md)
- [Authentication](authentication.md)
- [Configuration](configuration.md)
- [Agent presets](presets.md)
- [Sandbox and merge behavior](sandbox.md)
- [Run outputs and automation](operations.md)

## Architecture

The CLI reads the request and configuration, then runs planning, implementation,
and review in a Docker sandbox. The pipeline saves progress so a run can resume
and imports implementation commits into a dedicated Git branch. GitHub issue runs
can publish that branch as a pull request.

[Interactive architecture map](https://ygrishajev.github.io/jig/architecture.html) · [Map source](architecture.html) · [Contributing](../CONTRIBUTING.md)
