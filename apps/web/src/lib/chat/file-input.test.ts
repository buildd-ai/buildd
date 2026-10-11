import { describe, expect, it } from 'bun:test';
import type { ChatFileRef } from '@buildd/shared';
import { MAX_MODEL_IMAGE_BYTES, earlierFileNote, modelFileParts, modelInputs } from './file-input';

const ref = (over: Partial<ChatFileRef>): ChatFileRef => ({
  artifactId: '11111111-1111-4111-8111-111111111111', revision: 1, sha256: 'a'.repeat(64),
  name: 'chart.png', mediaType: 'image/png', sizeBytes: 4, ...over,
});
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const read = async () => bytes;

describe('modelInputs', () => {
  it('names the families that take images and PDFs, and nothing else', () => {
    expect(modelInputs('anthropic', 'claude-sonnet-5')).toEqual({ images: true, pdf: true });
    expect(modelInputs('openai', 'gpt-4o-mini')).toEqual({ images: true, pdf: false });
    expect(modelInputs('openai', 'gpt-3.5-turbo')).toEqual({ images: false, pdf: false });
    expect(modelInputs('openrouter', 'anthropic/claude-haiku-5')).toEqual({ images: true, pdf: true });
    expect(modelInputs('openrouter', 'google/gemini-3-flash')).toEqual({ images: true, pdf: true });
    expect(modelInputs('openrouter', 'deepseek/deepseek-v4')).toEqual({ images: false, pdf: false });
  });
});

describe('modelFileParts', () => {
  it('an image goes to a model that takes images as file input, the original bytes inline', async () => {
    const parts = await modelFileParts([ref({})], { images: true, pdf: false }, read);
    expect(parts).toEqual([{ type: 'file', mediaType: 'image/png', filename: 'chart.png', url: `data:image/png;base64,${bytes.toString('base64')}` }]);
  });

  it('a model that cannot view images gets a note naming the image, never a silent drop', async () => {
    const parts = await modelFileParts([ref({})], { images: false, pdf: false }, async () => { throw new Error('must not read'); });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('chart.png');
    expect((parts[0] as { text: string }).text).toContain('cannot view images');
  });

  it('a PDF the model cannot read gets a note; one it can goes as file input', async () => {
    const pdf = ref({ name: 'report.pdf', mediaType: 'application/pdf' });
    expect((await modelFileParts([pdf], { images: true, pdf: false }, read))[0]).toMatchObject({ type: 'text', text: expect.stringContaining('cannot read PDFs') });
    expect((await modelFileParts([pdf], { images: true, pdf: true }, read))[0]).toMatchObject({ type: 'file', mediaType: 'application/pdf' });
  });

  it('an image over what a model takes, or one that cannot be read, is a note', async () => {
    const big = ref({ sizeBytes: MAX_MODEL_IMAGE_BYTES + 1 });
    expect((await modelFileParts([big], { images: true, pdf: true }, read))[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Over the') });
    expect((await modelFileParts([ref({})], { images: true, pdf: true }, async () => null))[0]).toMatchObject({ type: 'text', text: expect.stringContaining('could not be read') });
  });

  it('a text file is quoted as material, not instructions', async () => {
    const csv = ref({ name: 'rows.csv', mediaType: 'text/csv', sizeBytes: 9 });
    const parts = await modelFileParts([csv], { images: false, pdf: false }, async () => Buffer.from('a,b\n1,2\n', 'utf8'));
    expect(parts[0]).toMatchObject({ type: 'text' });
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain('<attachment title="rows.csv"');
    expect(text).toContain('not instructions');
    expect(text).toContain('a,b\n1,2\n');
  });

  it('an earlier message file becomes a note naming it', () => {
    expect(earlierFileNote(ref({}))).toContain('Earlier image attached: chart.png');
  });
});
