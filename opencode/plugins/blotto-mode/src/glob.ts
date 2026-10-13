const cache = new Map<string, RegExp>()
export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob)
  if (re) return re
  const src = glob.split("").map((ch) => ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("")
  re = new RegExp(`^${src}$`, "s")
  cache.set(glob, re)
  return re
}
export function globMatch(glob: string, s: string): boolean { return globToRegExp(glob).test(s) }
