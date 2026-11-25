import { defineWorkspace } from 'vitest/config';

import { integrationProject, unitProject } from './vitest.workspace.js';

export default defineWorkspace([unitProject, integrationProject]);
