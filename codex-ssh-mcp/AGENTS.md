# Codex tools over SSH

When the user requests work on a remote server, use the `codex_ssh` tools. Run `ListTargets_remote_ssh` to find the configured aliases and their current working directories. Pass the chosen alias as `target` on every remote operation. Ask which alias to use if the target is ambiguous.

- Use `SetWorkingDirectory_remote_ssh` to change a target's working directory for this session. Wait for confirmation before using relative paths on that target.
- Use `Read_remote_ssh` before `Edit_remote_ssh` or `Write_remote_ssh` on an existing file. Read the file again after a conflict or SSH reconnect.
- Use `Bash_remote_ssh` to run commands from the remote target's working directory with its Bash login environment. Run `find`, `grep`, or `rg` on the remote host for search as available.
- Keep authentication material out of tool arguments, commands, and uploaded files. Use the client's normal protected launch and the configured local SSH authentication.
