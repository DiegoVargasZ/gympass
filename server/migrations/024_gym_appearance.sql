ALTER TABLE settings ADD COLUMN ui_theme TEXT NOT NULL DEFAULT 'light' CHECK(ui_theme IN ('light','dark'));
ALTER TABLE settings ADD COLUMN ui_accent TEXT NOT NULL DEFAULT '#636b2f' CHECK(length(ui_accent)=7 AND substr(ui_accent,1,1)='#' AND substr(ui_accent,2) NOT GLOB '*[^0-9a-fA-F]*');
ALTER TABLE settings ADD COLUMN ui_density TEXT NOT NULL DEFAULT 'comfortable' CHECK(ui_density IN ('comfortable','compact'));
