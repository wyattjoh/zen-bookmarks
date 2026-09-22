/**
 * Structured fields attached to a network debug event.
 */
export type NetworkDebugFields = Record<string, boolean | number | string | null>;

/**
 * Receives structured network activity, cache, and timing events.
 */
export type NetworkDebugLogger = (
  event: string,
  fields: NetworkDebugFields,
) => void;
