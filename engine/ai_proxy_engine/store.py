"""Compatibility exports for the storage layer.

The original monolithic store moved to ``storage.py`` when the Agent harness,
evidence, scenario and integration records were added. Keeping this module as
a small compatibility layer avoids changing imports in the proxy and desktop
engine entry points.
"""

from .storage import MAX_BODY_BYTES, SCHEMA_VERSION, Store, new_id, now_ms

__all__ = ["MAX_BODY_BYTES", "SCHEMA_VERSION", "Store", "new_id", "now_ms"]
