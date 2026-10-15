# OpenSpec project context lives in config.yaml

OpenSpec 1.x moved project context to `openspec/config.yaml` under `context:`; `project.md` is legacy and `openspec update --force` removes it. `setup` scaffolds `config.yaml`, and prompts read it plus `project.md` if present.
