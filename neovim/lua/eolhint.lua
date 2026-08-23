-- Temporary EOL hint experiment for piecetab editor semantics.
-- Remove this file (and the require('eolhint') line in init.lua) when done.
local eol_ns = vim.api.nvim_create_namespace('eolhint-demo')

function LineEndHint()
  local buf = vim.api.nvim_get_current_buf()
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ''
  local col = #line
  vim.api.nvim_buf_set_extmark(buf, eol_ns, row, col, {
    virt_text = { { ' <EOL>', 'Comment' } },
    virt_text_pos = 'eol',
    hl_mode = 'combine',
  })
end

vim.api.nvim_create_user_command('LineEndHint', LineEndHint, {})
