-- Neovim init.lua (converted from init.vim)
-- Shared Vim configuration lives in ~/.vimrc (dotfiles); this file only
-- sets up Neovim-specific runtime paths and Lua modules.

vim.opt.runtimepath:prepend(vim.fn.expand('$HOME/.vim'))
vim.opt.runtimepath:append(vim.fn.expand('$HOME/.vim/after'))
vim.env.MYVIMRC = vim.fn.expand('$HOME/.vimrc')
vim.env.VIMRUNTIME = ''
vim.cmd('source ' .. vim.fn.fnameescape(vim.env.MYVIMRC))

vim.pack.add({
  'https://github.com/neovim/nvim-lspconfig',
  'https://github.com/mason-org/mason.nvim',
  'https://github.com/mason-org/mason-lspconfig.nvim',
  'https://github.com/hrsh7th/cmp-nvim-lsp',
})

-- Lua LSP: nvim-lspconfig 已提供 lua_ls 默认配置，这里只需启用它和 inlay hints
vim.lsp.enable('lua_ls')
vim.lsp.inlay_hint.enable()
