# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in vistaclair, please report it responsibly through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/hpfrei/vistaclair/security) of this repository
2. Click **Report a vulnerability**
3. Provide a description of the issue and steps to reproduce

Please do **not** open a public issue for security vulnerabilities.

I will review reports promptly and work with you on a fix before any public disclosure.

## Scope

vistaclair is a local development tool that proxies API traffic. Key areas of concern include:

- Exposure of API keys or credentials through the proxy or dashboard
- Unauthorized access to the dashboard or proxy endpoints
- Code injection via crafted prompts or API responses

## Best Practices

When running vistaclair, keep in mind:

- The **proxy** binds to `localhost` only — it is not reachable from other machines
- The **dashboard** binds to `0.0.0.0` (all interfaces) so you can access it from other devices — it is protected by an auth token, but avoid exposing it to untrusted networks without additional safeguards (TLS, VPN, firewall)
- API keys are forwarded to the Anthropic API but are never logged or persisted by vistaclair
- Interaction logs saved to disk may contain sensitive data from your prompts and responses

## Content-Security-Policy

Text the dashboard shows can come from an untrusted source (a remote session relayed by an add-on, or a session made to print HTML by a prompt injection), and script on the dashboard origin acts as the owner. The renderers sanitize their input (DOMPurify and `public/render-safe.js`); as a second layer, every dashboard response carries a Content-Security-Policy (built in `src/csp.js`), so markup that slips through still cannot run script:

| Directive | Sources | Why |
|---|---|---|
| `default-src` | `'self'` | Anything not listed below stays same-origin |
| `script-src` | `'self' https://app.lemonsqueezy.com https://assets.lemonsqueezy.com` | Only the dashboard's own files (all libraries are vendored in `public/vendor/`). No inline script, no `eval`. The one third party is the Pro checkout overlay's `lemon.js`, loaded only on the Pro teaser: served live by LemonSqueezy, so it cannot be pinned or vendored (`app.` redirects to `assets.`) |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` | Inline style attributes in the UI and in rendered html fences; Monaco, MathJax and xterm inject `<style>`. The Google Fonts stylesheet |
| `font-src` | `'self' data: https://fonts.gstatic.com` | Vendored and embedded faces, Google Fonts files |
| `img-src` | `'self' data: blob:` | Pasted / inline images, attachment previews. Remote image URLs are not loaded |
| `media-src` | `'self' data: blob:` | Audio and video players |
| `connect-src` | `'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com` | REST and the dashboard WebSocket; the font hosts for the service worker's font cache |
| `worker-src` | `'self' blob:` | The service worker; Monaco starts its language workers from a blob that loads the vendored worker file |
| `frame-src` | `'self' https://*.lemonsqueezy.com` | Apps are framed same-origin (`/apps/<name>/`); the checkout overlay |
| `frame-ancestors` | `'self'` | The dashboard cannot be framed by another site |
| `object-src` | `'none'` | |
| `base-uri` | `'self'` | |

- **Where it applies**: the dashboard pages (`/`, `/login`, `/landing_page/`), their scripts and assets, and `/outputs/`. Not under `/apps/` (the add-on sets its own headers there), and not on an add-on router's own routes (e.g. Pro's `/pro/*.html` pages): the core policy is dropped before the add-on routers, which answer with their own headers.
- **Add-ons**: an add-on's client modules run inside the dashboard page. Its descriptor declares `cspReady: true` once they need no inline handlers or eval (`src/addons.js`). While an add-on without it is loaded, the policy is sent as `Content-Security-Policy-Report-Only`: nothing is blocked, and the browser console names each violation.
- **Off-switch**: `VISTACLAIR_CSP=off` sends no policy, for an emergency (a page that a violation breaks); `VISTACLAIR_CSP=report-only` keeps it report-only. Restart the server after changing it.
