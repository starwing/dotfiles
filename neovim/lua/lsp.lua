-- Lua LSP via Neovim's built-in LSP (no plugin needed, Nvim 0.11+).
-- Provides inlay hints (setType + paramName) for Lua files.
vim.lsp.config('lua_ls', {
  cmd = { 'lua-language-server' },
  settings = {
    Lua = {
      hint = { enable = true, setType = true },
      diagnostics = { globals = { 'vim' } },
      workspace = { library = { vim.env.VIMRUNTIME } },
    },
  },
})
vim.lsp.enable('lua_ls')
-- inlay hints render only when explicitly enabled (off by default)
vim.lsp.inlay_hint.enable()
