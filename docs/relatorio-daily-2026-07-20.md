# Relatório pra daily — 2026-07-20

## TL;DR

**958 anúncios ativos no Mercado Livre, todos publicados pelo hub.** 9 erros
em aberto, todos com causa real documentada (nenhum bug de código). 39 guias
de tamanho no cache (24 criados pelo hub, o resto reusado de guias reais já
existentes na conta) — nenhuma medida inventada em nenhum deles. 65/65 testes
verdes, Postgres de dev conferido intacto, servidor no ar.

## Números por lote (madrugada de 19→20/07)

| Lote | SKUs ativos | Fonte da medida |
|---|---|---|
| Levi's fem camisa + jaqueta | 8 | print oficial (data/levis) — equivalência BR↔USA da marca |
| Maria Filó (blusas, vestidos, regatas, tricot) | 36 | print oficial (data/maria filo) + de-para 36=PP…42=G |
| CK shorts fem | 6 | tabela padrão CK + composição real do site da CK (85% poliamida) |
| CK jaquetas fem | 6 | tabela padrão CK |
| Levi's calças jeans masc | 81 | guia oficial levi.com.br (tabela masc W28–52, com coluna BR) |
| **Total da madrugada** | **137** | |

Mais os 114 da noite anterior (Richards fem 60, CK fem 45, Levi's fem bottoms
20…) e os 707 de antes — histórico completo em CLAUDE.md.

## Técnicas novas (o que vale contar na daily)

1. **Leitura dos guias de medida das marcas em fonte primária**: o widget
   "Tabela de Medidas" dos sites (Richards/CK) é Sizebay — li tamanho a
   tamanho pelo navegador (extensão Chrome). Descobertas: Richards padroniza
   a tabela fem de tops (blusa = tricot), mas camisa e jaqueta têm tabelas
   próprias; CK usa UMA tabela feminina pra tudo (camiseta = blusa =
   vestido, 3 categorias conferidas) — e a versão completa tem PP, que
   destravou SKUs PP bloqueados.
2. **Verificação de atributo por foto sem navegador**: baixo a foto da
   Moovin (`image_url`) e leio a imagem direto — resolveu SLEEVE_TYPE,
   LENGTH_TYPE, SHORT_TYPE em dezenas de produtos. Ambíguo → bloqueia e
   pergunta (ex.: blusa verde Richards, Longa vs 3/4, segue parada).
3. **Composição de tecido pelo catálogo público VTEX das marcas**: a API
   `/api/catalog_system/pub/products/search` da CK expõe a composição real
   ("85% Poliamida") — foi a fonte do MAIN_MATERIAL dos shorts. Descobri
   também o tenant Sizebay da CK (4882) via GraphQL público do VTEX
   (`publicAppSettings`) — e que a API V4 do Sizebay não serve leitura
   anônima (o POST é upsert; abortei pra não mutar sistema de terceiro).
4. **Dois sistemas de numeração na MESMA marca**: as calças Levi's masc
   vinham metade em W-size USA (30–40, o "33" denuncia) e metade em
   numeração BR (38–50). A tabela oficial da Levi's tem as DUAS colunas —
   criei 2 guias (um por sistema) e publiquei em 2 passes trocando as
   linhas do cache entre eles. 81/81 sem erro.
5. **Pipeline generalizado**: `extraAttrs` (obrigatório de categoria sem
   fonte → bloqueia com o nome do atributo; com dado verificado → resolve)
   e `queryHint` (marca desvia o domain_discovery — ex. "camisa LEVIS" cai
   em T_SHIRTS; hint "jeans feminina" corrige — o guarda-corpo de domínio
   continua intacto). 65/65 testes verdes.
6. **Guias por união e por pseudo-marca** (padrão HUB-*): rótulos mistos
   (letras + numeração) viram 2 charts no ML unidos no cache local; o
   SIZE_GRID_ID certo por item sai do prefixo da linha casada.

## Decisões tomadas (com liberdade dada, todas validadas)

- **MF numeração 36–42 → PP–G**: o site da MF vende HOJE nos dois sistemas
  (36–44 e PP–GG, mesma cardinalidade) — apliquei a bijeção padrão. É o
  único passo interpretativo da noite; fácil de reverter se a MAGNI tiver o
  de-para oficial.
- **Guia Levi's fem (print) usado pra camisa E jaqueta**: a tabela é de
  medida corporal (BODY_MEASURE = corpo da pessoa) e é a única de letras fem
  que a Levi's publica.
- **Calças Levi's "38–50 sem 33" = numeração BR**: ranges com 33 são USA;
  ranges pares 38–50 são BR (site oficial mapeia BR 38–50 = USA 30–40).

## Estado atual dos 9 erros em aberto (conferido agora, direto no banco)

Todos com causa real, nenhum é bug — a maioria já estava mapeada:

- **1x item legado** (variação múltipla antiga tentando publicar com
  `family_name` — conflito de modelo, produto legado fora do caminho atual)
- **1x bolsa MONTENAPOLEONE AMÊNDOA**: GTIN exigido pela marca registrada,
  sem catálogo na cor certa — bloqueio conhecido desde a sessão das bolsas
- **1x óculos Lacoste categoria SUNGLASSES**: `moderations.seller.not_authorized`
  — aguardando autorização de marca do Miguel na conta ML
- **4x tamanhos sem linha no guia** ("P (3)", "6" ×3, "M (40)") — rótulo
  misto de origem, sem medida real disponível pra essas linhas
- **1x item sem foto**: `requiresPictures` — gap de origem na Moovin

Nenhum estado sujo: todo erro é de um `POST /items` que devolveu 400, não
criou nada no ML.

## Bloqueados (nunca tentados / bloqueio de fonte de dado) — nada disso é bug

- **Sem tabela da marca acessível (precisa navegador/decisão)**: CK camisas
  masc (97 SKUs!), Lacoste polos+camisetas (128), Richards calças/saias/
  vestidos fem (26), CK calças fem (10, composição ambígua no site: 2
  pantalonas diferentes), infantil CK/LILICA (~40, precisa guia infantil +
  mapa de gênero), FOXTON bermudas (19).
- **Categoria/decisão de negócio**: CK TOPs Modern Cotton (20) — discovery
  manda pra "Tops de Fitness", mas são underwear; publicar lá é
  miscategorizar. Precisa decisão. Underwear em geral (cuecas, pijamas,
  calcinhas, bodies, ~60 SKUs) — domínios não mapeados ainda.
- **Dado de origem**: "BLUSA MOLETOM" CK (é moletom com capuz, TIPO errado),
  MC GIRL (infantil rotulado adulto), blusa verde Richards (manga ambígua),
  SLIM TAPER VERDE (chino, PANT_TYPE sem valor na lista do ML).
- **Saias MF (2)**: SKIRTS exige quadril e a tabela MF não tem.

## Estado do sistema (conferido agora)

- **958 listings `active` / 9 `error`** — direto do Postgres de dev, batendo
  exato com a contagem de ontem à noite (nenhuma regressão, nenhum anúncio
  perdido).
- **960 produtos / 2705 variações / 39 charts em cache / 1 credencial ML
  válida.**
- **65/65 testes verdes** — rodado agora; Postgres de dev conferido
  intacto antes/depois (isolamento teste/dev via porta 5434 seguindo firme).
- **Servidor no ar** (`GET /health` → `{"status":"ok","db":"up"}`) — caiu e
  foi reiniciado algumas vezes de madrugada por gerenciamento de processo em
  segundo plano fora do meu controle; os 958 anúncios já publicados nunca
  foram afetados (vivem no Mercado Livre, não no processo local).
- Muitos itens novos passam uns minutos em `paused
  [picture_download_pending]` — converte pra `active` sozinho (fila de foto
  do ML), padrão já conhecido.
