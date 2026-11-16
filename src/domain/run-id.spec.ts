import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import { newRunId, runIdSchema } from './run-id.js';

describe('runIdSchema', () => {
  it('accepts an id made of lowercase letters, digits and hyphens', () => {
    const id = `${runId()}-${faker.number.int({ min: 0, max: 99 })}`;

    expect(runIdSchema.parse(id)).toBe(id);
  });

  it.each(['../x', 'a/b', 'Upper', 'two words', ''])('refuses "%s"', (raw) => {
    expect(runIdSchema.safeParse(raw).success).toBe(false);
  });
});

describe('newRunId', () => {
  it("names the run after the request's first heading", () => {
    const [first, second] = faker.helpers.multiple(() => lowerWord(), { count: 2 });

    const id = newRunId({ file: `${lowerWord()}.md`, text: `# ${first} ${second}!\n\nBody` });

    expect(id).toMatch(new RegExp(`^${first}-${second}-[0-9a-f]{8}$`));
  });

  it('skips text before the heading and a deeper heading', () => {
    const heading = lowerWord();

    const id = newRunId({
      file: `${lowerWord()}.md`,
      text: `${faker.lorem.sentence()}\n## ${lowerWord()}\n# ${heading}\n`,
    });

    expect(id).toMatch(new RegExp(`^${heading}-[0-9a-f]{8}$`));
  });

  it('names the run after the request file when it has no heading', () => {
    const name = lowerWord();

    const id = newRunId({ file: `/tmp/requests/${name}.md`, text: faker.lorem.sentence() });

    expect(id).toMatch(new RegExp(`^${name}-[0-9a-f]{8}$`));
  });

  it('drops accents and keeps the letters under them', () => {
    const id = newRunId({ file: `${lowerWord()}.md`, text: '# Café crème' });

    expect(id).toMatch(/^cafe-creme-[0-9a-f]{8}$/);
  });

  it('is named stdin when neither heading nor file name has a letter or digit', () => {
    const id = newRunId({ file: '/tmp/__.md', text: '# 🚀' });

    expect(id).toMatch(/^stdin-[0-9a-f]{8}$/);
  });

  it('is named stdin when the request has no heading and no file', () => {
    const id = newRunId({ text: faker.lorem.paragraph() });

    expect(id).toMatch(/^stdin-[0-9a-f]{8}$/);
  });

  it('cuts a long name at a word boundary', () => {
    const words = faker.helpers.multiple(() => faker.string.alpha({ length: 7, casing: 'lower' }), {
      count: 12,
    });

    const id = newRunId({ file: `${lowerWord()}.md`, text: `# ${words.join(' ')}` });

    const name = id.replace(/-[0-9a-f]{8}$/, '');
    expect(name.length).toBeLessThanOrEqual(40);
    expect(words.join('-').startsWith(`${name}-`)).toBe(true);
  });

  it('cuts a single long word at the limit', () => {
    const word = faker.string.alpha({ length: 60, casing: 'lower' });

    const id = newRunId({ file: `${lowerWord()}.md`, text: `# ${word}` });

    expect(id).toBe(`${word.slice(0, 40)}-${id.slice(-8)}`);
  });

  it('gives two runs of the same request different ids', () => {
    const request = { file: `${lowerWord()}.md`, text: `# ${faker.lorem.words()}` };

    expect(newRunId(request)).not.toBe(newRunId(request));
  });

  it('always produces an id the schema accepts', () => {
    const id = newRunId({ file: faker.system.filePath(), text: `# ${faker.lorem.sentence()}` });

    expect(runIdSchema.safeParse(id).success).toBe(true);
  });
});

function lowerWord() {
  return faker.string.alpha({ length: 6, casing: 'lower' });
}
