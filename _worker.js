/**
 * Cloudflare Worker for Car Web IPTV:
 * 1. Serves static assets (index.html, manifest.json, sw.js, epg-worker.js, icons).
 * 2. Implements /proxy?url=<target_url> to bypass CORS and Mixed Content (HTTPS -> HTTP).
 * 3. Rewrites .m3u8 playlists so all chunk URLs route through /proxy over HTTPS.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── 1. CORS & Mixed-Content Proxy Endpoint ──────────────────────────────
    if (url.pathname === '/proxy') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response('Missing "url" parameter', {
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Handle CORS preflight (OPTIONS)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      try {
        const fetchHeaders = new Headers();
        if (request.headers.has('range')) {
          fetchHeaders.set('range', request.headers.get('range'));
        }
        if (request.headers.has('accept')) {
          fetchHeaders.set('accept', request.headers.get('accept'));
        }
        fetchHeaders.set(
          'User-Agent',
          request.headers.get('user-agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        );

        const resp = await fetch(targetUrl, {
          method: request.method === 'HEAD' ? 'HEAD' : 'GET',
          headers: fetchHeaders,
          redirect: 'follow',
        });

        // Copy and sanitize response headers
        const outHeaders = new Headers();
        for (const [key, val] of resp.headers.entries()) {
          const lKey = key.toLowerCase();
          if (
            lKey === 'content-security-policy' ||
            lKey === 'x-frame-options' ||
            lKey === 'access-control-allow-origin' ||
            lKey === 'access-control-allow-headers' ||
            lKey === 'access-control-allow-methods'
          ) {
            continue;
          }
          outHeaders.set(key, val);
        }

        outHeaders.set('Access-Control-Allow-Origin', '*');
        outHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        outHeaders.set('Access-Control-Allow-Headers', '*');
        outHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

        const contentType = resp.headers.get('content-type') || '';
        const isM3U8 =
          targetUrl.includes('.m3u') ||
          contentType.includes('mpegurl') ||
          contentType.includes('x-mpegurl');

        // For M3U8 playlists: rewrite stream/segment URLs through proxy
        if (isM3U8 && resp.ok) {
          const text = await resp.text();
          if (text.includes('#EXTM3U')) {
            const proxyBase = `${url.origin}/proxy?url=`;
            const lines = text.split('\n');
            const rewritten = lines.map(line => {
              const trimmed = line.trim();
              if (!trimmed) return line;

              // Helper to resolve URL and avoid raw IPv4 blocks (Cloudflare Error 1003)
              const resolveUrl = raw => {
                try {
                  const targetParsed = new URL(targetUrl);
                  const parsed = new URL(raw, targetUrl);
                  // If resolved URL uses raw IPv4 but targetUrl had a hostname, preserve hostname
                  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) && !/^\d+\.\d+\.\d+\.\d+$/.test(targetParsed.hostname)) {
                    parsed.protocol = targetParsed.protocol;
                    parsed.host = targetParsed.host;
                  }
                  return parsed.href;
                } catch (_) {
                  return raw;
                }
              };

              // Rewrite URI in tags (e.g. #EXT-X-KEY:METHOD=...,URI="...")
              if (trimmed.startsWith('#')) {
                if (trimmed.includes('URI=')) {
                  return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                    const fullUri = resolveUrl(uri);
                    return `URI="${proxyBase}${encodeURIComponent(fullUri)}"`;
                  });
                }
                return line;
              }

              // Segment or variant stream URL line
              const fullUrl = resolveUrl(trimmed);
              return `${proxyBase}${encodeURIComponent(fullUrl)}`;
            }).join('\n');

            outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            outHeaders.delete('Content-Length');
            return new Response(rewritten, {
              status: resp.status,
              statusText: resp.statusText,
              headers: outHeaders,
            });
          } else {
            return new Response(text, {
              status: resp.status,
              statusText: resp.statusText,
              headers: outHeaders,
            });
          }
        }

        // Binary streaming (video .ts segments, gzipped EPG, channel icons)
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: outHeaders,
        });

      } catch (err) {
        return new Response(`Proxy error: ${err.message}`, {
          status: 502,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/plain; charset=utf-8',
          },
        });
      }
    }

    // ── 2. Static Assets Serving ─────────────────────────────────────────────
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
