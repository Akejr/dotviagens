// Builds the blog from content/blog/articles.mjs (no dependencies):
//   public/blog/index.html, public/blog/<slug>.html and public/sitemap.xml.
// Run after editing an article: node scripts/build-blog.mjs   (the output is committed).
// URLs use the placeholder domain; scripts/vercel-build.mjs swaps it for the production one.
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { articles, blog, SHARE_IMAGE } from '../content/blog/articles.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public', 'blog');
const SITE = 'https://dotviagens.vercel.app';
const WHATSAPP = 'https://wa.me/244931343433';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const abs = path => `${SITE}${path}`;
const ld = data => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const words = html => text(html).split(' ').filter(Boolean).length;
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const dateLabel = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d} de ${MONTHS[m - 1]} de ${y}`; };

// Content rules: no dashes as punctuation (the DOT team asked for it), sane SEO lengths.
const problems = [];
for (const a of articles) {
  const all = [a.title, a.seoTitle, a.description, a.lead, a.excerpt, a.crumb, a.body, a.cta.title, a.cta.text, a.cta.label, ...a.faq.flatMap(f => [f.q, f.a])].join('\n');
  if (/[—–]/.test(all)) problems.push(`${a.slug}: tem travessões (— ou –)`);
  if (/\s-\s/.test(text(all))) problems.push(`${a.slug}: tem " - " a fazer de travessão`);
  if (a.description.length > 165) problems.push(`${a.slug}: descrição com ${a.description.length} caracteres (máximo 165)`);
  if (a.seoTitle.length > 65) problems.push(`${a.slug}: título SEO com ${a.seoTitle.length} caracteres (máximo 65)`);
  if (!/^[a-z0-9-]+$/.test(a.slug)) problems.push(`${a.slug}: slug inválido`);
}
if (/[—–]/.test(Object.values(blog).join('\n'))) problems.push('blog: tem travessões');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

for (const a of articles) {
  a.url = `/blog/${a.slug}`;
  a.minutes = Math.max(2, Math.ceil((words(a.lead) + words(a.body) + a.faq.reduce((n, f) => n + words(f.q) + words(f.a), 0)) / 200));
  a.wordCount = words(a.body);
  a.og = a.ogImage || { src: a.cover.src, width: a.cover.width, height: a.cover.height };
}

const head = ({ title, description, path, ogType, image, imageAlt, extra = '', preload = '' }) => `<!DOCTYPE html><html lang="pt-AO"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${abs(path)}">
<link rel="alternate" hreflang="pt-AO" href="${abs(path)}"><link rel="alternate" hreflang="x-default" href="${abs(path)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<meta name="theme-color" content="#ef5900">
<meta property="og:type" content="${ogType}"><meta property="og:site_name" content="DOT Viagens"><meta property="og:locale" content="pt_PT"><meta property="og:url" content="${abs(path)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${abs(image.src)}"><meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}"><meta property="og:image:alt" content="${esc(imageAlt)}">${extra}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${abs(image.src)}">
<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;450;500;550;600;650;700&family=Manrope:wght@400;500;600;650;700;750;800&display=swap">${preload}
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/blog.css">`;

const top = `<body class="blog-page">
<div class="announcement">O teu próximo destino começa aqui. <span>Agora, com a DOT.</span></div>
<header class="header wrap"><a href="/" class="brand" aria-label="DOT Viagens início"><img src="/assets/logo-dot-320.png" width="320" height="107" alt="DOT Viagens"></a><nav aria-label="Navegação principal"><a href="/#pesquisa">Voos</a><a href="/#destinos">Destinos</a><a href="/#como-funciona">Como funciona</a></nav><a class="text-btn" href="${WHATSAPP}" target="_blank" rel="noopener">Precisas de ajuda? <span>↗</span></a><a class="account" href="/minhas-viagens"><span>◎</span> Minhas viagens</a></header>`;

const bottom = `<footer class="site-footer"><div class="wrap footer-main"><div><a href="/" class="brand" aria-label="DOT Viagens início"><img src="/assets/logo-dot-320.png" width="320" height="107" alt="DOT Viagens" loading="lazy"></a><p>O teu próximo destino<br>começa em kwanzas.</p></div><div><strong>Explora</strong><a href="/#pesquisa">Pesquisar voos</a><a href="/#destinos">Destinos</a><a href="/#como-funciona">Como funciona</a><a href="/blog">Blog</a><a href="/minhas-viagens">Minhas viagens</a></div><div><strong>Estamos por perto</strong><a href="${WHATSAPP}" target="_blank" rel="noopener">Falar com a DOT ↗</a><a href="https://www.dotangola.com" target="_blank" rel="noopener">Conhece a DOT Angola ↗</a></div><div class="footer-note"><span>FEITO PARA QUEM QUER IR MAIS LONGE.</span><p>De Angola.<br>Para o mundo. <b>↗</b></p></div></div><div class="wrap footer-bottom"><span>© 2026 DOT Viagens</span><span>Passagens aéreas em kwanzas · Multicaixa Express e referência</span><span>Angola · Português · Kz</span></div></footer>
<a class="wa-float" href="${WHATSAPP}?text=Ol%C3%A1%2C%20DOT%20Viagens!%20Preciso%20de%20ajuda%20com%20uma%20viagem." target="_blank" rel="noopener" aria-label="Falar com a DOT Viagens no WhatsApp" title="Fala connosco no WhatsApp"><img src="/assets/whatsapp-white.svg" width="31" height="31" alt=""></a>
<script type="module" src="/blog.js"></script><script type="module" src="/ai-chat.js"></script></body></html>
`;

// Cover image: a photo, or the boarding-pass art on the brand gradient.
function coverHtml(cover, { lazy = false, sizes = '(max-width: 760px) 100vw, 1120px' } = {}) {
  const loading = lazy ? ' loading="lazy"' : ' fetchpriority="high"';
  if (cover.art) {
    return `<picture class="art-picture"><source type="image/webp" srcset="${cover.webp}"><img src="${cover.src}" width="${cover.width}" height="${cover.height}" alt="${esc(cover.alt)}"${loading} decoding="async"></picture>`;
  }
  return `<img src="${cover.src}"${cover.srcset ? ` srcset="${cover.srcset}" sizes="${sizes}"` : ''} width="${cover.width}" height="${cover.height}" alt="${esc(cover.alt)}"${loading} decoding="async">`;
}

const card = (a, extra = '') => `<a class="post-card${extra}" href="${a.url}"><span class="post-card-img${a.cover.art ? ' art' : ''}">${coverHtml(a.cover, { lazy: true, sizes: '(max-width: 760px) 100vw, 420px' })}</span>
  <span class="post-card-body"><small>${esc(a.category)} · ${a.minutes} min de leitura</small><strong>${esc(a.title)}</strong><span>${esc(a.excerpt)}</span><em>Ler artigo <i aria-hidden="true">→</i></em></span></a>`;

const publisher = { '@type': 'Organization', name: 'DOT Viagens', url: `${SITE}/`, logo: { '@type': 'ImageObject', url: `${SITE}/icon-512.png` } };

function articlePage(a) {
  const related = articles.filter(other => other !== a).sort((x, y) => (y.category === a.category) - (x.category === a.category)).slice(0, 3);
  const faqHtml = a.faq.length ? `<section class="post-faq" aria-labelledby="faq-${a.slug}"><h2 id="faq-${a.slug}">Perguntas frequentes</h2><div class="questions">${a.faq.map(f => `<details><summary>${esc(f.q)}<span>+</span></summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>` : '';
  const graph = [
    {
      '@type': 'BlogPosting', '@id': `${abs(a.url)}#artigo`, headline: a.title, description: a.description, image: [abs(a.og.src)],
      datePublished: a.published, dateModified: a.modified || a.published, inLanguage: 'pt-AO', articleSection: a.category, wordCount: a.wordCount,
      author: { '@type': 'Organization', name: 'DOT Viagens', url: `${SITE}/` }, publisher,
      mainEntityOfPage: { '@type': 'WebPage', '@id': abs(a.url) }, isPartOf: { '@type': 'Blog', '@id': `${SITE}/blog#blog`, name: 'Blog DOT Viagens' },
    },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Início', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog` },
      { '@type': 'ListItem', position: 3, name: a.crumb, item: abs(a.url) },
    ] },
  ];
  if (a.faq.length) graph.push({ '@type': 'FAQPage', mainEntity: a.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  const preload = a.cover.art ? '' : `\n<link rel="preload" as="image" href="${a.cover.src}"${a.cover.srcset ? ` imagesrcset="${a.cover.srcset}" imagesizes="(max-width: 760px) 100vw, 1120px"` : ''} fetchpriority="high">`;
  return `${head({
    title: a.seoTitle, description: a.description, path: a.url, ogType: 'article', image: a.og, imageAlt: a.ogImage?.alt || a.cover.alt, preload,
    extra: `\n<meta property="article:published_time" content="${a.published}"><meta property="article:modified_time" content="${a.modified || a.published}"><meta property="article:section" content="${esc(a.category)}">`,
  })}
${ld({ '@context': 'https://schema.org', '@graph': graph })}
</head>${top}
<main>
<nav class="crumbs wrap" aria-label="Estás aqui"><a href="/">Início</a><span aria-hidden="true">›</span><a href="/blog">Blog</a><span aria-hidden="true">›</span><span aria-current="page">${esc(a.crumb)}</span></nav>
<article class="post wrap">
<header class="post-head"><a class="post-category" href="/blog">${esc(a.category)}</a><h1>${esc(a.title)}</h1><p class="post-lead">${esc(a.lead)}</p>
<p class="post-meta"><span>Equipa DOT Viagens</span><span><time datetime="${a.published}">${dateLabel(a.published)}</time></span><span>${a.minutes} min de leitura</span></p></header>
<figure class="post-cover${a.cover.art ? ' art' : ''}">${coverHtml(a.cover)}</figure>
<div class="post-body">${a.body}
<aside class="post-cta"><div><strong>${esc(a.cta.title)}</strong><p>${esc(a.cta.text)}</p></div><a class="white-btn" href="${a.cta.href}">${esc(a.cta.label)} <span>↗</span></a></aside>
${faqHtml}
</div>
</article>
<section class="post-related wrap" aria-labelledby="related"><div class="post-related-head"><span class="eyebrow">CONTINUA A LER</span><h2 id="related">Mais dicas para a tua viagem</h2></div><div class="post-grid">${related.map(r => card(r)).join('')}</div></section>
</main>
${bottom}`;
}

function indexPage() {
  const [featured, ...rest] = articles;
  const graph = [
    {
      '@type': 'Blog', '@id': `${SITE}/blog#blog`, name: 'Blog DOT Viagens', url: `${SITE}/blog`, description: blog.description, inLanguage: 'pt-AO', publisher,
      blogPost: articles.map(a => ({ '@type': 'BlogPosting', headline: a.title, url: abs(a.url), datePublished: a.published, image: abs(a.og.src) })),
    },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Início', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog` },
    ] },
  ];
  return `${head({ title: blog.seoTitle, description: blog.description, path: '/blog', ogType: 'website', image: SHARE_IMAGE, imageAlt: SHARE_IMAGE.alt })}
${ld({ '@context': 'https://schema.org', '@graph': graph })}
</head>${top}
<main>
<nav class="crumbs wrap" aria-label="Estás aqui"><a href="/">Início</a><span aria-hidden="true">›</span><span aria-current="page">Blog</span></nav>
<section class="blog-hero wrap"><span class="eyebrow">BLOG DOT VIAGENS</span><h1>${esc(blog.title).replace('pagar em kwanzas.', '<em>pagar em kwanzas.</em>')}</h1><p>${esc(blog.lead)}</p></section>
<section class="wrap blog-list" aria-label="Artigos">${card(featured, ' featured')}<div class="post-grid">${rest.map(a => card(a)).join('')}</div></section>
<section class="blog-cta wrap"><div><h2>Pronto para a próxima viagem?</h2><p>Compara voos de Luanda para o mundo e paga em kwanzas.</p></div><a class="white-btn" href="/#pesquisa">Pesquisar voos <span>↗</span></a></section>
</main>
${bottom}`;
}

function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const url = (path, freq, priority, images = []) => `  <url>
    <loc>${abs(path)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${freq}</changefreq>
    <priority>${priority}</priority>${images.map(src => `\n    <image:image><image:loc>${abs(src)}</image:loc></image:image>`).join('')}
  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${[
    url('/', 'daily', '1.0', [SHARE_IMAGE.src, '/assets/hero/angola-mountains.jpg']),
    url('/blog', 'weekly', '0.8'),
    ...articles.map(a => url(a.url, 'monthly', '0.7', [a.og.src])),
  ].join('\n')}
</urlset>
`;
}

mkdirSync(OUT, { recursive: true });
const keep = new Set(['index.html', ...articles.map(a => `${a.slug}.html`)]);
for (const name of readdirSync(OUT)) if (name.endsWith('.html') && !keep.has(name)) unlinkSync(join(OUT, name));
writeFileSync(join(OUT, 'index.html'), indexPage());
for (const a of articles) writeFileSync(join(OUT, `${a.slug}.html`), articlePage(a));
writeFileSync(join(ROOT, 'public', 'sitemap.xml'), sitemap());
console.log(`blog: ${articles.length} artigos + índice; sitemap com ${articles.length + 2} endereços`);
for (const a of articles) console.log(`  /blog/${a.slug}  ${a.minutes} min · ${a.wordCount} palavras · descrição ${a.description.length} · título ${a.seoTitle.length}`);
