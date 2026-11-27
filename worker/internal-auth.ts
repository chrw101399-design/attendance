export function hasMirrorSecret(request: Request, expected: string | undefined): boolean {
  return Boolean(expected && request.headers.get("X-Mirror-Secret") === expected);
}
