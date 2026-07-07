// Only reachable via limun.json's scopes["./examples/"] override — proves
// a scoped module specifier map wins over the top-level "bar" mapping when
// the importing module's own URL falls under the scope prefix.
export function bar() {
  return "scoped bar (examples/ override)";
}
