import { test } from "node:test"
import assert from "node:assert/strict"
import { familyDenied, canonicalFamily, ruleCovers, classify, extractFamilies } from "../policy.js"

test("canonicalFamily expands multi-subcommand tools via the safe map only", () => {
  assert.equal(canonicalFamily("git fetch origin"), "git fetch")
  assert.equal(canonicalFamily("git remote -v"), "git remote -v")
  assert.equal(canonicalFamily("git remote add origin https://x"), null)
  assert.equal(canonicalFamily("docker compose ps"), "docker compose ps")
  assert.equal(canonicalFamily("docker compose exec web rm -rf /"), null)
  assert.equal(canonicalFamily("systemctl --user status sunshine"), "systemctl --user status")
  assert.equal(canonicalFamily("dpkg -l | grep sbx"), "dpkg -l")
  assert.equal(canonicalFamily("gs branch ls"), "gs branch ls")
})

test("canonicalFamily proposes plain patterns for benign utilities", () => {
  assert.equal(canonicalFamily("sort -u file"), "sort")
  assert.equal(canonicalFamily("RAILS_ENV=test bin/rails test"), null) // path → code execution
  assert.equal(canonicalFamily("timeout 5 curl -sS example.com"), null) // timeout wrapper denied
})

test("familyDenied gives reasons for wrappers, interpreters, paths and mutations", () => {
  assert.match(familyDenied("python3 -c 'print(1)'"), /code execution/)
  assert.match(familyDenied("/usr/bin/rm -rf /tmp/x"), /code execution/)
  assert.match(familyDenied("bin/rails db:migrate"), /code execution/)
  assert.match(familyDenied("rm -rf build"), /destructive/)
  assert.match(familyDenied("kill 1234"), /process control/)
  assert.match(familyDenied("curl -sS https://example.com"), /network/)
  assert.match(familyDenied("nohup make"), /code execution/)
  assert.match(familyDenied("docker compose exec web rm -rf /"), /read-only subcommand/)
  assert.equal(familyDenied("ls -la"), null)
  assert.equal(familyDenied("git fetch origin"), null)
})

test("ruleCovers is glob-equivalent and whole-string", () => {  assert.ok(ruleCovers("ls *", "ls"))
  assert.ok(ruleCovers("git fetch *", "git fetch"))
  assert.ok(ruleCovers("git remote -v", "git remote -v"))
  // a trailing-star rule covers deeper subcommands (V2 semantics)
  assert.ok(ruleCovers("git remote *", "git remote -v"))
  // ? is exactly one character
  assert.ok(ruleCovers("grep ?", "grep x"))
  assert.ok(!ruleCovers("grep ?", "grep -n"))
  // a bare rule covers only the exact command
  assert.ok(!ruleCovers("wc", "wc -l"))
})

test("classify filters covered, denied, and rare families and orders evidence", () => {
  const observed = new Map([
    ["git fetch", { count: 4, examples: ["git fetch origin", "git fetch upstream"] }],
    ["sort", { count: 9, examples: ["find . | sort"] }],
    ["ls", { count: 30, examples: ["ls -la"] }],
    ["rm", { count: 12, examples: ["rm -rf build"] }],
    ["sleep", { count: 1, examples: ["sleep 1"] }],
    ["docker compose", { count: 5, examples: ["docker compose exec web rm -rf /"] }],
  ])
  const { proposals, skipped } = classify(observed, ["ls *", "sleep *"], { minCount: 3 })
  assert.deepEqual(proposals.map((p) => p.pattern), ["git fetch *", "sort *"])
  assert.deepEqual(proposals[0].examples, ["git fetch origin", "git fetch upstream"])
  assert.equal(proposals[0].count, 4)
  assert.deepEqual(skipped.covered.sort(), ["ls", "sleep"])
  assert.equal(skipped.denied[0].family, "rm")
  assert.match(skipped.denied[0].reason, /destructive/)
  // a multi-subcommand family whose example is not read-only is denied, not proposed
  const docker = skipped.denied.find((d) => d.family === "docker compose")
  assert.match(docker.reason, /read-only subcommand/)
  assert.deepEqual(skipped.rare, [])
})

test("canonicalFamily never proposes shell keywords, policy-less tools, or in-place mutation", () => {
  assert.equal(canonicalFamily("for x in a b; do rm -rf /; done"), null)
  assert.equal(canonicalFamily("while read f; do cat $f; done"), null)
  assert.equal(canonicalFamily("if [ -f x ]; then rm -rf /; fi"), null)
  assert.equal(canonicalFamily("cargo build --release"), null)
  assert.equal(canonicalFamily("go run ./cmd"), null)
  assert.equal(canonicalFamily("opencode service restart"), null)
  assert.equal(canonicalFamily("sed -i 's/a/b/' f"), null)
  assert.equal(canonicalFamily("awk -i inplace '{print}' f"), null)
  assert.equal(canonicalFamily("ansible-playbook site.yml"), null)
  assert.equal(canonicalFamily("busctl call org.x org.y org.z"), null)
  assert.equal(canonicalFamily("make -j4"), null)
  assert.match(familyDenied("for x in a b; do echo; done"), /keyword/)
})

test("extractFamilies uses only the first line — heredoc bodies are not families", () => {
  assert.deepEqual(extractFamilies("cat <<'EOF'\nfor x in a b; do rm -rf /; done\nEOF"), ["cat"])
  assert.deepEqual(extractFamilies('python3 -c "\nimport os\nos.exit(0)\n"'), ["python3"])
  assert.deepEqual(extractFamilies("cat a\nhead b"), ["cat"])
})

test("canonicalFamily denies exec wrappers and display/system mutation tools", () => {
  assert.equal(canonicalFamily("srt -- python3 x.py"), null)
  assert.equal(canonicalFamily("xrandr --output HDMI-1 --mode 1920x1080"), null)
  assert.equal(canonicalFamily("kwin_wayland --replace"), null)
  assert.match(familyDenied("srt -- anything"), /code execution/)
  assert.match(familyDenied("xrandr -o normal"), /display or system state mutation/)
})

test("classify denies from every example, not only the first", () => {
  const observed = new Map([
    ["sed", { count: 5, examples: ["sed -n 1,10p f", "sed -i s/a/b/ f"] }],
  ])
  const { proposals, skipped } = classify(observed, [], { minCount: 3 })
  assert.deepEqual(proposals, [])
  assert.match(skipped.denied[0].reason, /in-place/)
})
