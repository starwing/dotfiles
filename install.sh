#!/bin/bash

SCRIPTPATH="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

PREFIX=$HOME/
UNINSTALL=$PREFIX.uninstall_dotfiles.sh
UNINSTALL_CMDS=""

record() {
  UNINSTALL_CMDS="$1
  $UNINSTALL_CMDS"
}

find_backname() {
  local f="$1.orig"
  local idx=1
  while [ -e "$f" ]; do
    f=$f.$idx
    idx=$((idx++))
  done
  echo "$f"
}

make_link() {
  local src=$1
  local dst=$2
  local bak
  if [ -e "$PREFIX$dst" ] && [ ! -L "$PREFIX$dst" ]; then
    bak=$(find_backname "$PREFIX$dst")
    echo "Backup $PREFIX$dst to $bak ..."
    record "mv $bak $PREFIX$dst"
    mv "$PREFIX$dst" "$bak"
  fi
  dir=$(dirname "$PREFIX$dst")
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
  fi
  echo "Install $SCRIPTPATH/$src"
  record "[ -L $PREFIX$dst ] && rm -f $PREFIX$dst"
  ln -sf "$SCRIPTPATH/$src" "$PREFIX$dst"
}

mkdir "$HOME/.cargo"

if [ "$SCRIPTPATH" != "$HOME/.dotfiles" ]; then
  PREFIX='' make_link "" "$HOME/.dotfiles"
fi

make_link git/config               .gitconfig
make_link git/ignore               .gitignore_global
make_link git/commit_msg           .stCommitMsg
make_link cargo/config             .cargo/config
make_link tmux                     .tmux
make_link tmux/tmux.conf           .tmux.conf
make_link vim                      .vim
make_link vim/_vimrc               .vimrc
make_link vim/neovim_init.vim      .config/nvim/init.vim
make_link zsh/zplug/zplug          .zplug
make_link zsh/sorin-ionescu/prezto .zprezto

for f in $(cd "$SCRIPTPATH" && ls zsh/prezto-runcoms/*); do
  make_link "$f" ".$(basename "$f")"
done

[ ! -e "$UNINSTALL" ] && {
  cat <<EOF > "$UNINSTALL"
#!/bin/sh
# initialize content...
rm $UNINSTALL
EOF
chmod a+x "$UNINSTALL"
}

cat <<EOF > "$UNINSTALL.new"

#!/bin/sh
# uninstall cmds at $(date "+%Y-%m-%d %H:%M:%S")
$UNINSTALL_CMDS

$(tail -n+2 "$UNINSTALL")
EOF

mv "$UNINSTALL.new" "$UNINSTALL"

# vim: ft=sh nu et sw=2
