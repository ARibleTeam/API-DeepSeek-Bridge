export function tryExtractJson(text) {
  if (!text) return null;
  const len = text.length;
  let lastValidCommand = null;
  let lastValidData = null;

  for (let i = 0; i < len; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;

    for (let j = i; j < len; j++) {
      const ch = text[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;

      if (depth === 0) {
        const candidate = text.slice(i, j + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (typeof parsed === 'object' && parsed !== null) {
            if (typeof parsed.command === 'string') {
              lastValidCommand = parsed;
            } else if (Object.prototype.hasOwnProperty.call(parsed, 'verified')) {
              lastValidData = parsed;
            } else if (!lastValidCommand && !lastValidData) {
              lastValidData = parsed;
            }
          }
        } catch {
          // ignore
        }
        break;
      }
    }
  }

  return lastValidCommand || lastValidData;
}

export function extractResultFromDeepSeekJson(parsedJson) {
  if (!parsedJson || typeof parsedJson !== 'object') return null;

  if (typeof parsedJson.result === 'string' && parsedJson.result.trim()) {
    return parsedJson.result.trim();
  }

  // DARA-style "final": { command: 'final', args: { result: '...' } }
  if (parsedJson.command === 'final' && parsedJson.args && typeof parsedJson.args.result === 'string') {
    return parsedJson.args.result.trim();
  }

  // Sometimes result can be nested differently.
  if (parsedJson.args && typeof parsedJson.args.result === 'string') {
    return parsedJson.args.result.trim();
  }

  return null;
}

