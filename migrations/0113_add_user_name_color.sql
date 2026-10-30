-- Flaxia+ display-name color (one of the palette values in src/lib/name-color.ts).
-- NULL = default theme color. Rendered only while users.badge_type = 'flaxia_plus'.
ALTER TABLE users ADD COLUMN name_color TEXT;
