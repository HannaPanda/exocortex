-- Issue #221, two pieces of housekeeping on `document."orderKey"`.
--
-- 1. The same index twice. The init migration created
--    "document_order_key_idx" by hand to pin the C collation, and Prisma
--    created "document_workspaceId_parentId_orderKey_idx" from the schema.
--    Since 20260804101500 the column itself is C-collated, so the two are
--    identical and every write maintained both. The one the schema names stays.
DROP INDEX IF EXISTS "document_order_key_idx";

-- 2. Keys that grew. Appending used to halve the gap to the end of the list,
--    which made the last key one character longer every five pages (76
--    characters in a branch of 380). `generateOrderKey` now counts instead,
--    but counting up from a long key keeps it long, so every sibling list that
--    holds a key longer than 12 characters is numbered again, in its current
--    order: 'V001', 'V003', … — four characters, odd so the last digit is
--    never '0', and starting at 'V' so that a page added before or after the
--    list gets a one-character key again. Order within a list is unchanged,
--    and nothing outside the column refers to a key.
--
--    Four digits starting at 'V' hold 3.7 million siblings, far more than any
--    list this is for.
WITH long_lists AS (
  SELECT "workspaceId", "parentId"
  FROM "document"
  GROUP BY "workspaceId", "parentId"
  HAVING max(length("orderKey")) > 12
),
numbered AS (
  SELECT
    d."id",
    (31 * 238328 + 2 * row_number() OVER (
      PARTITION BY d."workspaceId", d."parentId"
      ORDER BY d."orderKey", d."id"
    ) - 1)::int AS "n"
  FROM "document" d
  JOIN long_lists l
    ON l."workspaceId" = d."workspaceId"
   AND l."parentId" IS NOT DISTINCT FROM d."parentId"
)
UPDATE "document" d
SET "orderKey" =
      substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (n."n" / 238328) % 62 + 1, 1)
   || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (n."n" / 3844) % 62 + 1, 1)
   || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (n."n" / 62) % 62 + 1, 1)
   || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', n."n" % 62 + 1, 1)
FROM numbered n
WHERE d."id" = n."id";
