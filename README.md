# .dotfiles
- Obtain private key and modify settings as per chezmoi documentation. e.g:
```bash
cat >> ~/.config/chezmoi/chezmoi.toml <<EOF
encryption = "age"
[age]
    identity = "~/.config/chezmoi/key.txt"
    recipient = "age17zeqh4rqpr0s0d2vn9yjjdxtavquh77htskxrwgyjz6dgzm8gfps3t6lnv"
EOF
```
- Install `chezmoi`, then `chezmoi init --apply wemoveon2` 
- Install chezmoi and initialize via `sh -c "$(curl -fsLS https://raw.githubusercontent.com/wemoveon2/dotfiles/master/install.sh)"`

