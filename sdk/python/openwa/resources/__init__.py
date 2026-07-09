"""Resource modules for the OpenWA Python SDK.

Each module defines a small ``_*Resource`` class whose methods map 1:1 to an
API path group. They are constructed by :class:`openwa.client.OpenWAClient`.
"""

from __future__ import annotations

from .catalog import CatalogResource
from .channels import ChannelsResource
from .chats import ChatsResource
from .contacts import ContactsResource
from .groups import GroupsResource
from .health import HealthResource
from .labels import LabelsResource
from .messages import MessagesResource
from .search import SearchResource
from .sessions import SessionsResource
from .status import StatusResource
from .templates import TemplatesResource
from .webhooks import WebhooksResource

__all__ = [
    "CatalogResource",
    "ChannelsResource",
    "ChatsResource",
    "ContactsResource",
    "GroupsResource",
    "HealthResource",
    "LabelsResource",
    "MessagesResource",
    "SearchResource",
    "SessionsResource",
    "StatusResource",
    "TemplatesResource",
    "WebhooksResource",
]
