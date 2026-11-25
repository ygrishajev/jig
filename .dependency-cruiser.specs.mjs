import configuration, { specRules } from './.dependency-cruiser.mjs';

/** @type {import('dependency-cruiser').IConfiguration} */
export default { ...configuration, forbidden: specRules };
