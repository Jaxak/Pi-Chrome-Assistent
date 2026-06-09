export type TruncateResult = {
  value: string;
  truncated: boolean;
  originalBytes: number;
};

const utf8Encoder = new TextEncoder();

function getUtf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

function truncateToUtf8ByteLength(value: string, maxBytes: number): string {
  const byteBudget = Math.max(0, maxBytes);
  let output = "";
  let bytes = 0;

  for (const char of value) {
    const nextBytes = getUtf8ByteLength(char);
    if (bytes + nextBytes > byteBudget) {
      break;
    }

    output += char;
    bytes += nextBytes;
  }

  return output;
}

export function truncateUtf8(input: string, maxBytes: number): TruncateResult {
  const originalBytes = getUtf8ByteLength(input);
  if (originalBytes <= maxBytes) {
    return { value: input, truncated: false, originalBytes };
  }

  const suffix = `\n\n[truncated: original ${originalBytes} bytes, limit ${maxBytes} bytes]`;
  const suffixBytes = getUtf8ByteLength(suffix);

  if (suffixBytes >= maxBytes) {
    return {
      value: truncateToUtf8ByteLength(suffix, maxBytes),
      truncated: true,
      originalBytes,
    };
  }

  const contentByteBudget = maxBytes - suffixBytes;
  const output = truncateToUtf8ByteLength(input, contentByteBudget);

  return {
    value: `${output}${suffix}`,
    truncated: true,
    originalBytes,
  };
}
