/** One field of a parsed JSON body, without trusting the body's shape. */
export function jsonField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }
  return Reflect.get(body, key);
}

/** The field when it is a string, else undefined. */
export function jsonString(body: unknown, key: string): string | undefined {
  const value = jsonField(body, key);
  return typeof value === "string" ? value : undefined;
}
