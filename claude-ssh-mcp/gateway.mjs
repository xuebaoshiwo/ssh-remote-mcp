import { spawn, execFile } from 'node:child_process';
import { watchFile, unwatchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const configPath = resolve(process.argv[2] ?? 'targets.json');
const codexBackend = process.argv[3] === 'codex' ? await import('../codex-ssh-mcp/backend.mjs') : null;
const gatewayName = codexBackend ? 'codex-ssh-mcp' : 'claude-ssh-mcp';
const instructionsFile = new URL(codexBackend ? '../codex-ssh-mcp/AGENTS.md' : './AGENT.md', import.meta.url);
const protocolVersions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const gatewayVersion = '1.4.0';
const sshIdleTimeout = 10 * 60_000;
const ssh = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  : 'ssh';
const sshOptions = [
  'BatchMode=yes', 'ConnectTimeout=12', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
  'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ControlMaster=no', 'ControlPath=none',
  'SendEnv=-*', 'RequestTTY=no', 'ServerAliveInterval=15', 'ServerAliveCountMax=3',
];
const sshFlags = ['-T', '-a', '-x', ...sshOptions.flatMap(option => ['-o', option])];
const sshEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(SYSTEMROOT|WINDIR|PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|PROGRAMDATA|LOCALAPPDATA|APPDATA|TMP|TEMP|COMSPEC|USERNAME|USER|SSH_AUTH_SOCK)$/i.test(name)));
const serverShellVariables = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'LC_MESSAGES', 'TZ',
  'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ftp_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
];
const captureServerShell = [
  'for key in ' + serverShellVariables.join(' ') + '; do',
  '  if [[ -v "$key" ]]; then printf "%s=%s\\0" "$key" "${!key}"; fi',
  'done',
].join('\n');
const enterServerShell = [
  'set -eu',
  'mapfile -d "" -t server_environment < "$1"',
  '(( ${#server_environment[@]} > 0 ))',
  'export "${server_environment[@]}"',
  'exec /bin/bash --login -c "$2"',
].join('\n');
const routes = new Map();
const inFlight = new Map();
let stopped = false;
let initialized = false;
let advertisedAliases;

const targetProperty = { type: 'string' };
const pathProperty = { type: 'string', minLength: 1, description: 'Remote path. Relative paths start at the target’s current working directory.' };
function tool(name, description, properties, required, annotations) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations };
}
const tools = [
  tool('ListTargets_remote_ssh', 'Remote SSH counterpart to listing local workspaces. Lists configured remote SSH aliases, project directories, and current working directories without opening SSH connections.', {}, [], { readOnlyHint: true }),
  tool('SetWorkingDirectory_remote_ssh', 'Remote SSH counterpart to changing the local working directory. Sets the selected remote server’s working directory for this MCP session. Future file and Bash calls on that target use it. Resolve relative paths from its current directory and wait for success before calling other tools.', {
    target: targetProperty, path: pathProperty,
  }, ['target', 'path'], { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool('Read_remote_ssh', 'Remote SSH version of Claude Code’s local Read tool. Reads a file on the selected remote server with its native Read tool.', {
    target: targetProperty, path: pathProperty,
    offset: { type: 'integer', minimum: 1, description: 'First line to read, starting at one.' },
    limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to read.' },
  }, ['target', 'path'], { readOnlyHint: true, openWorldHint: true }),
  tool('Edit_remote_ssh', 'Remote SSH version of Claude Code’s local Edit tool. Replaces exact text in a file on the selected remote server with its native Edit tool. Read the file first with Read_remote_ssh.', {
    target: targetProperty, path: pathProperty,
    old_string: { type: 'string', minLength: 1 }, new_string: { type: 'string' },
    replace_all: { type: 'boolean', default: false },
  }, ['target', 'path', 'old_string', 'new_string'], { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
  tool('Write_remote_ssh', 'Remote SSH version of Claude Code’s local Write tool. Creates or overwrites a file on the selected remote server with its native Write tool. Read an existing file first with Read_remote_ssh.', {
    target: targetProperty, path: pathProperty, content: { type: 'string' },
  }, ['target', 'path', 'content'], { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
  tool('Bash_remote_ssh', 'Remote SSH version of Claude Code’s local Bash tool. Runs a command in the selected remote server’s login Bash environment with its account home, shell profile, and server proxy settings. Starts in the target’s current working directory. Use find for filenames and grep for file contents.', {
    target: targetProperty, command: { type: 'string', minLength: 1 },
    description: { type: 'string', description: 'A short description of the command.' },
    timeout: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Timeout in milliseconds. Default 90000.' },
  }, ['target', 'command'], { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
];
const toolDefinitions = new Map(tools.map(item => [item.name, item]));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const content = text => ({ type: 'text', text });

function describeTools(aliases) {
  const target = aliases.length ? {
    type: 'string', enum: aliases,
    description: 'Select the SSH alias of the remote server. Current choices: ' + aliases.join(', ') + '.',
  } : { type: 'string', description: 'No remote SSH targets are configured.' };
  return tools.map(tool => {
    const description = codexBackend?.descriptions[tool.name] ?? tool.description;
    const inputSchema = tool.inputSchema.properties.target
      ? { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, target } }
      : tool.inputSchema;
    return { ...tool, description, inputSchema };
  });
}

function validateArguments(definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  for (const name of definition.inputSchema.required) {
    if (!Object.hasOwn(args, name)) throw new Error('Missing argument: ' + name);
  }
  for (const [name, value] of Object.entries(args)) {
    const property = definition.inputSchema.properties[name];
    if (!property) throw new Error('Unexpected argument: ' + name);
    if (property.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < property.minimum || value > (property.maximum ?? Infinity)) {
        throw new Error('Invalid integer argument: ' + name);
      }
    } else if (typeof value !== property.type || (typeof value === 'string' &&
        (value.includes('\0') || value.length < (property.minLength ?? 0)))) {
      throw new Error('Invalid argument: ' + name);
    }
  }
}

function linuxPath(value, target, field) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\0\r\n]/.test(value)) {
    throw new Error(target + ' requires an absolute Linux ' + field + ' path.');
  }
  return posix.resolve(value);
}

async function readTargets() {
  let config;
  try {
    config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Cannot read targets.json. Check that the file exists and contains valid JSON.');
  }
  if (!config?.targets || typeof config.targets !== 'object' || Array.isArray(config.targets)) {
    throw new Error('targets.json must contain a targets object.');
  }
  const targets = new Map();
  for (const [name, entry] of Object.entries(config.targets)) {
    const alias = name.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(alias) || targets.has(alias) || !entry || typeof entry !== 'object') {
      throw new Error('Invalid or duplicate SSH alias in targets.json: ' + name);
    }
    const installRoot = linuxPath(entry.installRoot, name, 'installRoot');
    if (installRoot === '/') throw new Error(name + ' installRoot must be a dedicated directory.');
    const projectDir = linuxPath(entry.projectDir ?? installRoot, name, 'projectDir');
    const sshConfig = entry.sshConfig ?? config.sshConfig ?? '~/.ssh/config';
    if (typeof sshConfig !== 'string' || !sshConfig.trim() || /[\0\r\n]/.test(sshConfig)) {
      throw new Error(name + ' has an invalid sshConfig path.');
    }
    const configFile = resolve(dirname(configPath), sshConfig.replace(/^~(?=[\\/]|$)/, () => homedir()));
    const binaryField = codexBackend ? 'codexBinary' : 'claudeBinary';
    const binary = linuxPath(entry[binaryField], name, binaryField);
    if (!binary.startsWith(installRoot + '/')) {
      throw new Error(name + ' ' + binaryField + ' must be inside installRoot.');
    }
    targets.set(alias, { alias, configFile, installRoot, projectDir, binary });
  }
  return targets;
}

async function onTargetsChanged() {
  if (stopped || !initialized || advertisedAliases === undefined) return;
  try {
    const aliases = JSON.stringify([...(await readTargets()).keys()]);
    if (stopped || aliases === advertisedAliases) return;
    advertisedAliases = aliases;
    process.stdout.write('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n');
  } catch {
    // An editor may leave the file temporarily unreadable during a save.
  }
}

function launchCommand({ installRoot, projectDir, binary }) {
  const root = installRoot + '/.' + gatewayName;
  const sharedEnvironment = 'HOME="$session/home" XDG_CONFIG_HOME="$session/config" XDG_CACHE_HOME="$session/cache" XDG_DATA_HOME="$session/data" TMPDIR="$session/tmp" PATH=/usr/local/bin:/usr/bin:/bin SHELL=/bin/bash LANG=C.UTF-8 CLAUDE_SSH_BASH_ENV="$session/bash.env"';
  const providerEnvironment = codexBackend
    ? 'CODEX_HOME="$session/config" OPENAI_BASE_URL=http://127.0.0.1:1 HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1 ALL_PROXY=http://127.0.0.1:1 "$binary" app-server'
    : 'CLAUDE_CONFIG_DIR="$session/config" ANTHROPIC_BASE_URL=http://127.0.0.1:1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_UPDATES=1 "$binary" mcp serve';
  return [
    'set -eu',
    'umask 077',
    'root=' + quote(root),
    'binary=' + quote(binary),
    'test "$(realpath -e ' + quote(installRoot) + ')" = ' + quote(installRoot),
    'mkdir -p -- "$root"',
    'test "$(realpath -e "$root")" = "$root"',
    'test "$(realpath -e "$binary")" = "$binary" && test -x "$binary"',
    'mkdir -p -- "$root/sessions"',
    'test "$(realpath -e "$root/sessions")" = "$root/sessions"',
    'session=$(mktemp -d "$root/sessions/session-XXXXXX")',
    'trap \'rm -rf -- "$session"\' EXIT',
    'mkdir -- "$session/home" "$session/config" "$session/cache" "$session/data" "$session/tmp"',
    'BASH_ENV=/dev/null /bin/bash -c ' + quote(captureServerShell) + ' > "$session/bash.env"',
    codexBackend ? 'cd -- "$session"' : 'cd -- ' + quote(projectDir),
    '/usr/bin/env -i ' + sharedEnvironment + ' ' + providerEnvironment,
  ].join('\n');
}

function sshFailure(text) {
  if (/host key verification failed|host identification has changed|no .+ host key is known/i.test(text)) {
    return 'SSH host key verification failed. Check this alias and its known_hosts entry locally.';
  }
  if (/permission denied|too many authentication failures/i.test(text)) {
    return 'SSH authentication failed. Check the local SSH key or agent for this alias.';
  }
  if (/timed out|connection refused|no route to host|connection closed/i.test(text)) {
    return 'The SSH connection failed or was closed.';
  }
  if (/could not resolve hostname|bad configuration option|cannot open user config file/i.test(text)) {
    return 'OpenSSH could not resolve the alias or load its configured SSH file.';
  }
  return 'The SSH process stopped. Check the alias, remote project path, and remote ' + (codexBackend ? 'Codex' : 'Claude Code') + ' installation.';
}

class Remote {
  constructor(target, child) {
    this.target = target;
    this.child = child;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.stderr = '';
    this.available = new Set();
    child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
    child.once('error', error => this.fail(new Error('Could not launch OpenSSH (' + (error.code ?? 'process error') + ').')));
    child.stdin.on('error', () => {});
    this.exited = new Promise(resolveExit => {
      child.once('close', () => {
        this.fail(new Error(sshFailure(this.stderr)));
        resolveExit();
      });
    });
    createInterface({ input: child.stdout }).on('line', line => this.receive(line));
  }

  static async connect(target, signal) {
    const prefix = ['-F', target.configFile, ...sshFlags];
    let settings;
    try {
      ({ stdout: settings } = await execFileAsync(ssh, [...prefix, '-G', target.alias], {
        env: sshEnv, windowsHide: true, timeout: 12000, signal,
      }));
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(sshFailure(error.stderr ?? ''));
    }
    if (/^(?:sendenv|setenv)\s+\S/im.test(settings)) {
      throw new Error('This alias forwards SSH environment variables. Use a configuration without effective SendEnv or SetEnv entries.');
    }
    signal.throwIfAborted();
    const child = spawn(ssh, [...prefix, target.alias, launchCommand(target)], {
      env: sshEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const remote = new Remote(target, child);
    try {
      if (codexBackend) {
        await codexBackend.initialize(remote, gatewayVersion, signal);
        return remote;
      }
      await remote.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'claude-ssh-mcp', version: gatewayVersion },
      }, 25000, signal);
      remote.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const { tools: remoteTools } = await remote.request('tools/list', {}, 12000, signal);
      if (!Array.isArray(remoteTools)) throw new Error('Invalid response from the remote MCP tool list.');
      remote.available = new Set(remoteTools.map(item => item.name));
      return remote;
    } catch (error) {
      remote.close();
      throw error;
    }
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (line.trim()) this.close(new Error('Unexpected output on the SSH MCP channel. Check the remote shell startup scripts.'));
      return;
    }
    if (!message || (!codexBackend && message.jsonrpc !== '2.0')) return;
    if (message.method && message.id != null) {
      if (message.method === 'ping') this.send({ jsonrpc: '2.0', id: message.id, result: {} });
      else this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.error) request.finish(new Error(message.error.message || 'Remote MCP request failed.'));
    else request.finish(null, message.result);
  }

  send(value, callback) {
    if (this.closed || !this.child.stdin.writable) {
      callback?.(new Error('The SSH MCP connection is closed.'));
      return;
    }
    const { jsonrpc, ...payload } = value;
    this.child.stdin.write(JSON.stringify(codexBackend ? payload : value) + '\n', callback);
  }

  request(method, params, milliseconds, signal) {
    return new Promise((resolveRequest, reject) => {
      signal.throwIfAborted();
      const id = ++this.nextId;
      const timer = setTimeout(() => this.close(new Error('The remote MCP call timed out. Check the target before repeating a write or command.')), milliseconds);
      const abort = () => this.close(new Error('The remote MCP call was cancelled. Check the target before repeating a write or command.'));
      const finish = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolveRequest(result);
      };
      this.pending.set(id, { finish });
      signal.addEventListener('abort', abort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params }, error => { if (error) finish(error); });
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.finish(error);
  }

  close(error = new Error('The SSH MCP connection is closed.')) {
    this.fail(error);
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    }, 1800);
    timer.unref();
    return this.exited;
  }
}

function clearIdleTimer(lane) {
  clearTimeout(lane.idleTimer);
  lane.idleTimer = undefined;
}

function scheduleIdleClose(lane) {
  const remote = lane.remote;
  if (stopped || lane.queuedCalls || !remote || remote.closed) return;
  lane.idleTimer = setTimeout(() => {
    lane.idleTimer = undefined;
    if (lane.queuedCalls || lane.remote !== remote) return;
    lane.remote = null;
    lane.tail = remote.close();
  }, sshIdleTimeout);
  lane.idleTimer.unref();
}

function operation(name, args, alias, workingDirectory) {
  if (name === 'SetWorkingDirectory_remote_ssh') {
    const directory = linuxPath(posix.resolve(workingDirectory, args.path), alias, 'working directory');
    return { name: 'Bash', arguments: {
      command: 'cd -P -- ' + quote(directory) + ' && pwd -P',
      description: 'Check working directory on ' + alias, timeout: 10000,
    }, deadline: 25000 };
  }
  if (name === 'Bash_remote_ssh') {
    const timeout = args.timeout ?? 90000;
    const script = [
      'unset SSH_CONNECTION SSH_CLIENT SSH_TTY SSH_AUTH_SOCK SSH_AGENT_PID',
      'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_SESSION_ACCESS_TOKEN CLAUDE_API_KEY',
      ...(codexBackend ? ['unset OPENAI_API_KEY CODEX_API_KEY CHATGPT_AUTH_TOKEN'] : []),
      'cd -- ' + quote(workingDirectory) + ' && {',
      args.command,
      '}',
    ].join('\n');
    return { name: 'Bash', arguments: {
      command: '/usr/bin/env -i /bin/bash -c ' + quote(enterServerShell) + ' _ "$CLAUDE_SSH_BASH_ENV" ' + quote(script),
      description: args.description ?? 'Run a command on ' + alias, timeout,
    }, deadline: timeout + 15000 };
  }
  const file_path = posix.resolve(workingDirectory, args.path);
  const { target: ignoredTarget, path: ignoredPath, ...fields } = args;
  return { name: { Read_remote_ssh: 'Read', Edit_remote_ssh: 'Edit', Write_remote_ssh: 'Write' }[name],
    arguments: { file_path, ...fields }, deadline: 90000 };
}

async function callTool(name, args, signal) {
  const definition = toolDefinitions.get(name);
  if (!definition) return { isError: true, content: [content('Unknown MCP tool: ' + name)] };
  let label = '';
  try {
    validateArguments(definition, args);
    const targets = await readTargets();
    signal.throwIfAborted();
    if (name === 'ListTargets_remote_ssh') {
      const listing = [...targets.values()].map(target => {
        const lane = routes.get(target.alias);
        const workingDirectory = lane?.route === JSON.stringify(target) ? lane.workingDirectory : target.projectDir;
        return { target: target.alias, projectDir: target.projectDir, workingDirectory };
      });
      return { content: [content(JSON.stringify(listing, null, 2))] };
    }
    const target = targets.get(args.target.toLowerCase());
    if (!target) throw new Error('Unknown SSH alias. Call ListTargets_remote_ssh to see the configured targets.');
    label = 'target=' + target.alias + ' project=' + target.projectDir + '\n';
    let lane = routes.get(target.alias);
    if (!lane) {
      lane = { tail: Promise.resolve(), remote: null, queuedCalls: 0 };
      routes.set(target.alias, lane);
    }
    clearIdleTimer(lane);
    lane.queuedCalls++;
    const route = JSON.stringify(target);
    const work = lane.tail.then(async () => {
      signal.throwIfAborted();
      if (stopped) throw new Error('The MCP client is closing.');
      if (lane.route !== route) {
        lane.remote?.close();
        lane.remote = null;
        lane.route = route;
        lane.workingDirectory = target.projectDir;
      }
      if (!lane.remote || lane.remote.closed) {
        const remote = await Remote.connect(target, signal);
        if (stopped) {
          remote.close();
          throw new Error('The MCP client is closing.');
        }
        lane.remote = remote;
      }
      if (lane.workingDirectory !== target.projectDir) {
        label = label.trimEnd() + ' cwd=' + lane.workingDirectory + '\n';
      }
      const { deadline, ...request } = operation(name, args, target.alias, lane.workingDirectory);
      if (!codexBackend && !lane.remote.available.has(request.name)) {
        throw new Error('The remote MCP did not expose ' + request.name + '.');
      }
      const result = codexBackend
        ? await codexBackend.call(lane.remote, request, lane.workingDirectory, deadline, signal)
        : await lane.remote.request('tools/call', request, deadline, signal);
      if (!result || !Array.isArray(result.content)) throw new Error('Invalid tool result from the remote MCP.');
      if (name === 'SetWorkingDirectory_remote_ssh' && !result.isError) {
        const { stdout } = JSON.parse(result.content.find(item => item.type === 'text')?.text ?? '{}');
        const workingDirectory = linuxPath(stdout?.replace(/\r?\n$/, ''), target.alias, 'working directory returned by the server');
        signal.throwIfAborted();
        lane.workingDirectory = workingDirectory;
        return { content: [content(JSON.stringify({ target: target.alias, workingDirectory }))] };
      }
      return { ...result, content: [content(label.trimEnd()), ...result.content] };
    }).finally(() => {
      lane.queuedCalls--;
      scheduleIdleClose(lane);
    });
    lane.tail = work.catch(() => {});
    return await work;
  } catch (error) {
    return { isError: true, content: [content(label + error.message)] };
  }
}

function respond(id, result, error) {
  if (stopped) return;
  const message = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function onLine(line) {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    respond(null, null, { code: -32700, message: 'Parse error' });
    return;
  }
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    respond(request?.id ?? null, null, { code: -32600, message: 'Invalid request' });
    return;
  }
  const { id, method, params } = request;
  if (id == null) {
    if (method === 'notifications/initialized') initialized = true;
    if (method === 'notifications/cancelled') inFlight.get(params?.requestId)?.abort();
    return;
  }
  switch (method) {
    case 'initialize': {
      let instructions;
      try {
        instructions = await readFile(instructionsFile, 'utf8');
      } catch {
        respond(id, null, { code: -32603, message: 'Cannot read the gateway instructions.' });
        break;
      }
      respond(id, {
        protocolVersion: protocolVersions.includes(params?.protocolVersion) ? params.protocolVersion : protocolVersions.at(-1),
        capabilities: { tools: { listChanged: true } }, serverInfo: { name: gatewayName, version: gatewayVersion },
        instructions,
      });
      break;
    }
    case 'ping':
      respond(id, {});
      break;
    case 'tools/list': {
      try {
        const aliases = [...(await readTargets()).keys()];
        advertisedAliases = JSON.stringify(aliases);
        respond(id, { tools: describeTools(aliases) });
      } catch (error) {
        respond(id, null, { code: -32603, message: error.message });
      }
      break;
    }
    case 'tools/call': {
      const controller = new AbortController();
      inFlight.set(id, controller);
      try {
        const result = await callTool(params?.name, params?.arguments ?? {}, controller.signal);
        if (!controller.signal.aborted) respond(id, result);
      } finally {
        inFlight.delete(id);
      }
      break;
    }
    default:
      respond(id, null, { code: -32601, message: 'Method not found' });
  }
}

function stop() {
  if (stopped) return;
  stopped = true;
  unwatchFile(configPath, onTargetsChanged);
  for (const controller of inFlight.values()) controller.abort();
  for (const lane of routes.values()) {
    clearIdleTimer(lane);
    lane.remote?.close();
  }
  process.stdin.pause();
}

const lines = createInterface({ input: process.stdin });
watchFile(configPath, { persistent: false, interval: 700 }, onTargetsChanged);
lines.on('line', line => { void onLine(line).catch(() => {}); });
lines.once('close', stop);
process.stdout.once('error', stop);
process.on('SIGINT', () => { lines.close(); });
process.on('SIGTERM', () => { lines.close(); });
