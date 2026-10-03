const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');

function load(file, mocks, env = process) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, process: env, console,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(id) });
  return module.exports;
}

function resolver(platform, PATH, files, registryPath) {
  let registryReads = 0;
  class Registry { get(_, cb) { registryReads++; cb(null, { value: registryPath }); } }
  const mod = load('util.ts', {
    winreg: Registry, fs: {
      constants: fs.constants,
      existsSync: file => files.includes(file),
      statSync: file => ({ isFile: () => files.includes(file) }),
      accessSync: file => { if (!files.includes(file)) throw new Error('ENOENT'); },
    },
    path: platform === 'win32' ? path.win32 : path.posix,
  }, { platform, env: { PATH } });
  return { get: configured => mod.getRPath({ get: () => configured }, platform === 'win32' ? 'C:\\workspace' : '/workspace'), reads: () => registryReads };
}

test('explicit Coc r.lsp.path wins over PATH and registry', async () => {
  const r = resolver('win32', 'C:\\R\\bin', ['D:\\custom\\R.exe', 'C:\\R\\bin\\R.exe'], 'E:\\R');
  assert.equal(await r.get('D:\\custom\\R.exe'), 'D:\\custom\\R.exe');
  assert.equal(r.reads(), 0);
});
test('Windows PATH wins over registry, including directory names with spaces', async () => {
  const r = resolver('win32', 'C:\\missing;C:\\Program Files\\R\\bin', ['C:\\Program Files\\R\\bin\\R.exe'], 'E:\\R');
  assert.equal(await r.get(), 'C:\\Program Files\\R\\bin\\R.exe');
  assert.equal(r.reads(), 0);
});
test('registry fallback and missing PATH retain prior behavior', async () => {
  const r = resolver('win32', undefined, ['E:\\R\\bin\\R.exe'], 'E:\\R');
  assert.equal(await r.get(), 'E:\\R\\bin\\R.exe');
  assert.equal(r.reads(), 1);
  assert.equal(await resolver('darwin', undefined, []).get(), 'R');
});
test('Unix PATH uses its first matching R executable', async () => {
  assert.equal(await resolver('darwin', '/first:/second', ['/first/R', '/second/R']).get(), '/first/R');
});

test('PATH skips directories and non-executable files before a real executable', {
  skip: process.platform === 'win32' && 'Unix executable permission regression',
}, async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'coc-r-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = ['directory', 'not-executable', 'executable'].map(name => path.join(root, name));
  directories.forEach(directory => fs.mkdirSync(directory));
  fs.mkdirSync(path.join(directories[0], 'R'));
  fs.writeFileSync(path.join(directories[1], 'R'), '#!/bin/sh\n', { mode: 0o600 });
  const executable = path.join(directories[2], 'R');
  fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
  const mod = load('util.ts', { winreg: class {} }, {
    platform: process.platform, env: { PATH: directories.join(path.delimiter) },
  });
  assert.equal(await mod.getRPath({ get: () => '' }, root), executable);
});

test('PATH ignores inaccessible candidates and falls back when none are usable', async () => {
  const mod = load('util.ts', {
    winreg: class {}, fs: { ...fs, statSync: () => { throw new Error('EACCES'); } },
  }, { platform: 'linux', env: { PATH: '/inaccessible' } });
  assert.equal(await mod.getRPath({ get: () => '' }, '/workspace'), 'R');
});

test('relative and empty PATH entries resolve against the client working directory', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'coc-r-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(path.join(cwd, 'tools'), { recursive: true });
  const name = process.platform === 'win32' ? 'R.exe' : 'R';
  const local = path.join(cwd, name);
  const tools = path.join(cwd, 'tools', name);
  fs.writeFileSync(local, '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(tools, '#!/bin/sh\n', { mode: 0o700 });
  for (const [PATH, expected] of [
    ['tools', tools],
    [`${path.delimiter}tools`, local],
    ['', local],
  ]) {
    const mod = load('util.ts', { winreg: class {} }, { platform: process.platform, env: { PATH } });
    assert.equal(await mod.getRPath({ get: () => '' }, cwd), expected);
  }
});

test('R client forwards file watching and handles socket errors without losing Coc selectors', async () => {
  const { EventEmitter } = require('node:events');
  const output = [];
  let opened, clientOptions, serverOptions, connection;
  const watcher = { dispose() {} };
  class Client {
    constructor(_id, _name, server, options) { serverOptions = server; clientOptions = options; }
    start() {}
    stop() { return Promise.resolve(); }
    needsStop() { return true; }
  }
  const uri = value => ({ scheme: 'file', fsPath: value.replace('file://', ''), toString: () => value });
  const module = load('index.ts', {
    './util': { getRPath: async (_config, cwd) => { assert.equal(cwd, '/project'); return 'R'; } },
    net: { createServer: cb => {
      connection = cb;
      return { listen() {}, close() {} };
    } },
    'coc.nvim': {
      LanguageClient: Client, RevealOutputChannelOn: { Never: 4 }, Uri: { parse: uri },
      window: { createOutputChannel: () => ({ appendLine: text => output.push(text) }) },
      workspace: {
        getConfiguration: () => ({ get: (key, fallback) => key === 'lsp.lang' ? '' : fallback }),
        getWorkspaceFolder: () => ({ uri: 'file:///project', name: 'project' }),
        createFileSystemWatcher: glob => { assert.equal(glob, '**/*.{R,r}'); return watcher; },
        onDidOpenTextDocument: cb => { opened = cb; }, onDidCloseTextDocument() {}, onDidChangeWorkspaceFolders() {}, textDocuments: [],
      },
    },
  });
  module.activate({ subscriptions: [] });
  await opened({ uri: 'file:///project/a.r', languageId: 'r' });
  assert.equal(clientOptions.synchronize.fileEvents, watcher);
  assert.equal(clientOptions.synchronize.configurationSection, 'r.lsp');
  assert.equal(clientOptions.documentSelector[1].language, 'rmd');
  const pending = serverOptions();
  const socket = new EventEmitter();
  connection(socket);
  assert.equal((await pending).reader, socket);
  assert.doesNotThrow(() => socket.emit('error', new Error('reset')));
  assert.ok(output.some(line => line.includes('reset')));
  await module.deactivate();
});
