import latestVersion from 'latest-version';
import pTimeout from 'p-timeout';

/** A slow or unreachable registry must never hold up a run. */
const LOOKUP_TIMEOUT_MS = 3000;

/** Asks the registry for a package's latest published version. */
export type RegistryLookup = (npmPackage: string) => Promise<string>;

/** The latest published version of each package, or undefined for any the registry did not answer for. */
export async function latestAgentVersions(
  npmPackages: string[],
  lookup: RegistryLookup = latestVersion,
  timeoutMs = LOOKUP_TIMEOUT_MS,
) {
  const versions = await Promise.all(
    npmPackages.map((npmPackage) =>
      pTimeout(lookup(npmPackage), { milliseconds: timeoutMs }).catch(() => undefined),
    ),
  );
  return Object.fromEntries(npmPackages.map((npmPackage, index) => [npmPackage, versions[index]]));
}
