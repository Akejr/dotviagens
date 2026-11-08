// Vercel build (no dependencies): copies public/ to dist-vercel/, serves the home at "/",
// and points canonical, Open Graph, robots and sitemap URLs at the production domain:
// SITE_URL if set, otherwise the domain Vercel gives the project (VERCEL_PROJECT_PRODUCTION_URL).
import { cpSync, rmSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'public');
const OUT = join(ROOT, 'dist-vercel');
const PLACEHOLDER = 'https://dotviagens.vercel.app';
// Original high-resolution sources: kept in the repository, not deployed (the site uses the
// optimised copies in assets/hero/, banner-passaporte-dot.jpg and logo-dot-320.png).
const SOURCE_ONLY = new Set([
  'assets/angola-city.png', 'assets/angola-coast.png', 'assets/angola-falls.png', 'assets/angola-mountains.png',
  'assets/banner-passaporte-dot.png', 'assets/boarding-tickets.png', 'assets/hero.jpg',
  'assets/logo.png', 'assets/logo-approved.png', 'assets/logo-gradient.png',
]);
const TEXT = new Set(['.html', '.xml', '.txt', '.webmanifest', '.json']);

const productionDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
const site = String(process.env.SITE_URL || productionDomain || PLACEHOLDER).trim().replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(site)) throw new Error(`SITE_URL inválido: ${site}`);

rmSync(OUT, { recursive: true, force: true });
cpSync(SOURCE, OUT, {
  recursive: true,
  filter: path => !SOURCE_ONLY.has(relative(SOURCE, path).split(sep).join('/')),
});
copyFileSync(join(OUT, 'home.html'), join(OUT, 'index.html'));

const today = new Date().toISOString().slice(0, 10);
let replaced = 0;
let files = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    files += 1;
    if (!TEXT.has(extname(name)) || name === 'airports.json') continue;
    const before = readFileSync(path, 'utf8');
    let after = before.split(PLACEHOLDER).join(site);
    if (name === 'sitemap.xml') after = after.replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
    if (after !== before) {
      writeFileSync(path, after);
      replaced += 1;
    }
  }
}
walk(OUT);
console.log(`dist-vercel: ${files} ficheiros, ${replaced} com o endereço ${site}`);
