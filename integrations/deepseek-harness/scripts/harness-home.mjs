import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve DSH_HOME with Harness's blank, tilde and working-directory rules. */
export function resolveHarnessHome(env = process.env) {
  const home = homedir();
  const override = env.DSH_HOME;
  const selected =
    override !== undefined && override.trim().length > 0
      ? override
      : join(home, ".dsh");
  const expanded =
    selected === "~"
      ? home
      : selected.startsWith("~/") || selected.startsWith("~\\")
        ? join(home, selected.slice(2))
        : selected;
  return resolve(expanded);
}

if (typeof import.meta.main !== "boolean")
  throw new Error("Use a Node version accepted by dsh-rea-bundle's engines");
if (import.meta.main) console.log(resolveHarnessHome());
