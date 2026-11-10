"""Optional mirroring of an GilzaCode project to cloud storage.

The package is provider-neutral by construction: `base` defines the contract,
`engine` reconciles a project against any implementation of it, and
`providers/` holds the backends. Nothing outside `providers/google_drive.py`
knows that Google Drive exists.

Nothing here runs unless the user turns it on for a specific project.
"""

from .base import (
    AuthChallenge,
    AuthState,
    Capabilities,
    CloudAuthError,
    CloudError,
    CloudPreconditionFailed,
    CloudQuotaExceeded,
    CloudStorageProvider,
    CloudTransientError,
    RemoteEntry,
    RemoteProject,
)
from .engine import PULL, PUSH, TWO_WAY, SyncEngine, SyncReport
from .registry import ProviderInfo, get_cloud_provider, list_providers, register_provider
from .state import CloudSettings, CloudState, load_settings, load_state, save_settings, save_state

__all__ = [
    "AuthChallenge",
    "AuthState",
    "Capabilities",
    "CloudAuthError",
    "CloudError",
    "CloudPreconditionFailed",
    "CloudQuotaExceeded",
    "CloudSettings",
    "CloudState",
    "CloudStorageProvider",
    "CloudTransientError",
    "ProviderInfo",
    "PULL",
    "PUSH",
    "RemoteEntry",
    "RemoteProject",
    "SyncEngine",
    "SyncReport",
    "TWO_WAY",
    "get_cloud_provider",
    "list_providers",
    "load_settings",
    "load_state",
    "register_provider",
    "save_settings",
    "save_state",
]
