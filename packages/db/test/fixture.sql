CREATE TABLE items (id text primary key, n integer not null check (n >= 0));
CREATE TABLE tags (id text primary key, item_id text not null references items (id));
