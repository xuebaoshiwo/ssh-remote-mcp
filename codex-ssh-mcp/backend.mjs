import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';

const maxFileBytes = 16 * 1024 * 1024;
const digest = data => createHash('sha256').update(data).digest('hex');
const text = value => ({ type: 'text', text: JSON.stringify(value) });
const mimeTypes = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif']]);

export const descriptions = {
  Read_remote_ssh: 'Remote SSH counterpart to reading a local file in Codex. Reads files on the selected server through Codex App Server. Supports line ranges for UTF-8 files and returns common image formats.',
  Write_remote_ssh: 'Remote SSH counterpart to writing a local file in Codex. Creates or atomically replaces a UTF-8 file on the selected server. Read an existing file first with Read_remote_ssh.',
  Edit_remote_ssh: 'Remote SSH counterpart to editing a local file in Codex. Replaces exact text in a UTF-8 file on the selected server. Read the file first with Read_remote_ssh.',
  Bash_remote_ssh: 'Remote SSH counterpart to running a local shell command in Codex. Uses the selected server’s login Bash environment and proxy settings, starting in its current working directory.',
};

const atomicReplace = String.raw`import fcntl
import hashlib
import os
import shutil
import stat
import sys
import tempfile

stage, path, expected, lock_path = sys.argv[1:]
destination = os.path.realpath(path)
parent = os.path.dirname(destination)

with os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "rb+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    current = None
    if expected == "-":
        if os.path.lexists(path):
            sys.exit("Read the existing file with Read_remote_ssh before overwriting it.")
        os.makedirs(parent, exist_ok=True)
    else:
        try:
            current = os.lstat(destination)
        except FileNotFoundError:
            sys.exit("The file was removed. Read it again before changing it.")
        if not stat.S_ISREG(current.st_mode):
            sys.exit("Only regular files can be edited.")
        with os.fdopen(os.open(destination, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
            checksum = hashlib.sha256()
            for chunk in iter(lambda: source.read(1048576), b""):
                checksum.update(chunk)
            if checksum.hexdigest() != expected:
                sys.exit("The file has changed. Read it again before editing.")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=parent, prefix=".codex-ssh-", delete=False) as output:
            temporary = output.name
            with open(stage, "rb") as source:
                shutil.copyfileobj(source, output)
            if current is not None:
                owner = os.fstat(output.fileno())
                if (owner.st_uid, owner.st_gid) != (current.st_uid, current.st_gid):
                    os.fchown(output.fileno(), current.st_uid, current.st_gid)
                os.fchmod(output.fileno(), stat.S_IMODE(current.st_mode))
            output.flush()
            os.fsync(output.fileno())
        if os.path.realpath(path) != destination:
            sys.exit("The target path changed. Read it again before editing.")
        if current is None:
            try:
                os.link(temporary, destination)
            except FileExistsError:
                sys.exit("The file now exists. Read it before overwriting it.")
        else:
            latest = os.lstat(destination)
            if (latest.st_ino, latest.st_size, latest.st_mtime_ns, latest.st_ctime_ns) != (
                current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns):
                sys.exit("The file has changed. Read it again before editing.")
            os.replace(temporary, destination)
            temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)
`;

async function command(remote, argv, cwd, timeoutMs, signal) {
  return remote.request('command/exec', { command: argv, cwd, timeoutMs,
    sandboxPolicy: { type: 'dangerFullAccess' } }, timeoutMs + 15000, signal);
}

export async function initialize(remote, version, signal) {
  await remote.request('initialize', {
    clientInfo: { name: 'codex-ssh-mcp', title: 'Codex SSH MCP', version }, capabilities: { experimentalApi: true },
  }, 25000, signal);
  remote.send({ method: 'initialized' });
  const account = await remote.request('account/read', { refreshToken: false }, 12000, signal);
  if (account.account !== null) throw new Error('The isolated remote Codex App Server unexpectedly has an account.');
  const probe = await command(remote, ['/bin/bash', '-c', 'printf "%s" "$TMPDIR"'], '/', 5000, signal);
  const tempDirectory = probe.stdout.trim();
  const session = posix.dirname(tempDirectory);
  if (probe.exitCode !== 0 || posix.basename(tempDirectory) !== 'tmp' ||
      !/^session-[A-Za-z0-9]{6}$/.test(posix.basename(session)) ||
      posix.dirname(session) !== remote.target.installRoot + '/.codex-ssh-mcp/sessions') {
    throw new Error('Could not verify the remote Codex session directory.');
  }
  remote.tempDirectory = tempDirectory;
  remote.readFiles = new Map();
}

async function readBytes(remote, file, deadline, signal) {
  const result = await remote.request('fs/readFile', { path: file }, deadline, signal);
  if (typeof result?.dataBase64 !== 'string') throw new Error('Invalid Codex file response.');
  if (result.dataBase64.length > Math.ceil(maxFileBytes / 3) * 4) throw new Error('File exceeds 16 MiB.');
  const bytes = Buffer.from(result.dataBase64, 'base64');
  if (bytes.length > maxFileBytes) throw new Error('File exceeds 16 MiB.');
  return bytes;
}

function utf8(bytes) {
  try {
    if (bytes.includes(0)) throw new Error('Binary content');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('This file is not UTF-8 text or a supported image format.');
  }
}

async function writeBytes(remote, file, bytes, expected, deadline, signal) {
  if (bytes.length > maxFileBytes) throw new Error('File exceeds 16 MiB.');
  const stage = posix.join(remote.tempDirectory, 'stage-' + randomUUID());
  const lock = remote.target.installRoot + '/.codex-ssh-mcp/write.lock';
  try {
    await remote.request('fs/writeFile', { path: stage, dataBase64: bytes.toString('base64') }, deadline, signal);
    const result = await command(remote, ['/usr/bin/python3', '-I', '-c', atomicReplace, stage, file, expected ?? '-', lock],
      remote.tempDirectory, Math.min(deadline, 30000), signal);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'The remote file write failed.');
    remote.readFiles.set(file, digest(bytes));
  } finally {
    if (!signal.aborted && !remote.closed) {
      await remote.request('fs/remove', { path: stage, force: true }, 5000, signal).catch(() => {});
    }
  }
}

export async function call(remote, request, cwd, deadline, signal) {
  const args = request.arguments;
  if (request.name === 'Bash') {
    const result = await command(remote, ['/bin/bash', '-c', args.command], cwd, args.timeout, signal);
    return { isError: result.exitCode !== 0, content: [text(result)] };
  }
  const file = args.file_path;
  if (request.name === 'Read') {
    const bytes = await readBytes(remote, file, deadline, signal);
    const mimeType = mimeTypes.get(posix.extname(file).toLowerCase());
    if (mimeType) return { content: [text({ type: 'image', file: { filePath: file } }),
      { type: 'image', data: bytes.toString('base64'), mimeType }] };
    const original = utf8(bytes);
    remote.readFiles.set(file, digest(bytes));
    const lines = original.split('\n');
    const offset = args.offset ?? 1;
    const selected = lines.slice(offset - 1, offset - 1 + (args.limit ?? 2000));
    const content = selected.join('\n');
    return { content: [text({ type: 'text', file: { filePath: file, content,
      startLine: offset, numLines: selected.length, totalLines: lines.length } })] };
  }
  const expected = remote.readFiles.get(file);
  if (request.name === 'Write') {
    await writeBytes(remote, file, Buffer.from(args.content), expected, deadline, signal);
    return { content: [text({ type: expected ? 'update' : 'create', filePath: file })] };
  }
  if (!expected) throw new Error('Read the file with Read_remote_ssh in this SSH connection before editing it.');
  const bytes = await readBytes(remote, file, deadline, signal);
  if (digest(bytes) !== expected) throw new Error('The file has changed. Read it again before editing.');
  const pieces = utf8(bytes).split(args.old_string);
  const count = pieces.length - 1;
  if (!count) throw new Error('The exact text was not found in the remote file.');
  if (count > 1 && !args.replace_all) throw new Error('The old text appears more than once. Provide more context or use replace_all.');
  await writeBytes(remote, file, Buffer.from(pieces.join(args.new_string)), expected, deadline, signal);
  return { content: [text({ filePath: file, replacements: count })] };
}
