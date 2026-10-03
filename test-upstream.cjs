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
    winreg: Registry, fs: { existsSync: file => files.includes(file) },
    path: platform === 'win32' ? path.win32 : path.posix,
  }, { platform, env: { PATH } });
  return { get: configured => mod.getRPath({ get: () => configured }), reads: () => registryReads };
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
    './util': { getRPath: async () => 'R' },
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
