import latestVersion from 'latest-version';
import pTimeout from 'p-timeout';

/** A slow or unreachable registry must never hold up a run. */
const LOOKUP_TIMEOUT_MS = 3000;

/** The latest published version of each package, or undefined for any the registry did not answer for. */
export async function latestAgentVersions(npmPackages: string[]) {
  const versions = await Promise.all(
    npmPackages.map((npmPackage) =>
      pTimeout(latestVersion(npmPackage), { milliseconds: LOOKUP_TIMEOUT_MS }).catch(
        () => undefined,
      ),
    ),
  );
  return Object.fromEntries(npmPackages.map((npmPackage, index) => [npmPackage, versions[index]]));
}
