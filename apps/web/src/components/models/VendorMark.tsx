import { vendorLabel } from '@/lib/model-picker';

const MARK: Record<string, string> = {
  anthropic: 'A', openai: 'O', google: 'G', deepseek: 'DS', qwen: 'Q', 'meta-llama': 'M', meta: 'M',
  mistralai: 'Mi', 'x-ai': 'x', moonshotai: 'K', 'z-ai': 'Z', minimax: 'MM', 'bytedance-seed': 'B',
  amazon: 'Am', nvidia: 'N', cohere: 'Co', microsoft: 'Ms', xiaomi: 'Xi', tencent: 'T', openrouter: 'OR',
};

/**
 * A vendor's mark: a square ink monogram. Monochrome on purpose; colour in
 * this system means status, and a vendor is not a status.
 */
export function VendorMark({ vendor, size = 'md' }: { vendor: string; size?: 'sm' | 'md' }) {
  const text = MARK[vendor] ?? vendorLabel(vendor).replace(/[^A-Za-z]/g, '').slice(0, 2) ?? '?';
  return (
    <span
      aria-hidden="true"
      data-vendor={vendor}
      className={`inline-grid shrink-0 place-items-center border-[1.5px] border-border-strong bg-surface-1 font-mono font-bold leading-none tracking-tight text-text-primary ${
        size === 'sm' ? 'h-4 w-4 text-[11px] md:text-[8px]' : 'h-5 w-5 text-[11px] md:h-[18px] md:w-[18px] md:text-[9px]'
      }`}
    >
      {text}
    </span>
  );
}
