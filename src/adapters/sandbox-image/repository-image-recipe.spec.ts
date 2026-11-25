import { defaultImageName } from '@ai-hero/sandcastle/sandboxes/docker';
import { faker } from '@faker-js/faker';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { SandboxPreparationInvalid } from '../../ports/agent-session.js';
import { DOCKERFILE, recipeHash, SANDBOX_DIRECTORY } from './image-recipe.js';
import { baseImageName, RepositoryImageRecipe } from './repository-image-recipe.js';

describe('RepositoryImageRecipe', () => {
  it("builds the repository's Dockerfile for the host user", async () => {
    const { recipe, repoRoot, dockerfile } = await setup({});

    const base = unwrap(await recipe.base());

    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    expect(base).toEqual({
      dockerfileHash: recipeHash(dockerfile, uid, gid),
      contextDirectory: path.join(repoRoot, SANDBOX_DIRECTORY),
      buildArgs: { AGENT_UID: uid, AGENT_GID: gid },
    });
  });

  it('asks for jig init when the repository has no sandbox Dockerfile', async () => {
    const { recipe } = await setup({ withoutDockerfile: true });

    const base = await recipe.base();

    expect(base.isErr() && base.error).toBeInstanceOf(SandboxPreparationInvalid);
  });

  it('runs the image the config names, layering its agents on that image', async () => {
    const sandboxImage = `${faker.word.noun()}:${faker.word.noun()}`;
    const { recipe } = await setup({ sandboxImage });

    expect(recipe.image).toBe(sandboxImage);
    expect(recipe.agentLayer([]).split('\n')[0]).toBe(`FROM ${baseImageName(sandboxImage)}`);
  });

  it("runs the repository's own image when the config names none", async () => {
    const { recipe, repoRoot } = await setup({});

    expect(recipe.image).toBe(defaultImageName(repoRoot));
    expect(recipe.baseImage).toBe(baseImageName(recipe.image));
  });

  async function setup(input: { withoutDockerfile?: boolean; sandboxImage?: string }) {
    const repoRoot = await tempDirectory('jig-image-recipe-');
    const dockerfile = faker.lorem.lines(3);
    if (!input.withoutDockerfile) {
      await mkdir(path.join(repoRoot, SANDBOX_DIRECTORY), { recursive: true });
      await writeFile(path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE), dockerfile);
    }
    const recipe = new RepositoryImageRecipe(repoRoot, { sandboxImage: input.sandboxImage });
    return { recipe, repoRoot, dockerfile };
  }
});

describe('baseImageName', () => {
  it('derives the agent-free image from the sandbox image name', () => {
    const repo = faker.word.noun();

    expect(baseImageName(`sandcastle:${repo}`)).toBe(`sandcastle:${repo}-base`);
    expect(baseImageName(`localhost:5000/${repo}`)).toBe(`localhost:5000/${repo}:base`);
    expect(baseImageName(repo)).toBe(`${repo}:base`);
  });
});
