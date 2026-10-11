// Workers have no .env file; process.env is populated from bindings.
export function config(): { parsed: Record<string, string> } { return { parsed: {} }; }
export default { config };
