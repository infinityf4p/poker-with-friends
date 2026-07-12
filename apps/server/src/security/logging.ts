export function safeErrorLogContext(error: unknown): {
  errorName: string;
  errorCode?: string;
  causeCode?: string;
} {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const cause =
    typeof record.cause === 'object' && record.cause !== null
      ? (record.cause as Record<string, unknown>)
      : {};
  return {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    ...(typeof record.code === 'string' ? { errorCode: record.code } : {}),
    ...(typeof cause.code === 'string' ? { causeCode: cause.code } : {}),
  };
}

export function safeRequestUrl(value: unknown): string {
  if (typeof value !== 'string') return '[REDACTED]';
  const pathname = value.split('?', 1)[0] ?? '';
  return pathname.replace(
    /(\/(?:join|api\/rooms)\/)[A-Za-z0-9_-]{32,128}(?=\/|$)/g,
    '$1[REDACTED]',
  );
}
