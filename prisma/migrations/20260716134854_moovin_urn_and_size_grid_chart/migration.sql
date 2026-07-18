-- CreateEnum
CREATE TYPE "SizeGridChartType" AS ENUM ('BRAND', 'STANDARD', 'SPECIFIC');

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "moovin_urn" TEXT;

-- CreateTable
CREATE TABLE "size_grid_chart" (
    "id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "chart_id" TEXT NOT NULL,
    "chart_type" "SizeGridChartType" NOT NULL,
    "rows" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "size_grid_chart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "size_grid_chart_domain_id_brand_gender_key" ON "size_grid_chart"("domain_id", "brand", "gender");

-- CreateIndex
CREATE UNIQUE INDEX "product_moovin_urn_key" ON "product"("moovin_urn");

