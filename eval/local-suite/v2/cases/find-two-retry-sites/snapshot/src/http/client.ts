import { sendWithBackoff } from './transport';

export function createClient(base: string) {
  return {
    async get(path: string) {
      const res = await sendWithBackoff(base + path);
      return res.json();
    },
  };
}
