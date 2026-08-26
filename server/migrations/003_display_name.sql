-- 003_display_name.sql — a display name, separate from the login username.
--
-- `username` stays the stable identity: login, ownership, the UNIQUE
-- constraint. `display_name` is purely cosmetic — what shows up in the
-- topbar, History's "By" column, the Analytics switcher, and the CSV export.
-- NULL means "no display name set, just show the username", which is why
-- every read of it falls back to username rather than requiring one.
ALTER TABLE users ADD COLUMN display_name TEXT;
