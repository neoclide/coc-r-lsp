# Upstream review — 2026-10-03

Downstream baseline a16333a; last named import 136e49c159f1b6c03794fd6b9fe3b6e295b8bdd6 (2020-09-13).
Verified independent upstream REditorSupport/vscode-r-lsp master ends at 7d193194aa4e0c2ee495f226130063eafc9ca9fc (2021-07-20). Its README announces integration into vscode-R. This port intentionally targets the final independent extension; it does not claim parity with the successor vscode-R project.

- Ported 09bfda63f0dbe10eeaeeab18330355c50f7f25f3: supply an R/r file watcher through the language client's synchronization contract.
- Ported d93394ae290d1dafc98257b53b14fb689b638236 PATH-first executable lookup ahead of the Windows registry. Preserve explicit r.lsp.path precedence, fallback to R, and tolerate an unset PATH. Do not rename/deprecate Coc's existing path setting or introduce VS Code rpath settings.
- Adapted socket error handling present in a57e3a2: log socket errors to the existing output channel. The connection promise is already resolved after connection, so an ineffective late rejection is not copied; the language-client reader/writer handles connection shutdown.
- Retain Coc document selectors, rmd support, workspace-specific clients, event subscriptions, and configuration defaults. VS Code URI conversion workarounds, notebook host changes and vscode-languageclient migration are omitted because Coc supplies its own protocol/URI adapter. Automatic restart behavior remains unchanged.

Validation: original dependency lock installed with yarn --frozen-lockfile --ignore-scripts. Original Webpack 4 build fails on Node 24's disabled MD4 (ERR_OSSL_EVP_UNSUPPORTED); with the per-command NODE_OPTIONS=--openssl-legacy-provider compatibility setting both baseline and final build pass. No global setting or dependency version was changed. TypeScript --noEmit passes. Five Node regression tests cover explicit path precedence, Windows PATH with spaces, registry fallback/missing PATH, Unix PATH order, and client watcher/selectors/socket error handling. Contract inventory has no removed/changed public contracts; diff --check passes.

Real R/languageserver integration was not run: R is not installed on this host. Vim/Neovim editor lifecycle with a real R process therefore remains unverified. Test harness uses the repository's existing TypeScript transpiler and mocked host/process interfaces, not a replacement language server. The tests require a modern Node runtime with node:test.

## PATH candidate review fix

The PATH search now skips directories and candidates that cannot be executed on Unix, continuing to later entries. Windows candidates must be files and accessible; explicit `r.lsp.path` and registry fallback behavior are unchanged. A real-filesystem regression includes an earlier directory, a non-executable file, and a later executable. It fails against the pre-fix resolver and passes with the fix. A second regression covers inaccessible candidates and the existing `R` fallback.

Cloud validation on Node 24.19.0: frozen-lock Yarn install with scripts disabled, 7/7 Node tests, TypeScript `--noEmit`, and Webpack build with per-command `NODE_OPTIONS=--openssl-legacy-provider` all pass. Manifest and lockfile are unchanged; `git diff --check` passes. Independent code review found no blocking issue. Real R/editor integration remains unrun because R is unavailable.

GitHub Codex review identified a further cwd mismatch for relative and empty PATH components. The resolver now receives the same working directory used to start the R client and returns absolute candidates resolved from it. An unset PATH retains fallback behavior; an empty component searches the client's working directory. The new real-filesystem regression fails against the preceding resolver and passes after the fix; the client regression also verifies that workspace cwd reaches the resolver. All 8 tests, TypeScript, the compatibility-mode Webpack build, and `git diff --check` pass on the cloud host. Real R/editor integration remains unverified.
