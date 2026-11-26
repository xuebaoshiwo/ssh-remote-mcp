# SSH Remote MCP for Claude Code and Codex

[简体中文](README.zh-CN.md)

Use Claude Code or Codex on your local machine while reading files, editing code, and running Bash on your Linux servers. Both integrations use the same local MCP gateway and select a server with `target`, so you can switch servers in one chat. The local client handles sign-in and model requests.

| Local client | MCP registration | Execution on the selected SSH server |
| --- | --- | --- |
| Claude Code | `claude_ssh` | Native tools via `claude mcp serve` |
| Codex | `codex_ssh` | File and command operations via `codex app-server` |

## Setup

1. **Prepare the local machine.** Install Node.js 22 or newer and OpenSSH. Windows uses the system OpenSSH client. Other platforms use `ssh` from `PATH`. Configure an SSH `Host` alias and verify the host key for each server. Confirm `ssh -o BatchMode=yes dev-box true` works with your local key or agent, replacing `dev-box` with your alias.
2. **Prepare the Linux servers.** Create a dedicated directory that your SSH account owns. Install the real executable for each backend you want to use in that directory, using the official distribution for the server architecture. Use regular executable paths without symlinks. Linux Bash, `realpath`, and `mktemp` are required. Codex file writes also require `/usr/bin/python3`. The backend versions exercised during development were Claude Code 2.1.330 and Codex 0.167.0 and 0.170.0.
3. **Create your target list.** Copy [targets.example.json](examples/targets.example.json) to `targets.json` and replace the example aliases and paths. Every target needs `installRoot` and the binary field for the selected backend. `projectDir` is the initial remote working directory and defaults to `installRoot`. Use absolute Linux paths for all three. A single target list can serve both backends when each entry has both binary fields.
4. **Register the local MCP server.** Replace sample paths with absolute paths on your local machine. Forward slashes work in Windows paths such as `C:/tools/ssh-remote-mcp/targets.json`. If the client cannot find `node` on its `PATH`, set `command` to the absolute Node.js executable path.

| Client | Sample config | Where to register |
| --- | --- | --- |
| Claude Code | [claude.mcp.example.json](examples/claude.mcp.example.json) | Merge the `claude_ssh` entry into `mcpServers` in your project's `.mcp.json`. Open a new chat, approve the server if prompted, and check `/mcp`. |
| Codex | [codex.config.example.toml](examples/codex.config.example.toml) | Merge `[mcp_servers.codex_ssh]` into `~/.codex/config.toml` for your local user, or a trusted project's `.codex/config.toml` for project scope. Open a new chat. |

The top-level `sshConfig` in `targets.json` defaults to `~/.ssh/config`. You can override it for an individual target. Paths can be absolute, home-relative, or relative to `targets.json`. Use an SSH configuration with no effective `SendEnv` or `SetEnv` entries for these aliases. Restart the local gateway after changing connection details inside an SSH config file.

More about client setup and the remote protocol. [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) · [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## Use the tools

Try asking your client to run `ListTargets_remote_ssh`, then run `pwd` on `dev-box` and `git status --short` on `build-box`. Use your own SSH aliases in a real chat.

| Tool | Arguments and behavior |
| --- | --- |
| `ListTargets_remote_ssh` | Lists configured aliases, initial project directories, and current working directories without opening SSH. |
| `SetWorkingDirectory_remote_ssh` | Takes `target` and `path`. Updates the working directory for that target for this MCP session. |
| `Read_remote_ssh` | Takes `target`, `path`, and optional one-based `offset` and `limit`. |
| `Edit_remote_ssh` | Takes `target`, `path`, `old_string`, `new_string`, and optional `replace_all`. Replaces exact text. |
| `Write_remote_ssh` | Takes `target`, `path`, and `content`. Creates or overwrites a file. |
| `Bash_remote_ssh` | Takes `target`, `command`, and an optional `timeout` in milliseconds. Runs non-interactive Bash using the server's login environment. Use remote `find`, `grep`, or `rg` for search as available. |

Relative paths start in the target's current working directory. Set it once per target, then wait for confirmation before using relative paths. Each target connects on demand and disconnects after 10 minutes with no running or queued calls. Reconnecting retains the chosen directory. Restarting the gateway restores `projectDir`.

Read existing files in the current connection before editing or overwriting them. Read again after reconnecting. The Codex backend checks for conflicting edits before replacing files, supports UTF-8 text up to 16 MiB, and can read PNG, JPEG, WebP, and GIF images within the same size limit.

## Credentials and permissions

The gateway uses local SSH authentication and disables SSH agent, X11, port, and environment forwarding. Each remote backend starts with a dedicated temporary configuration and no model credentials from the local machine. The backends communicate over SSH standard input and output. The gateway opens no server-side listener.

`installRoot` stores the executable and temporary backend state. File and Bash access is governed by the remote SSH account's permissions, including any existing sudo rights. Bash commands can use the server's network and login environment. Tool inputs and outputs pass through the local client, so keep credentials and other sensitive values out of commands and results. Keep your real target lists and SSH configuration out of Git.
