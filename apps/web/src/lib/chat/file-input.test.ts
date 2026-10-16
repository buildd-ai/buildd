import { describe, expect, it } from 'bun:test';
import type { ChatFileRef } from '@buildd/shared';
import { MAX_MODEL_FILE_BYTES_PER_TURN, MAX_MODEL_IMAGE_BYTES, MAX_MODEL_PDF_BYTES, earlierFileNote, modelFileParts, modelInputs, textFileParts } from './file-input';

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

describe('modelInputs from the catalog', () => {
  const entry = (openRouterId: string, inputModalities?: string[]) => ({
    id: openRouterId.split('/')[1], canonicalId: null, openRouterId, provider: 'other' as const, displayName: openRouterId,
    contextLength: 1_000_000, created: 1, input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0, ...(inputModalities ? { inputModalities } : {}),
  });

  it('a model the catalog says reads images takes them, whatever its family', () => {
    const catalog = [entry('deepseek/deepseek-v4.1-flash', ['text', 'image']), entry('x-ai/grok-4.7', ['text', 'image', 'file'])];
    expect(modelInputs('openrouter', 'deepseek/deepseek-v4.1-flash', catalog)).toEqual({ images: true, pdf: false });
    expect(modelInputs('openrouter', 'x-ai/grok-4.7', catalog)).toEqual({ images: true, pdf: true });
  });

  it('the catalog saying text only wins over the family map', () => {
    expect(modelInputs('openrouter', 'google/gemini-3-flash', [entry('google/gemini-3-flash', ['text'])])).toEqual({ images: false, pdf: false });
  });

  it('a model the catalog does not describe falls back to the map', () => {
    expect(modelInputs('openrouter', 'deepseek/deepseek-v4', [entry('deepseek/deepseek-v4')])).toEqual({ images: false, pdf: false });
    expect(modelInputs('anthropic', 'claude-sonnet-5', [])).toEqual({ images: true, pdf: true });
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

describe('one turn\'s files are bounded before the call', () => {
  const pdfOf = (i: number, sizeBytes: number) => ref({ artifactId: `22222222-2222-4222-8222-22222222222${i}`, name: `r${i}.pdf`, mediaType: 'application/pdf', sizeBytes });

  it('PDFs and images past the per-turn total become a note, in the order attached', async () => {
    const size = Math.floor(MAX_MODEL_FILE_BYTES_PER_TURN * 0.45);
    expect(size).toBeLessThanOrEqual(MAX_MODEL_PDF_BYTES);
    const refs = [pdfOf(1, size), pdfOf(2, size), pdfOf(3, size)];
    const reads: string[] = [];
    const parts = await modelFileParts(refs, { images: true, pdf: true }, async r => { reads.push(r.name); return Buffer.alloc(r.sizeBytes); });
    expect(parts.map(p => p.type)).toEqual(['file', 'file', 'text']);
    expect((parts[2] as { text: string }).text).toContain('r3.pdf');
    expect((parts[2] as { text: string }).text).toContain('one message');
    // The third is never read: its bytes would only be dropped.
    expect(reads).toEqual(['r1.pdf', 'r2.pdf']);
  });

  it('a text file is quoted at the length the gate measured, and is read once', async () => {
    const text = ref({ name: 'notes.md', mediaType: 'text/markdown', sizeBytes: 5 });
    let reads = 0;
    const measured = await textFileParts([text], async () => { reads++; return Buffer.from('hello'); });
    expect(measured.get(text.artifactId)).toContain('hello');
    const parts = await modelFileParts([text], { images: false, pdf: false }, async () => { reads++; return Buffer.from('changed'); }, { textParts: measured });
    expect(parts).toEqual([{ type: 'text', text: measured.get(text.artifactId)! }]);
    expect(reads).toBe(1);
  });
});
