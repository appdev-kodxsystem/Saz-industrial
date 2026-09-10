-- ---------------------------------------------------------------------------
-- Remove the "retire an add-on" flow
-- ---------------------------------------------------------------------------
-- An add-on is now either in the catalogue or deleted. Deleting was already
-- safe for history — addon_stock_batches.addon_id and sale_addons.addon_id are
-- both ON DELETE SET NULL and carry name/code snapshots — so the middle state
-- was carrying its own UI, its own server function and its own index for no
-- outcome the delete did not already cover.
--
-- addons.active is deliberately NOT dropped here. Dropping a column is
-- irreversible and would discard which add-ons an org had retired; nothing
-- reads or writes it any more, so it is inert either way. Drop it deliberately
-- when you are sure that record is not wanted:
--
--   ALTER TABLE public.addons DROP COLUMN active;
--
-- The index is another matter: it led on `active` because the catalogue used to
-- be ordered by it. Nothing sorts or filters on that column now, so this
-- replaces it with the index the remaining query actually uses.
DROP INDEX IF EXISTS public.addons_org_active_idx;
CREATE INDEX IF NOT EXISTS addons_org_name_idx ON public.addons (org_id, name);

NOTIFY pgrst, 'reload schema';
