import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const ROUTES = { '/': 'index.html', '/privacy': 'privacy.html', '/terms': 'terms.html' };
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ENTITIES[char]);

// Google and Meta need a home page and privacy policy that anyone can open without an account.
// This serves those fixed pages on a separate hostname, and that hostname can reach nothing else.
export function publicSite(config) {
  const { host, contactEmail } = config.site;
  if (!host) return (req, res, next) => next();

  const style = readFileSync(path.join(SITE_DIR, 'style.css'), 'utf8');
  const contact = escapeHtml(contactEmail ?? '');
  const appUrl = escapeHtml(config.baseUrl);
  const pages = new Map(Object.entries(ROUTES).map(([route, file]) => [
    route,
    readFileSync(path.join(SITE_DIR, file), 'utf8')
      .replaceAll('{{style}}', style)
      .replaceAll('{{contact}}', contact)
      .replaceAll('{{app}}', appUrl),
  ]));

  return (req, res, next) => {
    if (req.headers.host?.toLowerCase() !== host) return next();
    const page = req.method === 'GET' || req.method === 'HEAD' ? pages.get(req.path.replace(/(.)\/$/, '$1')) : null;
    // Cloudflare hides email addresses from scrapers and restores them with its own same-origin script.
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    if (!page) return res.status(404).type('text').send('Not found.');
    res.type('html').send(page);
  };
}
