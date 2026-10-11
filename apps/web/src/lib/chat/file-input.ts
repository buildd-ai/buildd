import type { ChatFileRef, ChatProvider } from '@buildd/shared';
import { quoteAttachment } from '@/lib/artifact-chat-attachments';

/**
 * How an image or file a message carries reaches the model (Living Specs C3).
 *
 * Images and PDFs go as file input only to a model that takes them; any other
 * model gets an explicit note naming the file and saying it cannot read it,
 * never a silent drop. Text-like files are read and quoted like a long paste.
 * Only the message being sent carries file content; an earlier message's file
 * becomes a note, so the bytes are not re-sent every turn.
 *
 * No catalog field says which models take images, so this is a short explicit
 * map by provider and model family. A model it does not name is treated as
 * text-only: the person sees the note, not a wrong answer about a picture the
 * model never saw.
 */

export interface ModelInputs { images: boolean; pdf: boolean }

const OPENAI_VISION = /^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)/;

export function modelInputs(provider: ChatProvider, modelId: string): ModelInputs {
  const id = modelId.toLowerCase();
  if (provider === 'anthropic') return { images: id.startsWith('claude-'), pdf: id.startsWith('claude-') };
  if (provider === 'openai') return { images: OPENAI_VISION.test(id), pdf: false };
  // OpenRouter: `vendor/model`.
  const [vendor, model = ''] = id.split('/');
  if (vendor === 'anthropic') return { images: model.startsWith('claude'), pdf: model.startsWith('claude') };
  if (vendor === 'openai') return { images: OPENAI_VISION.test(model), pdf: false };
  if (vendor === 'google') return { images: model.startsWith('gemini'), pdf: model.startsWith('gemini') };
  return { images: false, pdf: false };
}

/** Largest image sent to a model inline (providers cap a single image near 5 MB). */
export const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MODEL_PDF_BYTES = 10 * 1024 * 1024;
/** Longest text file quoted whole; a longer one gets a note. */
export const MAX_MODEL_TEXT_FILE_CHARS = 100_000;

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

const sizeLabel = (bytes: number): string => (bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`);

const safeName = (name: string): string => name.replace(/[\]\n\r]/g, ' ');

export type ModelFilePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mediaType: string; filename: string; url: string };

/** The note an earlier message's file becomes. */
export function earlierFileNote(ref: Pick<ChatFileRef, 'name' | 'mediaType' | 'sizeBytes'>): string {
  const kind = ref.mediaType.startsWith('image/') ? 'image' : 'file';
  return `[Earlier ${kind} attached: ${safeName(ref.name)}, ${ref.mediaType}, ${sizeLabel(ref.sizeBytes)}. Its content is not in this turn; ask the person to attach it again to look at it.]`;
}

/**
 * The model's view of each file in the message being sent. `read` returns the
 * original bytes, or null when they cannot be read (or are over `maxBytes`).
 */
export async function modelFileParts(
  refs: readonly ChatFileRef[],
  inputs: ModelInputs,
  read: (ref: ChatFileRef, maxBytes: number) => Promise<Buffer | null>,
): Promise<ModelFilePart[]> {
  const out: ModelFilePart[] = [];
  for (const ref of refs) {
    const name = safeName(ref.name);
    const size = sizeLabel(ref.sizeBytes);
    const image = ref.mediaType.startsWith('image/');
    const pdf = ref.mediaType === 'application/pdf';
    if (image || pdf) {
      const can = image ? inputs.images : inputs.pdf;
      if (!can) {
        out.push({ type: 'text', text: `[${image ? 'Image' : 'File'} attached: ${name}, ${ref.mediaType}, ${size}. This model cannot ${image ? 'view images' : 'read PDFs'}; say so if the question needs it.]` });
        continue;
      }
      const cap = image ? MAX_MODEL_IMAGE_BYTES : MAX_MODEL_PDF_BYTES;
      const bytes = ref.sizeBytes <= cap ? await read(ref, cap).catch(() => null) : null;
      if (!bytes) {
        out.push({ type: 'text', text: `[${image ? 'Image' : 'File'} attached: ${name}, ${ref.mediaType}, ${size}. ${ref.sizeBytes > cap ? `Over the ${sizeLabel(cap)} the model takes` : 'It could not be read'}; say so if the question needs it.]` });
        continue;
      }
      out.push({ type: 'file', mediaType: ref.mediaType, filename: ref.name, url: `data:${ref.mediaType};base64,${bytes.toString('base64')}` });
      continue;
    }
    if (TEXT_TYPES.has(ref.mediaType)) {
      // UTF-8 at most 4 bytes a character: anything that could be under the cap is read.
      const bytes = await read(ref, MAX_MODEL_TEXT_FILE_CHARS * 4).catch(() => null);
      const text = bytes ? new TextDecoder('utf-8', { fatal: false }).decode(bytes) : null;
      if (text !== null && text.length <= MAX_MODEL_TEXT_FILE_CHARS) {
        out.push({ type: 'text', text: quoteAttachment(ref.name, text) });
      } else {
        out.push({ type: 'text', text: `[File attached: ${name}, ${ref.mediaType}, ${size}. ${text === null && bytes === null && ref.sizeBytes <= MAX_MODEL_TEXT_FILE_CHARS ? 'It could not be read' : `Longer than the ${MAX_MODEL_TEXT_FILE_CHARS.toLocaleString('en-US')} characters quoted whole`}; say so if the question needs it.]` });
      }
      continue;
    }
    out.push({ type: 'text', text: `[File attached: ${name}, ${ref.mediaType}, ${size}. This model cannot read this file type; say so if the question needs it.]` });
  }
  return out;
}
