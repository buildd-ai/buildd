/**
 * A deterministic, offline embedder for the spec corpus tests: a bag of words
 * hashed into the store's 1024 dimensions and normalised, so cosine is word
 * overlap. A few synonyms fold together so a paraphrase ("basket", "buyer")
 * lands near its original ("cart", "shopper"). It counts its calls, so a test
 * can say no embedding was asked for.
 */
const DIM = 1024;
const STOP = new Set(['the', 'and', 'then', 'given', 'when', 'for', 'are', 'with', 'that', 'this', 'its', 'not', 'but']);
const SAME: Record<string, string> = { basket: 'cart', buyer: 'shopper', price: 'total', item: 'line', screen: 'page', notice: 'message' };

const words = (t: string) => (t.toLowerCase().match(/[a-z]+/g) ?? [])
  .filter((w) => w.length > 2 && !STOP.has(w))
  .map((w) => w.replace(/s$/, ''))
  .map((w) => SAME[w] ?? w);

export function bowVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const w of words(text)) {
    let h = 7;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function bowEmbedder() {
  const e = {
    model: 'test-bag-of-words',
    dimensions: DIM,
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      e.calls++;
      return texts.map(bowVector);
    },
  };
  return e;
}
