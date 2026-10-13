import type { RuleDef } from "../config"

export const DEFAULT_RULES: RuleDef[] = [
  { id: "rm-root-home", kinds: ["bash"], reason: "recursive delete of /, home, or a path outside the worktree",
    match: { deleteOutsideWorktree: true } },
  { id: "write-ssh", kinds: ["bash", "edit", "external_directory"], reason: "write under ~/.ssh",
    match: { pathWrite: ["~/.ssh", "~/.ssh/**"] } },
  { id: "write-shell-profile", kinds: ["bash", "edit", "external_directory"], reason: "write to a shell profile",
    match: { pathWrite: ["~/.bashrc", "~/.zshrc", "~/.profile", "~/.zshenv", "~/.zprofile", "~/.bash_profile", "~/.bash_login", "~/.config/fish/config.fish"] } },
  // write-self must precede write-opencode-config: both match .opencode/blotto-mode.json and the first hit names the rule.
  { id: "write-self", kinds: ["bash", "edit", "external_directory"], reason: "write to blotto-mode config or log",
    match: { pathWrite: ["**/blotto-mode.json", "~/.local/share/blotto-mode", "~/.local/share/blotto-mode/**"] } },
  { id: "write-opencode-config", kinds: ["bash", "edit", "external_directory"], reason: "write under OpenCode config",
    match: { pathWrite: ["~/.config/opencode", "~/.config/opencode/**", "**/.opencode", "**/.opencode/**"] } },
  { id: "sudo", kinds: ["bash"], reason: "privilege escalation", match: { command: ["sudo", "doas", "su", "pkexec", "run0"] } },
  { id: "mkfs-dd", kinds: ["bash"], reason: "raw disk operation", match: [
    { command: ["wipefs", "fdisk", "parted", "sfdisk"] },
    { regex: "(^|[\\s;&|])mkfs(\\.[a-z0-9]+)?\\s" },
    { command: "dd", argsGlob: "*of=/dev/*" },
  ] },
  { id: "chmod-root", kinds: ["bash"], reason: "recursive permission change on / or home", match: [
    { command: ["chmod", "chown", "chgrp"], argsGlob: "*-R* /" },
    { command: ["chmod", "chown", "chgrp"], argsGlob: "*-R* /home/*" },
    { command: ["chmod", "chown", "chgrp"], argsGlob: "*-R* ~" },
    { command: ["chmod", "chown", "chgrp"], argsRegex: "\\s(-[a-zA-Z]*R[a-zA-Z]*|--recursive)(\\s.*)?\\s(~/?|\\$HOME/?|\\$\\{HOME\\}/?)(\\s|$)" },
  ] },
  { id: "curl-pipe-sh", kinds: ["bash"], reason: "remote script piped into an interpreter", match: [
    { downloadToInterpreter: true },
    // I5: process substitution (bash <(curl …), source <(wget …)); bash-parser cannot parse it.
    { regex: "(^|[;&|\\s(/])(bash|sh|zsh|dash|ksh|fish|source|\\.)(\\s+[-+]\\S+)*\\s+<\\(\\s*(\\S*/)?(curl|wget)\\b" },
  ] },
  { id: "persistence", kinds: ["bash", "edit", "external_directory"], reason: "installs something that runs later", match: [
    // M3: installing or removing a crontab (-e, -r, a file, or - for stdin); listing (-l) is fine.
    { command: "crontab", argsRegex: "(?<!\\s-u)\\s(-[a-zA-Z]*[er][a-zA-Z]*|-|[^-\\s]\\S*)(?=\\s|$)" },
    { command: "systemctl", subcommand: "enable" },
    { pathWrite: ["~/.config/systemd/**", "~/.config/autostart/**", "/etc/cron*/**", "/etc/systemd/**", "/etc/init.d/**", "~/.config/opencode/plugins/**"] },
  ] },
  { id: "exfil-env", kinds: ["bash"], reason: "environment or credential files sent to the network",
    match: { pipeToNetwork: { sources: ["env", "printenv", "set", "export"], fileGlobs: ["**/.env", "**/.env.*", "~/.aws/**", "~/.ssh/**", "~/.netrc", "~/.npmrc", "~/.pypirc", "~/.docker/config.json", "~/.kube/**", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/credentials*", "**/secrets*"] } } },
  { id: "git-destructive-remote", kinds: ["bash"], reason: "destructive remote git operation", match: [
    { command: "git", subcommand: "push", argsGlob: "*--force *" },
    { command: "git", subcommand: "push", argsGlob: "*--force" },
    { command: "git", subcommand: "push", argsGlob: "* -f *" },
    { command: "git", subcommand: "push", argsGlob: "* -f" },
    { command: "git", subcommand: "push", argsGlob: "*--delete*" },
    { command: "git", subcommand: "push", argsGlob: "* :*" },
    // M2: --force-with-lease / --force-if-includes, --mirror, -d, short clusters with f or d (-fu), +refspecs.
    { command: "git", subcommand: "push", argsRegex: "\\s(--force-with-lease(=\\S*)?|--force-if-includes|--mirror|-[a-zA-Z]*[fd][a-zA-Z]*|\\+\\S+)(?=\\s|$)" },
  ] },
]
