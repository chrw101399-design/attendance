type AccessClaims = { aud?: string[] | string; exp?: number; iss?: string };
type AccessJwk = JsonWebKey & { kid?: string };
let cachedKeys: { expiresAt: number; keys: AccessJwk[] } | undefined;

export async function verifyAccessJwt(token: string | undefined, teamDomain: string | undefined, audience: string | undefined): Promise<boolean> {
  if (!token || !teamDomain || !audience) return false;
  try {
    const [headerPart, claimsPart, signaturePart] = token.split(".");
    if (!headerPart || !claimsPart || !signaturePart) return false;
    const decode = (part: string) => atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const header = JSON.parse(decode(headerPart)) as { alg?: string; kid?: string };
    const claims = JSON.parse(decode(claimsPart)) as AccessClaims;
    const validAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (header.alg !== "RS256" || !header.kid || !validAudiences.includes(audience) || !claims.exp || claims.exp <= Date.now() / 1000 || claims.iss !== `https://${teamDomain}`) return false;
    if (!cachedKeys || cachedKeys.expiresAt < Date.now()) {
      const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
      if (!response.ok) return false;
      const data = await response.json() as { keys?: AccessJwk[] };
      cachedKeys = { keys: data.keys ?? [], expiresAt: Date.now() + 5 * 60_000 };
    }
    const jwk = cachedKeys.keys.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(signaturePart.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${headerPart}.${claimsPart}`));
  } catch {
    return false;
  }
}
