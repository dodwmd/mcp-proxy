import { describe, it, expect } from 'vitest';
import { isPrivateIP, validateUrl } from './url-validation.js';

describe('URL Validation', () => {
  describe('isPrivateIP', () => {
    describe('IPv4 Loopback', () => {
      it('should detect localhost as private', () => {
        expect(isPrivateIP('localhost')).toBe(true);
      });

      it('should detect 0.0.0.0 as private', () => {
        expect(isPrivateIP('0.0.0.0')).toBe(true);
      });

      it('should detect 127.0.0.1 as private', () => {
        expect(isPrivateIP('127.0.0.1')).toBe(true);
      });

      it('should detect 127.x.x.x range as private', () => {
        expect(isPrivateIP('127.255.255.255')).toBe(true);
        expect(isPrivateIP('127.1.2.3')).toBe(true);
      });
    });

    describe('IPv4 Private Ranges (RFC 1918)', () => {
      it('should detect 10.0.0.0/8 range as private', () => {
        expect(isPrivateIP('10.0.0.0')).toBe(true);
        expect(isPrivateIP('10.0.0.1')).toBe(true);
        expect(isPrivateIP('10.255.255.255')).toBe(true);
        expect(isPrivateIP('10.1.2.3')).toBe(true);
      });

      it('should detect 172.16.0.0/12 range as private', () => {
        expect(isPrivateIP('172.16.0.0')).toBe(true);
        expect(isPrivateIP('172.16.0.1')).toBe(true);
        expect(isPrivateIP('172.31.255.255')).toBe(true);
        expect(isPrivateIP('172.20.1.1')).toBe(true);
      });

      it('should detect 192.168.0.0/16 range as private', () => {
        expect(isPrivateIP('192.168.0.0')).toBe(true);
        expect(isPrivateIP('192.168.0.1')).toBe(true);
        expect(isPrivateIP('192.168.255.255')).toBe(true);
        expect(isPrivateIP('192.168.1.100')).toBe(true);
      });
    });

    describe('IPv4 Link-Local', () => {
      it('should detect 169.254.0.0/16 range as private', () => {
        expect(isPrivateIP('169.254.0.0')).toBe(true);
        expect(isPrivateIP('169.254.0.1')).toBe(true);
        expect(isPrivateIP('169.254.255.255')).toBe(true);
        expect(isPrivateIP('169.254.169.254')).toBe(true); // AWS metadata service
      });
    });

    describe('IPv4 Public Addresses', () => {
      it('should not detect public IPs as private', () => {
        expect(isPrivateIP('8.8.8.8')).toBe(false); // Google DNS
        expect(isPrivateIP('1.1.1.1')).toBe(false); // Cloudflare DNS
        expect(isPrivateIP('192.0.2.1')).toBe(false); // TEST-NET-1
        expect(isPrivateIP('198.51.100.1')).toBe(false); // TEST-NET-2
        expect(isPrivateIP('203.0.113.1')).toBe(false); // TEST-NET-3
        expect(isPrivateIP('93.184.216.34')).toBe(false); // example.com
      });

      it('should not detect near-private ranges as private', () => {
        expect(isPrivateIP('9.255.255.255')).toBe(false); // Just before 10.0.0.0
        expect(isPrivateIP('11.0.0.0')).toBe(false); // Just after 10.255.255.255
        expect(isPrivateIP('172.15.255.255')).toBe(false); // Just before 172.16.0.0
        expect(isPrivateIP('172.32.0.0')).toBe(false); // Just after 172.31.255.255
        expect(isPrivateIP('192.167.255.255')).toBe(false); // Just before 192.168.0.0
        expect(isPrivateIP('192.169.0.0')).toBe(false); // Just after 192.168.255.255
      });
    });

    describe('IPv6 Loopback', () => {
      it('should detect ::1 as private', () => {
        expect(isPrivateIP('::1')).toBe(true);
      });
    });

    describe('IPv6 Link-Local', () => {
      it('should detect fe80::/10 range as private', () => {
        expect(isPrivateIP('fe80::1')).toBe(true);
        expect(isPrivateIP('fe80::')).toBe(true);
        expect(isPrivateIP('fe80::dead:beef')).toBe(true);
        expect(isPrivateIP('FE80::1')).toBe(true); // Case insensitive
      });
    });

    describe('IPv6 Unique Local (ULA)', () => {
      it('should detect fc00::/7 range as private', () => {
        expect(isPrivateIP('fc00::1')).toBe(true);
        expect(isPrivateIP('fc00::')).toBe(true);
        expect(isPrivateIP('fcff::1')).toBe(true);
        expect(isPrivateIP('FC00::1')).toBe(true); // Case insensitive
      });

      it('should detect fd00::/8 range as private', () => {
        expect(isPrivateIP('fd00::1')).toBe(true);
        expect(isPrivateIP('fd00::')).toBe(true);
        expect(isPrivateIP('fdff::1')).toBe(true);
        expect(isPrivateIP('FD00::1')).toBe(true); // Case insensitive
      });
    });

    describe('IPv6 Public Addresses', () => {
      it('should not detect public IPv6 addresses as private', () => {
        expect(isPrivateIP('2001:4860:4860::8888')).toBe(false); // Google DNS
        expect(isPrivateIP('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
        expect(isPrivateIP('2001:db8::1')).toBe(false); // Documentation
      });
    });

    describe('Edge Cases', () => {
      it('should handle hostnames that are not IPs', () => {
        expect(isPrivateIP('example.com')).toBe(false);
        expect(isPrivateIP('api.example.com')).toBe(false);
        expect(isPrivateIP('sub.domain.example.com')).toBe(false);
      });
    });
  });

  describe('validateUrl', () => {
    describe('Valid URLs', () => {
      it('should accept valid http URL', () => {
        expect(() => validateUrl('http://example.com', false, 'test')).not.toThrow();
        expect(() => validateUrl('http://api.example.com:8080', false, 'test')).not.toThrow();
        expect(() => validateUrl('http://example.com/path', false, 'test')).not.toThrow();
        expect(() => validateUrl('http://example.com/path?query=value', false, 'test')).not.toThrow();
      });

      it('should accept valid https URL', () => {
        expect(() => validateUrl('https://example.com', false, 'test')).not.toThrow();
        expect(() => validateUrl('https://api.example.com:8443', false, 'test')).not.toThrow();
        expect(() => validateUrl('https://example.com/path', false, 'test')).not.toThrow();
        expect(() => validateUrl('https://example.com/path?query=value', false, 'test')).not.toThrow();
      });

      it('should accept public IP addresses', () => {
        expect(() => validateUrl('http://8.8.8.8', false, 'test')).not.toThrow();
        expect(() => validateUrl('https://1.1.1.1:443', false, 'test')).not.toThrow();
      });

      it('should accept IPv6 addresses in URLs', () => {
        expect(() => validateUrl('http://[2001:4860:4860::8888]', false, 'test')).not.toThrow();
        expect(() => validateUrl('https://[2606:4700:4700::1111]:8443', false, 'test')).not.toThrow();
      });
    });

    describe('Invalid URL Format', () => {
      it('should reject malformed URLs', () => {
        expect(() => validateUrl('not-a-url', false, 'test')).toThrow(/invalid URL/i);
        expect(() => validateUrl('', false, 'test')).toThrow(/invalid URL/i);
        expect(() => validateUrl('://example.com', false, 'test')).toThrow(/invalid URL/i);
        expect(() => validateUrl('example.com', false, 'test')).toThrow(/invalid URL/i);
      });

      it('should include server alias in error message', () => {
        expect(() => validateUrl('not-a-url', false, 'my-server')).toThrow('my-server');
      });
    });

    describe('Invalid URL Scheme', () => {
      it('should reject non-HTTP schemes', () => {
        expect(() => validateUrl('ftp://example.com', false, 'test')).toThrow(
          /must use http:\/\/ or https:\/\//i
        );
        expect(() => validateUrl('ws://example.com', false, 'test')).toThrow(
          /must use http:\/\/ or https:\/\//i
        );
        expect(() => validateUrl('wss://example.com', false, 'test')).toThrow(
          /must use http:\/\/ or https:\/\//i
        );
        expect(() => validateUrl('file:///path/to/file', false, 'test')).toThrow(
          /must use http:\/\/ or https:\/\//i
        );
      });

      it('should include actual protocol in error message', () => {
        expect(() => validateUrl('ftp://example.com', false, 'test')).toThrow('ftp:');
      });
    });

    describe('Private IP Protection (allowPrivateUrls = false)', () => {
      it('should reject localhost', () => {
        expect(() => validateUrl('http://localhost', false, 'test')).toThrow(
          /private IP address/i
        );
        expect(() => validateUrl('http://localhost:8080', false, 'test')).toThrow(
          /private IP address/i
        );
      });

      it('should reject IPv4 loopback addresses', () => {
        expect(() => validateUrl('http://127.0.0.1', false, 'test')).toThrow(
          /private IP address/i
        );
        expect(() => validateUrl('http://127.0.0.1:8080', false, 'test')).toThrow(
          /private IP address/i
        );
      });

      it('should reject IPv4 private ranges', () => {
        expect(() => validateUrl('http://10.0.0.1', false, 'test')).toThrow(/private IP address/i);
        expect(() => validateUrl('http://172.16.0.1', false, 'test')).toThrow(
          /private IP address/i
        );
        expect(() => validateUrl('http://192.168.1.1', false, 'test')).toThrow(
          /private IP address/i
        );
      });

      it('should reject IPv4 link-local addresses', () => {
        expect(() => validateUrl('http://169.254.169.254', false, 'test')).toThrow(
          /private IP address/i
        );
      });

      // IPv6 addresses in URLs (with brackets) should be correctly detected
      // URL.hostname returns '[::1]' which we strip before checking
      it('should reject IPv6 loopback in URL format', () => {
        expect(() => validateUrl('http://[::1]', false, 'test'))
          .toThrow('points to private IP address');
      });

      it('should reject IPv6 link-local in URL format', () => {
        expect(() => validateUrl('http://[fe80::1]', false, 'test'))
          .toThrow('points to private IP address');
      });

      it('should reject IPv6 unique local in URL format', () => {
        expect(() => validateUrl('http://[fc00::1]', false, 'test'))
          .toThrow('points to private IP address');
        expect(() => validateUrl('http://[fd00::1]', false, 'test'))
          .toThrow('points to private IP address');
      });

      it('should include helpful message about allowPrivateUrls setting', () => {
        expect(() => validateUrl('http://localhost', false, 'test')).toThrow(
          /Set allowPrivateUrls: true/i
        );
      });

      it('should include hostname in error message', () => {
        expect(() => validateUrl('http://192.168.1.1', false, 'test')).toThrow('192.168.1.1');
      });
    });

    describe('Private IP Allowed (allowPrivateUrls = true)', () => {
      it('should accept localhost when allowed', () => {
        expect(() => validateUrl('http://localhost', true, 'test')).not.toThrow();
        expect(() => validateUrl('http://localhost:8080', true, 'test')).not.toThrow();
      });

      it('should accept IPv4 loopback when allowed', () => {
        expect(() => validateUrl('http://127.0.0.1', true, 'test')).not.toThrow();
        expect(() => validateUrl('http://127.0.0.1:8080', true, 'test')).not.toThrow();
      });

      it('should accept IPv4 private ranges when allowed', () => {
        expect(() => validateUrl('http://10.0.0.1', true, 'test')).not.toThrow();
        expect(() => validateUrl('http://172.16.0.1', true, 'test')).not.toThrow();
        expect(() => validateUrl('http://192.168.1.1', true, 'test')).not.toThrow();
      });

      it('should accept IPv4 link-local when allowed', () => {
        expect(() => validateUrl('http://169.254.169.254', true, 'test')).not.toThrow();
      });

      it('should accept IPv6 loopback when allowed', () => {
        expect(() => validateUrl('http://[::1]', true, 'test')).not.toThrow();
      });

      it('should accept IPv6 link-local when allowed', () => {
        expect(() => validateUrl('http://[fe80::1]', true, 'test')).not.toThrow();
      });

      it('should accept IPv6 unique local when allowed', () => {
        expect(() => validateUrl('http://[fc00::1]', true, 'test')).not.toThrow();
        expect(() => validateUrl('http://[fd00::1]', true, 'test')).not.toThrow();
      });

      it('should still accept public IPs when allowed', () => {
        expect(() => validateUrl('http://8.8.8.8', true, 'test')).not.toThrow();
        expect(() => validateUrl('https://example.com', true, 'test')).not.toThrow();
      });

      it('should still reject invalid schemes when private IPs allowed', () => {
        expect(() => validateUrl('ftp://localhost', true, 'test')).toThrow(
          /must use http:\/\/ or https:\/\//i
        );
      });
    });
  });
});
