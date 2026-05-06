"""
Memory Module - Agent记忆管理

支持跨session的记忆存储
"""

from typing import Dict, List, Any, Optional
import json
import time
from datetime import datetime


class MemoryStore:
    """简单的内存存储"""

    def __init__(self):
        self.sessions: Dict[str, List[Dict]] = {}
        self.metadata: Dict[str, Dict] = {}

    def save_session(self, session_id: str, messages: List[Dict]):
        """保存会话"""
        self.sessions[session_id] = messages.copy()
        self.metadata[session_id] = {
            "last_update": time.time(),
            "message_count": len(messages)
        }

    def load_session(self, session_id: str) -> Optional[List[Dict]]:
        """加载会话"""
        return self.sessions.get(session_id)

    def add_message(self, session_id: str, message: Dict):
        """添加消息"""
        if session_id not in self.sessions:
            self.sessions[session_id] = []
            self.metadata[session_id] = {
                "created_at": time.time(),
                "last_update": time.time()
            }

        self.sessions[session_id].append(message)
        self.metadata[session_id]["last_update"] = time.time()
        self.metadata[session_id]["message_count"] = len(self.sessions[session_id])

    def clear_session(self, session_id: str):
        """清除会话"""
        if session_id in self.sessions:
            del self.sessions[session_id]
        if session_id in self.metadata:
            del self.metadata[session_id]

    def list_sessions(self) -> List[Dict]:
        """列出所有会话"""
        result = []
        for session_id, meta in self.metadata.items():
            result.append({
                "session_id": session_id,
                "last_update": datetime.fromtimestamp(meta["last_update"]).isoformat(),
                "message_count": meta.get("message_count", 0)
            })
        return sorted(result, key=lambda x: x["last_update"], reverse=True)


memory_store = MemoryStore()
