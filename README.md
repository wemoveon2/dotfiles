# .dotfiles
- Obtain private key and modify settings as per chezmoi documentation. e.g:
```bash
cat >> ~/.config/chezmoi/chezmoi.toml <<EOF
encryption = "age"
[age]
    identity = "~/.config/chezmoi/key.txt"
    recipient = "age193wd0hfuhtjfsunlq3c83s8m93pde442dkcn7lmj3lspeekm9g7stwutrl"
EOF
```
- Install `chezmoi`, then `chezmoi init --apply wemoveon2` 
- Install chezmoi and initialize via `sh -c "$(curl -fsLS https://raw.githubusercontent.com/wemoveon2/dotfiles/master/install.sh)"`

