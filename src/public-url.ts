/** The public address of the hub, for prompts and installers a person will copy.
 *
 * The hub normally builds those URLs from the request's own origin. Behind a tunnel or reverse proxy that is wrong:
 * cloudflared talks http to the origin, so the hub sees http://fleet.example.dev while the person is on https. Set
 * HUB_PUBLIC_URL once and every prompt, install command and install script uses it instead. Unset means "use the
 * request origin", which is what tests, the tailnet and a plain local hub want.
 */

/** Reads HUB_PUBLIC_URL: undefined when unset, an origin (no trailing slash) when valid, and a clear error when not. */
export function resolvePublicUrl(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`HUB_PUBLIC_URL is not a URL: ${value}\n  Give the address people reach the hub at, for example https://fleet.example.dev`); }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`HUB_PUBLIC_URL must start with http:// or https://: ${value}`);
  // The hub is served at the root, so a path or query would silently break every URL built from it.
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error(`HUB_PUBLIC_URL is just the address, with no path, query or credentials: ${value}`);
  return url.origin;                      // also strips a trailing slash and normalises case
}

/** The origin to put in a prompt: the configured public one, or the origin of the request being answered. */
export const hubOrigin = (requestUrl: string, publicUrl?: string): string => publicUrl || new URL(requestUrl).origin;
