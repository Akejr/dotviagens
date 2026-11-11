# DOT Viagens

Pesquisa e compra de voos em kwanzas: selecção de ida e volta, calendário com o
preço indicativo de cada dia, preço final = câmbio do dia + taxa DOT (11% por
defeito, alterável no painel), verificação do telemóvel por SMS, avisos de preço
por SMS (até 2 por viagem), dados dos passageiros, pagamento manual pelo
WhatsApp ou Multicaixa Express e referência (Wiza), factura certificada (Vero),
área Minhas viagens, blog em `/blog` e painel de administração em tempo real em
`/admin` (com a cota da SerpApi e a pausa automática das pesquisas depois de
um erro de limite).

A documentação completa está em **MECANICA_DO_SISTEMA.txt**.

## Desenvolvimento local

- `corepack pnpm install`
- `corepack pnpm dev` (http://127.0.0.1:5173)
- `node --test tests/*.test.mjs`
- `corepack pnpm build`

As chaves ficam no ficheiro `.dev.vars` (fora do Git).

## Publicar na Vercel

O projecto já está configurado (`vercel.json`): site estático gerado por
`scripts/vercel-build.mjs` em `dist-vercel/` e uma função, `api/index.mjs`,
para todos os pedidos `/api/*`. Não instala dependências npm.
As páginas abrem sem `.html` (`/resultados`, `/compra`, `/minhas-viagens`,
`/admin`); os endereços antigos com `.html` redireccionam (308) para os novos.

1. Vercel → **Add New → Project** → importar `Akejr/dotviagens`. Manter as
   opções de build (vêm do `vercel.json`).
2. **Settings → Environment Variables** (Production): `SEARCHAPI_KEY` (pesquisa
   de voos; `FLIGHTS_PROVIDER=serpapi` volta à SerpApi), `SERPAPI_KEY` (reserva),
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NSANGU_API_KEY`, `WIPAY_BASE_URL`,
   `WIPAY_CLIENT_ID`, `WIPAY_CLIENT_SECRET`, `WIPAY_WEBHOOK_SECRET`,
   `VERO_API_KEY`, `VERO_ORG_ID`, `AUTH_SECRET`, `OFFER_SECRET`, `CRON_SECRET`,
   `ADMIN_PHONES`, `PUBLIC_BASE_URL` (endereço https final, usado nos
   callbacks da Wiza) e, opcionalmente, `OTP_HOURLY_LIMIT`.
3. Com domínio próprio, definir também `SITE_URL` (ex.: `https://www.dotviagens.ao`)
   e fazer **Redeploy**: canonical, Open Graph, robots e sitemap passam a usar
   esse endereço. Sem `SITE_URL`, o build usa o domínio de produção da Vercel.
4. Google Search Console: adicionar o domínio e submeter `/sitemap.xml`.

O cron diário (`vercel.json`) chama `/api/internal/sweep` com
`Authorization: Bearer CRON_SECRET` para verificar pagamentos pendentes.

Plano: o Hobby da Vercel é só para uso pessoal não comercial; um site que recebe
pagamentos precisa do Pro ([regras de uso](https://vercel.com/docs/limits/fair-use-guidelines)).
No Pro, o cron pode passar a `*/10 * * * *`.

## Base de dados

Aplicar, por ordem, as migrações de `supabase/migrations/` no projecto
Supabase (já aplicadas em `ycbmqytyfdkrpxvjcblk`):

1. `20261107200641_dot_viagens_core.sql`
2. `20261107214259_dot_viagens_live_pricing.sql`
3. `20261107233029_dot_viagens_calendar_cache.sql` (cache partilhado do calendário)
4. `20261108031554_dot_viagens_manual_payment.sql` (pagamento manual pelo WhatsApp)
5. `20261108191510_dot_viagens_profit.sql` (lucro inserido no painel e vendas fora do site)
6. `20261110155528_dot_viagens_alerts_settings_cache.sql` (avisos de preço, taxa DOT
   no painel, cache partilhado das pesquisas e pausa da SerpApi)
7. `20261110183804_dot_viagens_search_city.sql` (cidade aproximada de cada pesquisa)

## Blog

Os artigos estão em `content/blog/articles.mjs`. Depois de editar, correr
`node scripts/build-blog.mjs`: gera `public/blog/*.html` e `public/sitemap.xml`
(não editar esses ficheiros à mão). O script recusa travessões (— ou –) nos
textos.

## Aeroportos

`public/airports.json` tem só os aeroportos com voos regulares. Depois de o
mudar, correr `node scripts/build-airport-index.mjs`: filtra o ficheiro (sai
quem não tem voos regulares) e gera `server/airport-codes.mjs` e
`public/airport-countries.js`, com os países da pesquisa por país
("Brasil (todos os aeroportos)") e o id de cada país no Google, lido da
Wikidata. Depois correr `node scripts/build-main-airports.mjs` (os aeroportos
principais que a pesquisa por país compara; usa a `SEARCHAPI_KEY` do
`.dev.vars`, ~190 pesquisas só na primeira vez ou com `--refresh`) e o
script seguinte.

`public/airports-popular.js` (os aeroportos que aparecem logo, antes de o
catálogo completo `public/airports.json` carregar) é gerado por
`node scripts/build-airports-popular.mjs`. Correr de novo depois de mudar a
lista do script ou o `airports.json`.

Configure as chaves somente no ambiente do servidor (Vercel ou `.dev.vars`).
Nunca no frontend nem no repositório.
