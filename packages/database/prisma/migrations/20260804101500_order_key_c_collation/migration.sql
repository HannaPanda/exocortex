-- The fractional order key is compared as a byte sequence: `generateOrderKey`
-- guarantees that a new key sorts strictly between its neighbours under plain
-- lexicographic (byte) ordering.
--
-- With the database's default collation (for example en_US.UTF-8) 'l' sorts
-- before 'V', which breaks that guarantee and makes sibling order depend on the
-- server locale. Pinning the column to the C collation makes every comparison,
-- ORDER BY and index use byte order.
ALTER TABLE "document"
  ALTER COLUMN "orderKey" TYPE text COLLATE "C";
