"""Calibrate ECAPA speaker thresholds for local desktop voice login.

Revision ID: 006
Revises: 005
Create Date: 2026-08-29 20:30:00.000000

The legacy seed used the old Resemblyzer threshold (0.75) even after ECAPA
became the default encoder. Genuine local desktop scores observed across clean
4-6 second samples occupy a lower cosine range. This migration changes only
the untouched legacy value and adds the duration-specific long-clip setting;
custom operator values are preserved.
"""

from alembic import op
import sqlalchemy as sa

revision = '006'
down_revision = '005'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text("""
            UPDATE settings
               SET value = '0.40',
                   description = 'ECAPA cosine threshold for normal voice clips',
                   updated_at = CURRENT_TIMESTAMP
             WHERE key = 'voice.similarity_threshold'
               AND value = '0.75'
               AND household_id IS NULL
               AND node_id IS NULL
               AND user_id IS NULL
        """)
    )
    exists = conn.execute(
        sa.text("""
            SELECT 1 FROM settings
             WHERE key = 'voice.threshold_long'
               AND household_id IS NULL
               AND node_id IS NULL
               AND user_id IS NULL
             LIMIT 1
        """)
    ).scalar()
    if not exists:
        conn.execute(
            sa.text("""
                INSERT INTO settings
                    (key, value, value_type, category, description,
                     requires_reload, is_secret, household_id, node_id, user_id)
                VALUES
                    ('voice.threshold_long', '0.34', 'float', 'voice',
                     'Calibrated ECAPA threshold for voice clips longer than three seconds',
                     false, false, NULL, NULL, NULL)
            """)
        )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text("""
            UPDATE settings
               SET value = '0.75',
                   updated_at = CURRENT_TIMESTAMP
             WHERE key = 'voice.similarity_threshold'
               AND value = '0.40'
               AND household_id IS NULL
               AND node_id IS NULL
               AND user_id IS NULL
        """)
    )
    conn.execute(
        sa.text("""
            DELETE FROM settings
             WHERE key = 'voice.threshold_long'
               AND value = '0.34'
               AND household_id IS NULL
               AND node_id IS NULL
               AND user_id IS NULL
        """)
    )
