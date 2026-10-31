"""Central institutional archive (docs/phase1/README.md §3, 05 §archive).

An explicit, declared reader — not a back door: archive officers (a CENTRAL
``archive.institutional.access`` assignment) may open only correspondence the
sender classified ``institutional_archive_eligible``; senders and recipients
see that classification on the item, and every opening is audited.

Content is sealed at rest with the server key like all mail (apps.vault), so
the archive needs no key or copy of its own; it is a gated view over the
correspondence tables. Nothing here grants access to non-archived items.
"""
