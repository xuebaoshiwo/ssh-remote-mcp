# Claude Code 和 Codex 的远程 SSH MCP

[English](README.md)

在本机运行 Claude Code 或 Codex，通过 SSH 到 Linux 服务器读取文件、编辑代码和运行 Bash。两种接入共用本机 MCP 网关，按 `target` 选择服务器，可以在同一会话中切换。登录和模型请求由本机客户端处理。

| 本机客户端 | MCP 注册名 | SSH 服务器上的执行方式 |
| --- | --- | --- |
| Claude Code | `claude_ssh` | 通过 `claude mcp serve` 调用原生工具 |
| Codex | `codex_ssh` | 通过 `codex app-server` 执行文件和命令操作 |

## 配置

1. **准备本机。** 安装 Node.js 22 或更新版本和 OpenSSH。Windows 使用系统 OpenSSH，其他平台从 `PATH` 查找 `ssh`。为每台服务器配置 SSH `Host` 别名并核验主机密钥。把 `dev-box` 替换为你的别名，确认 `ssh -o BatchMode=yes dev-box true` 可以用本机密钥或 SSH agent 完成认证。
2. **准备 Linux 服务器。** 建一个由 SSH 账号拥有的专用目录，从官方发布渠道取得与你的服务器架构匹配的二进制，把需要的后端安装在该目录内。填写可执行文件的实际路径，避免使用符号链接。服务端需要 Bash、`realpath` 和 `mktemp`。Codex 写文件还需要 `/usr/bin/python3`。开发验证使用过 Claude Code 2.1.330、Codex 0.167.0 和 0.170.0。
3. **创建目标清单。** 将 [targets.example.json](examples/targets.example.json) 复制为 `targets.json`，替换示例别名和路径。每个目标都要填写 `installRoot` 和对应后端的二进制字段。`projectDir` 是初始远程工作目录，默认等于 `installRoot`。这三个字段都使用 Linux 绝对路径。每个目标都填写两种二进制路径时，两个后端可以共用这份清单。
4. **注册本机 MCP。** 把示例中的路径替换为本机绝对路径。Windows 路径可以使用正斜杠，例如 `C:/tools/ssh-remote-mcp/targets.json`。如果客户端在 `PATH` 中找不到 `node`，将 `command` 改成 Node.js 可执行文件的绝对路径。

| 客户端 | 配置示例 | 注册位置 |
| --- | --- | --- |
| Claude Code | [claude.mcp.example.json](examples/claude.mcp.example.json) | 将 `claude_ssh` 合并到项目 `.mcp.json` 的 `mcpServers`。新开会话，按提示批准服务器，再用 `/mcp` 检查。 |
| Codex | [codex.config.example.toml](examples/codex.config.example.toml) | 将 `[mcp_servers.codex_ssh]` 合并到本机用户的 `~/.codex/config.toml`。只在某个项目使用时，合并到受信任项目的 `.codex/config.toml`。完成后新开会话。 |

`targets.json` 顶层的 `sshConfig` 默认是 `~/.ssh/config`，单个目标可以覆盖。支持绝对路径、以 `~/` 开头的路径和相对于 `targets.json` 的路径。为这些别名选择没有生效的 `SendEnv` 或 `SetEnv` 条目的 SSH 配置。修改 SSH 配置文件中的连接信息后，重启本机网关。

客户端配置和远程协议的参考文档见 [Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 和 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 使用工具

可以对客户端说「用 `ListTargets_remote_ssh` 列出服务器，在 `dev-box` 上运行 `pwd`，再去 `build-box` 运行 `git status --short`」。实际使用时替换成你的 SSH 别名。

| 工具 | 参数和行为 |
| --- | --- |
| `ListTargets_remote_ssh` | 列出已配置别名、初始项目目录和当前工作目录。这个调用不会打开 SSH。 |
| `SetWorkingDirectory_remote_ssh` | 传入 `target` 和 `path`，为当前 MCP 会话设置该目标的工作目录。 |
| `Read_remote_ssh` | 传入 `target` 和 `path`，可选从 1 开始的 `offset` 及行数 `limit`。 |
| `Edit_remote_ssh` | 传入 `target`、`path`、`old_string`、`new_string` 和可选的 `replace_all`，精确替换文本。 |
| `Write_remote_ssh` | 传入 `target`、`path`、`content`，创建或覆盖文件。 |
| `Bash_remote_ssh` | 传入 `target`、`command` 和可选的毫秒数 `timeout`。使用服务器的登录环境执行非交互 Bash。可以用服务器上的 `find`、`grep` 或 `rg` 搜索。 |

相对路径从对应目标的当前工作目录开始解析。每个目标可以分别设置一次，等工具确认后再使用相对路径。SSH 按需建立。该目标连续 10 分钟没有正在执行或排队的调用时，连接自动关闭。重新连接会沿用本会话中选定的目录，重启网关会恢复 `projectDir`。

编辑或覆盖已有文件前，先在当前连接中读取文件。SSH 重连后需要重新读取。Codex 后端会在替换文件前检查内容冲突，支持 16 MiB 以内的 UTF-8 文本，也可在相同大小限制下读取 PNG、JPEG、WebP 和 GIF。

## 凭证和权限

网关使用本机 SSH 认证，关闭 SSH agent、X11、端口和环境变量转发。远端后端使用各自独立的临时配置启动，本机模型登录凭证留在本机。后端通过 SSH 标准输入输出通信，无需开放额外服务端端口。

`installRoot` 用于存放可执行文件和后端临时状态。文件和 Bash 的访问权限由远端 SSH 账号决定，包括该账号已有的 sudo 权限。Bash 命令可使用服务器自身的网络和登录环境。工具的输入输出会经过本机客户端，使用时应避免命令或结果包含凭证等敏感信息。真实目标清单和 SSH 配置应留在 Git 仓库之外。
