-- ============================================================
-- Migration 003: Add sort_order for display reordering
--
-- sort_order controls the display order of accounts and
-- categories (lower values appear first). Both are already
-- tracked in IndexedDB; this adds the column to the remote
-- tables so sync doesn't fail on the unknown field.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN sort_order INTEGER;

ALTER TABLE categories
  ADD COLUMN sort_order INTEGER;
