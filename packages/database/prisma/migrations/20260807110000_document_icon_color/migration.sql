-- Colour of a drawn page icon.
--
-- Presentation only. `icon` already held both an emoji and, from now on, a
-- `lucide:<name>` from the curated set; this column colours the drawn one. An
-- emoji brings its own colours and ignores it.
--
-- A plain TEXT rather than an enum: the palette is validated by the contract,
-- and adding a colour should not cost a migration. NULL means the icon inherits
-- the surrounding text colour, which is what every icon did until now.
ALTER TABLE "document"
  ADD COLUMN "iconColor" TEXT;
