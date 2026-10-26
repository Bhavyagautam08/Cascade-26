// Parchi: photo -> lines to review. The one path used by the Parchi screen and by Jaanch's sample test.
import ImageResizer from '@bam.tech/react-native-image-resizer';
import type { LexiconData } from '../core/lexicon';
import { checkSlipConsistency, lineConfidences, normalizeSlip, parseSlip, type Slip } from '../core/slip';
import { files } from './files';
import { llm } from './llm';

export const SLIP_IMAGE_PX = 1280; // longest side sent to the vision encoder (image_max_tokens caps the tokens)
export const SLIP_READ_TOKENS = 512;

function plainPath(path: string): string {
  return path.startsWith('file://') ? path.slice(7) : path;
}

/** Read a slip photo. `stopped()` says the vendor pressed stop (the answer so far is kept, and marked). */
export async function readSlipPhoto(uri: string, lexicon: LexiconData, stopped: () => boolean = () => false): Promise<Slip> {
  const image = await ImageResizer.createResizedImage(uri, SLIP_IMAGE_PX, SLIP_IMAGE_PX, 'JPEG', 90, 0, null, false, { onlyScaleDown: true });
  let answer;
  try {
    answer = await llm.image(plainPath(image.path), SLIP_READ_TOKENS, 1);
  } finally {
    if (!(await files.deleteFile(plainPath(image.path)))) console.warn(`could not delete temporary slip image: ${image.path}`);
  }
  const textLines = answer.content.split('\n');
  const parsed = parseSlip(textLines);
  const warnings = ['photo ki disha apne aap nahi pehchaani jaati; har line photo se milaa kar dekhein'];
  if (answer.truncated || stopped()) warnings.push('padhai beech mein ruki; kuch line chhoot sakti hain. Chhooti line jodkar har line jaanchein.');
  if (!parsed.lines.length && !stopped()) {
    throw new Error('photo se koi item line nahi padh paaya; roshni/saaf photo ke saath phir koshish karein, ya "Line khud likho"');
  }
  const confidence = lineConfidences(answer.content, answer.probabilities);
  return normalizeSlip(checkSlipConsistency({
    supplier: parsed.supplier,
    lines: parsed.lines.map(({ index, line }) => ({
      item: line.item ?? '?',
      qty: line.qty,
      unit: line.unit,
      amount_rupees: line.amount_rupees,
      confidence: line.item ? (confidence[index] ?? 0.5) : 0.5,
      text: textLines[index]?.trim() ?? '',
      notes: line.item ? line.notes : [...line.notes, 'maal ka naam saaf nahi; save se pehle theek karein'],
    })),
    total_rupees: parsed.total_rupees,
    rotation: 0,
    text: answer.content.trim(),
    warnings,
  }), lexicon);
}
