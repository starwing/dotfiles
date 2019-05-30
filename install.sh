#!/bin/sh

SCRIPT=$(perl -MCwd -e 'print Cwd::abs_path shift' "$0")
SCRIPTPATH=$(dirname "$SCRIPT")

PREFIX=$HOME
UNINSTALL=$SCRIPTPATH/uninstall.sh
UNINSTALL_CMDS=""

prepend() {
    UNINSTALL_CMDS="$(echo $1)
$UNINSTALL_CMDS"
}

find_backname() {
    local f="$1.orig"
    local idx=1
    while [ -e "$f" ]; do
	f=$f.$i
	i=$(expr $i++)
    done
    echo $f
}

make_link() {
    local src=$1
    local dst=$2
    local bak
    if [ -e "$PREFIX/$dst" -a ! -L "$PREFIX/$dst" ]; then
	bak=$(find_backname $PREFIX/$dst)
	echo Backup $PREFIX/$dst to $bak ...
	prepend "mv $bak $PREFIX/$dst"
	mv $PREFIX/$dst $bak
    fi
    echo Install $SCRIPTPATH/$src
    prepend "[ -L $PREFIX/$dst ] && rm -f $PREFIX/$dst"
    ln -sf $SCRIPTPATH/$src $PREFIX/$dst
}

make_link git/config               .gitconfig
make_link git/ignore               .gitignore_global
make_link git/commit_msg           .stCommitMsg
make_link tmux                     .tmux
make_link tmux/tmux.conf           .tmux.conf
make_link vim                      .vim
make_link vim/_vimrc               .vimrc
make_link zsh/zplug/zplug          .zplug
make_link zsh/sorin-ionescu/prezto .zprezto

for f in $(cd $SCRIPTPATH; ls zsh/prezto-runcoms/*); do
    make_link $f ".$(basename $f)"
done

[ ! -e $UNINSTALL ] && {
    cat <<EOF > $UNINSTALL
#!/bin/sh
# initialize content...
rm $UNINSTALL
EOF
    chmod a+x $UNINSTALL
}

cat <<EOF > $UNINSTALL
#!/bin/sh
# uninstall cmds at $(date "+%Y-%m-%d %H:%M:%S")
$UNINSTALL_CMDS

$(tail -n+2 $UNINSTALL)
EOF
