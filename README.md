# dotfiles

Cross-machine development environment managed with [chezmoi](https://chezmoi.io).
One command sets up a new macOS, Linux, or Windows machine.

## What's synced

| Area | Files / Tools |
|---|---|
| **Shell** | `.zshrc`, `.zimrc`, `.zshenv`, `.zsh_aliases`, `.zsh_functions`, zim setup |
| **Prompt** | powerlevel10k (`.p10k.zsh`) |
| **Git** | `.gitconfig` |
| **Tmux** | `.tmux.conf` (catppuccin theme, vi keys, C-a prefix) |
| **SSH** | `.ssh/config`, `known_hosts`, ed25519 GitHub keys — all age-encrypted |
| **VS Code** | `settings.json`, `keybindings.json`, full 91-extension list (auto-installed) |
| **Neovim** | LazyVim starter bootstrap |
| **Claude Code** | global `CLAUDE.md`, RTK token-killer hook, agent definitions, plugin settings |
| **AWS** | `.saml2aws` (Okta SAML config) |

Plus install scripts that provision the underlying tools: `brew`/`apt` install of
git, age, go, rust, pyenv, docker, neovim, lazygit, jump, fzf, VS Code, tmux, etc.

## Install on a new machine

```bash
sh -c "$(curl -fsLS https://raw.githubusercontent.com/wemoveon2/dotfiles/master/install.sh)"
```

Equivalent to: `sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply wemoveon2`.

This will:
1. Install chezmoi if missing
2. Clone the repo into `~/.local/share/chezmoi`
3. Apply all dotfiles
4. Run install scripts (brew/apt packages, LazyVim bootstrap, VS Code extensions)

### Encryption setup (required before SSH config decrypts)

Encrypted files use [age](https://github.com/FiloSottile/age). You need the
private key on the new machine **before** running `chezmoi apply` — otherwise
SSH files won't decrypt.

```bash
mkdir -p ~/.config/chezmoi
# Paste your age private key (the one from chezmoi.txt — keep it out of git!)
$EDITOR ~/.config/chezmoi/key.txt
chmod 600 ~/.config/chezmoi/key.txt

cat > ~/.config/chezmoi/chezmoi.toml <<'EOF'
encryption = "age"
[age]
    identity = "~/.config/chezmoi/key.txt"
    recipient = "age17zeqh4rqpr0s0d2vn9yjjdxtavquh77htskxrwgyjz6dgzm8gfps3t6lnv"
EOF
```

If you've lost the key, the SSH files are unrecoverable — generate new ones,
re-add to GitHub, then `chezmoi add --encrypt ~/.ssh/...`.

## Day-to-day operations

```bash
# Pull remote changes and re-apply
chezmoi update

# See what would change without applying
chezmoi diff

# Edit a tracked file (opens in $EDITOR, writes to source on save)
chezmoi edit ~/.zshrc

# Add a new file to tracking
chezmoi add ~/.somerc

# Add a file with encryption
chezmoi add --encrypt ~/.ssh/something

# Apply pending source changes to target
chezmoi apply

# Push your source edits
cd ~/.local/share/chezmoi
git add -A && git commit -m '...' && git push
```

## Layout

```
.chezmoitemplates/       # Shared template content (e.g. VS Code config used by both OS paths)
.chezmoiignore.tmpl      # Per-OS file inclusion rules

dot_claude/              # → ~/.claude/      (Claude Code config, see README in subsystem)
dot_config/Code/User/    # → ~/.config/Code/User/   (VS Code on Linux)
Library/.../Code/User/   # → ~/Library/Application Support/Code/User/  (VS Code on macOS)
private_dot_ssh/         # → ~/.ssh/        (encrypted)

private_dot_zshrc.tmpl   # → ~/.zshrc       (zim bootstrap + shell setup)
dot_zimrc                # → ~/.zimrc        (zim modules)
dot_zsh_aliases          # → ~/.zsh_aliases (k8s, git, work shortcuts)
dot_zsh_functions        # → ~/.zsh_functions
dot_zshenv               # → ~/.zshenv
dot_p10k.zsh             # → ~/.p10k.zsh
dot_gitconfig            # → ~/.gitconfig
dot_tmux.conf            # → ~/.tmux.conf
dot_saml2aws             # → ~/.saml2aws

install.sh               # bootstrap one-liner (not applied; used by curl)
chezmoi.txt              # age private key — gitignored, NEVER commit

run_once_install_dev_tools.sh.tmpl           # docker, neovim, pyenv, go, rust, VS Code
run_once_install_shell_packages.sh.tmpl      # zsh, tmux, lazygit, jump, age, fzf
run_once_after_install_shell-plugins.sh.tmpl # shellcheck, fd-find
run_once_install-lazyvim.sh.tmpl             # clones LazyVim starter into ~/.config/nvim
run_onchange_install-vscode-extensions.sh.tmpl  # installs missing VS Code extensions
```

Naming conventions chezmoi uses (no underscores in the README — they're real prefixes on disk):

- `dot_X` → `~/.X`
- `private_X` → file with mode 0600
- `executable_X` → file with executable bit
- `X.tmpl` → Go-templated
- `run_once_X` / `run_onchange_X` → scripts triggered by `chezmoi apply`

## Per-OS notes

### macOS
Fully supported. Bootstrap installs everything via Homebrew. VS Code config
lands in `~/Library/Application Support/Code/User/`.

### Linux
Mostly supported. Install scripts use apt. VS Code apt-repo setup is **not**
automated yet — install VS Code manually before first apply, or the extension
install script will skip silently. VS Code config lands in `~/.config/Code/User/`.

### Windows
Not yet wired. The Claude Code config templates will work since they use
`{{ .chezmoi.homeDir }}`. VS Code Windows path (`%APPDATA%/Code/User/`) would
need a third destination wrapper file added under chezmoi source.

### Remote SSH servers (e.g. q8)
Headless servers don't need VS Code or LazyVim. You'd typically run a
targeted apply: `chezmoi apply ~/.zsh_aliases ~/.tmux.conf ~/.gitconfig`
rather than the full bootstrap.

## Common customizations

### Add a new VS Code extension
After installing it locally:
```bash
# regenerate the tracked list
code --list-extensions | sort > /tmp/exts.txt
# diff against the list in run_onchange_install-vscode-extensions.sh.tmpl
# paste additions, commit, push
```

### Add a new shell alias
```bash
chezmoi edit ~/.zsh_aliases    # opens in editor
chezmoi apply                  # writes to ~/.zsh_aliases
# in source: cd ~/.local/share/chezmoi && git commit -am 'add alias' && git push
```

### Pin LazyVim plugin versions across machines
LazyVim's `lazy-lock.json` is not yet tracked. To pin: fork LazyVim/starter to
your GitHub, point `run_once_install-lazyvim.sh.tmpl` at your fork, and commit
`lazy-lock.json` there.

### Add a per-OS file
1. Create `.chezmoitemplates/myfile.txt` with the shared content.
2. Add destination wrappers like `Library/path/myfile.tmpl` and
   `dot_config/path/myfile.tmpl` each containing
   `{{ template "myfile.txt" . -}}`.
3. Update `.chezmoiignore.tmpl` to ignore the wrong path per OS.

## Caveats

- `chezmoi.txt` (age private key) is `.gitignored`. Move it between machines
  out of band (1Password / encrypted USB / secure paste).
- VS Code extensions are install-only; the script never uninstalls.
- The `dot_saml2aws` file has work-specific Okta URLs/usernames — fork if you
  use a different SAML setup.
- macOS-only paths in `.zshrc` are templated for darwin/linux where needed.
