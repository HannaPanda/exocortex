-- CreateEnum
CREATE TYPE "DatabasePropertyType" AS ENUM ('TEXT', 'NUMBER', 'SELECT', 'MULTI_SELECT', 'DATE', 'CHECKBOX', 'URL', 'EMAIL', 'PHONE', 'PERSON', 'FILES', 'CREATED_TIME', 'UPDATED_TIME', 'CREATED_BY', 'UPDATED_BY', 'RELATION', 'ROLLUP', 'FORMULA');

-- CreateEnum
CREATE TYPE "DatabaseViewType" AS ENUM ('TABLE', 'BOARD', 'GALLERY', 'CALENDAR');

-- CreateTable
CREATE TABLE "database_property" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "type" "DatabasePropertyType" NOT NULL,
    "name" TEXT NOT NULL,
    "orderKey" TEXT NOT NULL,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_property_option" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "orderKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_property_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_view" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "type" "DatabaseViewType" NOT NULL,
    "name" TEXT NOT NULL,
    "orderKey" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '[]',
    "sorts" JSONB NOT NULL DEFAULT '[]',
    "groupByPropertyId" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_property_value" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "textValue" TEXT,
    "numberValue" DECIMAL(20,6),
    "boolValue" BOOLEAN,
    "dateValue" TIMESTAMP(3),
    "jsonValue" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_property_value_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "database_property_documentId_orderKey_idx" ON "database_property"("documentId", "orderKey");

-- CreateIndex
CREATE UNIQUE INDEX "database_property_documentId_name_key" ON "database_property"("documentId", "name");

-- CreateIndex
CREATE INDEX "database_property_option_propertyId_orderKey_idx" ON "database_property_option"("propertyId", "orderKey");

-- CreateIndex
CREATE UNIQUE INDEX "database_property_option_propertyId_label_key" ON "database_property_option"("propertyId", "label");

-- CreateIndex
CREATE INDEX "database_view_documentId_orderKey_idx" ON "database_view"("documentId", "orderKey");

-- CreateIndex
CREATE UNIQUE INDEX "database_view_documentId_name_key" ON "database_view"("documentId", "name");

-- CreateIndex
CREATE INDEX "document_property_value_documentId_idx" ON "document_property_value"("documentId");

-- CreateIndex
CREATE INDEX "document_property_value_propertyId_textValue_idx" ON "document_property_value"("propertyId", "textValue");

-- CreateIndex
CREATE INDEX "document_property_value_propertyId_numberValue_idx" ON "document_property_value"("propertyId", "numberValue");

-- CreateIndex
CREATE INDEX "document_property_value_propertyId_dateValue_idx" ON "document_property_value"("propertyId", "dateValue");

-- CreateIndex
CREATE INDEX "document_property_value_propertyId_boolValue_idx" ON "document_property_value"("propertyId", "boolValue");

-- CreateIndex
CREATE UNIQUE INDEX "document_property_value_documentId_propertyId_key" ON "document_property_value"("documentId", "propertyId");

-- AddForeignKey
ALTER TABLE "database_property" ADD CONSTRAINT "database_property_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_property_option" ADD CONSTRAINT "database_property_option_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "database_property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_view" ADD CONSTRAINT "database_view_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_property_value" ADD CONSTRAINT "document_property_value_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_property_value" ADD CONSTRAINT "document_property_value_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "database_property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Array-valued properties (MULTI_SELECT, PERSON, FILES) are stored in
-- jsonValue and queried with the containment operator (@>), which needs a
-- jsonb_path_ops GIN index. Prisma cannot declare this, so it is hand-added
-- here, the same way the order-key C collation is (see
-- 20260804101500_order_key_c_collation).
CREATE INDEX "document_property_value_json_gin"
  ON "document_property_value" USING GIN ("jsonValue" jsonb_path_ops);
