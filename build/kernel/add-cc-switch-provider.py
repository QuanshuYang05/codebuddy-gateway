"""Add a workbuddy2api-backed provider into CC-Switch's SQLite DB.

Backs up the DB first, then inserts one claude provider pointing at the
local gateway. Safe to re-run: skips if a provider with the same name exists.
"""

import json
import shutil
import sqlite3
import time
import uuid
from pathlib import Path

DB = Path(r"C:\Users\KAKAO\.cc-switch\cc-switch.db")
GATEWAY = "http://127.0.0.1:8787"
MODEL = "deepseek-v4-pro"
FAST = "deepseek-v4-flash"
NAME = "CodeBuddy 本地网关"

backup = DB.with_suffix(".db.bak-before-workbuddy2api-" + time.strftime("%Y%m%d_%H%M%S"))
shutil.copy2(DB, backup)
print("backup ->", backup.name)

con = sqlite3.connect(DB)
cur = con.cursor()

cur.execute("select id from providers where name=?", (NAME,))
if cur.fetchone():
    print("provider already exists, nothing to do")
    con.close()
    raise SystemExit(0)

env = {
    "ANTHROPIC_BASE_URL": GATEWAY,
    "ANTHROPIC_AUTH_TOKEN": "local-dummy",
    "ANTHROPIC_MODEL": MODEL,
    "ANTHROPIC_DEFAULT_SONNET_MODEL": MODEL,
    "ANTHROPIC_DEFAULT_OPUS_MODEL": MODEL,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": FAST,
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": MODEL,
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": MODEL,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": FAST,
}
settings_config = json.dumps({"env": env}, ensure_ascii=False)
meta = json.dumps(
    {"commonConfigEnabled": True, "endpointAutoSelect": False, "apiFormat": "anthropic"},
    ensure_ascii=False,
)

cur.execute(
    """insert into providers
       (id, app_type, name, settings_config, website_url, category, created_at,
        sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue,
        cost_multiplier, limit_daily_usd, limit_monthly_usd, provider_type)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
    (
        str(uuid.uuid4()),
        "claude",
        NAME,
        settings_config,
        GATEWAY,
        None,
        int(time.time() * 1000),
        None,
        "需先运行 start-gateway.bat 启动 workbuddy2api (127.0.0.1:8787)",
        None,
        None,
        meta,
        0,
        0,
        "1.0",
        None,
        None,
        None,
    ),
)
con.commit()

print("--- providers now ---")
for row in cur.execute("select name, app_type, is_current, settings_config from providers"):
    print(f"{row[1]:8} | {row[0]:20} | current={row[2]}")
con.close()
print("done")
