// @ast-grep/napi is a native binary: unavailable on Workers. Its one consumer
// (packages/core/knowledge-store/symbol-extractor.ts) already treats a failed
// load as "symbols unavailable" and falls back, as it does on Vercel.
throw new Error('@ast-grep/napi is not available on the Workers runtime');
