"""Cloud storage backends implementing `gilzacode.cloud.base.CloudStorageProvider`.

Modules here are imported lazily by `gilzacode.cloud.registry`, so a backend with
an unmet optional dependency never breaks application start-up.
"""
