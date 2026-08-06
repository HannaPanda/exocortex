-- Same reasoning as 20260804101500_order_key_c_collation, which fixed only
-- `document`: `generateOrderKey` guarantees a key that sorts strictly between
-- its neighbours under **byte** ordering. Under the database's default
-- collation (en_US.UTF-8 here) 'l' sorts before 'V', so "the last sibling"
-- resolved to the wrong row and every newly created view or property got the
-- same key as the one before it. Visible symptom: a database's view tabs came
-- out in creation-independent, locale-dependent order.
ALTER TABLE "database_property"
  ALTER COLUMN "orderKey" TYPE text COLLATE "C";

ALTER TABLE "database_view"
  ALTER COLUMN "orderKey" TYPE text COLLATE "C";

ALTER TABLE "database_property_option"
  ALTER COLUMN "orderKey" TYPE text COLLATE "C";
