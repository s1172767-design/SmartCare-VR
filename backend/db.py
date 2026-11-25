"""SQLite 数据访问层。

只干一件事：把训练成绩存进去、按学员读出来。
用标准库 sqlite3，不引 ORM —— 语句少、看得见、答辩讲得清。
"""

import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

# 数据库文件就放在 backend/ 目录下，随项目一起走，换电脑拷走即可
DB_PATH = Path(__file__).resolve().parent / "smartcare.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    learner_id  TEXT    NOT NULL,
    scenario    TEXT    NOT NULL,
    score       INTEGER NOT NULL,
    correct     INTEGER NOT NULL,
    total       INTEGER NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_learner
    ON attempts (learner_id, id DESC);
"""


def connect() -> sqlite3.Connection:
    """每次请求开一个短连接，避免多线程共享同一连接的问题。"""
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row  # 让查询结果可以按列名取值
    return conn


def init_db() -> None:
    """建表（幂等，重复调用不会报错）。应用启动时执行一次。"""
    with closing(connect()) as conn, conn:
        conn.executescript(SCHEMA)


def insert_attempt(learner_id: str, scenario: str, score: int, correct: int, total: int) -> dict:
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with closing(connect()) as conn, conn:
        cursor = conn.execute(
            """
            INSERT INTO attempts (learner_id, scenario, score, correct, total, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (learner_id, scenario, score, correct, total, created_at),
        )
        return {
            "id": cursor.lastrowid,
            "learner_id": learner_id,
            "scenario": scenario,
            "score": score,
            "correct": correct,
            "total": total,
            "created_at": created_at,
        }


def list_attempts(learner_id: str, limit: int = 30) -> list[dict]:
    with closing(connect()) as conn:
        rows = conn.execute(
            """
            SELECT id, learner_id, scenario, score, correct, total, created_at
            FROM attempts
            WHERE learner_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (learner_id, limit),
        ).fetchall()
    return [dict(row) for row in rows]
