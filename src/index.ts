import { ExtensionContext, WorkspaceConfiguration, LanguageClient, LanguageClientOptions, ServerOptions, services, TransportKind, workspace, StreamInfo } from 'coc.nvim'
import net from 'net'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import winreg from "winreg"

async function getRPath(config: WorkspaceConfiguration): Promise<string> {
  let path = config.get("lsp.path") as string
  if (path && existsSync(path)) {
    return path
  }

  if (process.platform === "win32") {
    try {
      const key = new winreg({
        hive: winreg.HKLM,
        key: '\\Software\\R-Core\\R'
      })
      const item: winreg.RegistryItem = await new Promise((c, e) =>
        key.get('InstallPath', (err, result) => err ? e(err) : c(result)))
      const rhome = item.value
      // tslint:disable-next-line: no-console
      console.log("found R in registry:", rhome)
      path = rhome + "\\bin\\R.exe"
    } catch (e) {
      path = ""
    }
    if (path && existsSync(path)) {
      return path
    }
  }

  return "R"
}

export async function activate(context: ExtensionContext): Promise<void> {
  let { subscriptions, logger } = context
  const config = workspace.getConfiguration('r')
  let client: LanguageClient
  let path = await getRPath(config)
  let debug = config.get("lsp.debug")

  const serverOptions = () => new Promise<ChildProcess | StreamInfo>((resolve, reject) => {
    // Use a TCP socket because of problems with blocking STDIO
    const server = net.createServer(socket => {
      logger.debug('R process connected')
      socket.on('end', () => {
        logger.debug('R process disconnected')
      })
      server.close()
      resolve({ reader: socket, writer: socket })
    })
    // Listen on random port
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      // The server is implemented in R
      let Args: string[]
      if (debug) {
        Args = ["--quiet", "--slave", "-e", `languageserver::run(port=${port},debug=TRUE)`]
      } else {
        Args = ["--quiet", "--slave", "-e", `languageserver::run(port=${port})`]
      }

      if (debug) {
        const str = `R binary: ${path}`
        logger.debug(str)
        client.outputChannel.appendLine(str)
      }

      const childProcess = spawn(path, Args)
      childProcess.stderr.on('data', (chunk: Buffer) => {
        const str = chunk.toString()
        logger.debug('R Language Server:', str)
        client.outputChannel.appendLine(str)
      })
      childProcess.on('exit', (code, signal) => {
        client.outputChannel.appendLine(`Language server exited ` + (signal ? `from signal ${signal}` : `with exit code ${code}`))
        if (code !== 0) {
          client.outputChannel.show()
        }
      })
      return childProcess
    })
  })

  let clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'r' },
      { scheme: 'file', language: 'rmd' },
      { scheme: 'untitled', language: 'r' },
      { scheme: 'untitled', language: 'rmd' }
    ],
    synchronize: {
      // Synchronize the setting section 'r' to the server
      configurationSection: 'r.lsp',
      // Notify the server about changes to R files in the workspace
      fileEvents: workspace.createFileSystemWatcher('**/*.r')
    },
    outputChannelName: 'r'
  }

  client = new LanguageClient('R Language Server', 'r-lsp', serverOptions, clientOptions)

  client.onReady().then(() => {
    workspace.showMessage('R language server started', 'more')
  }, e => {
    // tslint:disable-next-line:no-console
    console.error(`r-lsp server start failed: ${e.message}`)
  })

  subscriptions.push(services.registLanguageClient(client))
}
