#!/usr/bin/env python3
import sqlite3
import json
import tempfile
from pathlib import Path

root = Path(tempfile.mkdtemp(prefix='audit-db-'))
db_file = root / 'audit.db'
conn = sqlite3.connect(str(db_file))

conn.execute('''CREATE TABLE adm_user_programme_selection (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    programme_id INTEGER
)''')

conn.execute('''CREATE TABLE adm_user_prgramme_personal (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    full_name TEXT
)''')

conn.execute('''CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    order_date TEXT
)''')

conn.execute('INSERT INTO adm_user_programme_selection VALUES (1, 101, 1), (2, 102, 2), (3, 103, 3)')
conn.execute('INSERT INTO adm_user_prgramme_personal VALUES (1, 101, ?), (2, 102, ?)', ('Alice', 'Bob'))
conn.execute('INSERT INTO orders VALUES (1, ?), (2, ?)', ('2026-01-01', '2026-01-02'))
conn.commit()
conn.close()

print(json.dumps({'dbFile': str(db_file), 'projectRoot': str(root)}))
