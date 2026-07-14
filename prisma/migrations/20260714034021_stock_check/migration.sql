-- Camada 1 do anti-oversell (§6): defesa final no banco.
-- Prisma não expressa CHECK; adicionamos via SQL.
ALTER TABLE "variation"
  ADD CONSTRAINT "variation_stock_on_hand_nonneg" CHECK ("stock_on_hand" >= 0);

-- Título do produto <= 60 chars é validado na publicação (não no insert), então NÃO
-- vira CHECK aqui de propósito: o catálogo pode guardar rascunhos com título maior.
