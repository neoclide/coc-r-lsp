import winreg from "winreg"
import { WorkspaceConfiguration } from 'coc.nvim'
import { accessSync, constants, existsSync, statSync } from "fs"
import { delimiter, resolve } from "path"

export async function getRPath(config: WorkspaceConfiguration, cwd: string) {
  let path = config.get<string>("lsp.path")
  if (path && existsSync(path)) {
    return path
  }

  // Prefer the selected PATH installation before the Windows registry.
  const executable = process.platform === 'win32' ? 'R.exe' : 'R'
  const directories = process.env.PATH === undefined ? [] : process.env.PATH.split(delimiter)
  for (const directory of directories) {
    const candidate = resolve(cwd, directory, executable)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch (_) {
      // Missing, inaccessible and non-executable entries must not hide a later R.
    }
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
      console.log("found R in registry:", rhome)

      path = rhome + "\\bin\\R.exe"
    } catch (e) {
      path = ''
    }
    if (path && existsSync(path)) {
      return path
    }
  }

  return "R"
}
