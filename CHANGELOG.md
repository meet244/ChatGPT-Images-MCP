# Changelog

All notable changes to this project are listed here. Versions follow [semantic versioning](https://semver.org).

## 0.1.0 — first npm release

- `init`: one-command setup. Checks Node.js and Chrome, adds and signs in to the first ChatGPT account, and connects Claude Code and Codex.
- `doctor`: checks the whole setup (requirements, accounts, disk use, background server, client connections) and prints a fix for each problem.
- `cleanup`: removes Chrome caches and unused reference copies; `--images-older-than DAYS` also removes old images.
- New account menu (`manage-accounts`): arrow-key navigation, sign-in with Chrome, email and plan detection, session expiry, image counts and last use, move up and down, and repairing an account while Claude Code or Codex is running.
- `save_image` tool: copy a finished image into your project, optionally converting to PNG, JPEG or WebP.
- Verification checks shown before a prompt is sent are retried once after opening the account in normal Chrome.
- Reference image copies are deleted once no queued or running job needs them.
- `worker.log` records job starts, completions, failures, account switches and verification handoffs (never prompts), and rotates at 5 MB.
- CLI messages show commands that work for npx, global and source installs.
- Installable with `npx -y chatgpt-images-mcp@latest`; data lives in `~/.chatgpt-images-mcp` for package installs.
