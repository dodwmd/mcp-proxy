/**
 * URL validation utilities for upstream HTTP connections.
 * Validates URLs and checks for private IP addresses to prevent SSRF attacks.
 */

/**
 * Check if a hostname is a private or local IP address.
 * Covers IPv4 and IPv6 private ranges, loopback, and link-local addresses.
 */
export function isPrivateIP(hostname: string): boolean {
  // Localhost
  if (hostname === 'localhost' || hostname === '0.0.0.0') {
    return true;
  }

  // IPv4-mapped IPv6 addresses (::ffff:0:0/96)
  // Matches ::ffff:xxxx:xxxx format where xxxx are hex-encoded IPv4 octets
  const ipv4MappedMatch = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (ipv4MappedMatch) {
    // Extract the two hex groups and convert back to IPv4
    const part1 = parseInt(ipv4MappedMatch[1], 16);
    const part2 = parseInt(ipv4MappedMatch[2], 16);
    const octet1 = (part1 >> 8) & 0xff;
    const octet2 = part1 & 0xff;
    const octet3 = (part2 >> 8) & 0xff;
    const octet4 = part2 & 0xff;
    const ipv4Addr = `${octet1}.${octet2}.${octet3}.${octet4}`;
    // Recursively check the extracted IPv4 address
    return isPrivateIP(ipv4Addr);
  }

  // IPv4 private ranges (RFC 1918)
  const ipv4PrivateRanges = [
    /^127\./,                          // 127.0.0.0/8 (loopback)
    /^10\./,                           // 10.0.0.0/8 (private)
    /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12 (private)
    /^192\.168\./,                     // 192.168.0.0/16 (private)
    /^169\.254\./,                     // 169.254.0.0/16 (link-local)
  ];

  // IPv6 private ranges
  const ipv6PrivateRanges = [
    /^::$/,                            // :: (unspecified address - equivalent to 0.0.0.0)
    /^::1$/,                           // ::1 (loopback)
    /^fe80:/i,                         // fe80::/10 (link-local)
    /^fc[0-9a-f]{2}:/i,                // fc00::/7 (unique local)
    /^fd[0-9a-f]{2}:/i,                // fd00::/8 (unique local)
  ];

  // Check IPv4 ranges
  if (ipv4PrivateRanges.some(range => range.test(hostname))) {
    return true;
  }

  // Check IPv6 ranges
  if (ipv6PrivateRanges.some(range => range.test(hostname))) {
    return true;
  }

  return false;
}

/**
 * Validate a URL for upstream HTTP connections.
 * Throws an error if the URL is invalid or points to a private IP (when not allowed).
 *
 * @param url - The URL to validate
 * @param allowPrivateUrls - Whether to allow private IP addresses
 * @param serverAlias - Server alias for error messages
 * @throws Error if validation fails
 */
export function validateUrl(url: string, allowPrivateUrls: boolean, serverAlias: string): void {
  // Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (err) {
    throw new Error(
      `HTTP server ${serverAlias} has invalid URL: ${url} (${err instanceof Error ? err.message : String(err)})`
    );
  }

  // Check scheme
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `HTTP server ${serverAlias} URL must use http:// or https://, got ${parsedUrl.protocol}`
    );
  }

  // Check for private IPs (if not allowed)
  // Strip brackets from IPv6 addresses (URL.hostname returns [::1] for IPv6)
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateUrls && isPrivateIP(hostname)) {
    throw new Error(
      `HTTP server ${serverAlias} URL points to private IP address: ${hostname}. ` +
      `Set allowPrivateUrls: true in runtime config to allow private addresses.`
    );
  }
}
