# Changelog

All notable changes to Container Dashboard Status are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with versions in the form
v<major>.<minor> (two-digit minor) to match the Git tags and Docker image tags.

## [Unreleased]

## [1.00] - 2026-11-24

### Added
- First release: a read-only web page with a card per machine showing each Docker container's
  state, memory in use, image, when the image was built (and pulled) and when the container was
  last updated, with totals across all machines.
- Settings on the page: add, test and remove machines, and make an SSH key in the app (or paste
  your own). It shows the line to add to each machine's `authorized_keys`, which limits the key
  to reading Docker. The key is stored encrypted in the data folder and never shown again.
- Machines through the local Docker socket (mounted read-only), over SSH with a key (running
  `docker system dial-stdio`, with an optional docker path for Synology), or through a read-only
  Docker socket proxy. Only GET requests are ever sent. `HOSTS` in `.env` gives the first list.
- Optional SSH host key pinning (`SSH_FINGERPRINTS`).
- Search, Running / Stopped / Problems filter, sortable columns and foldable machine cards.
- Refreshes itself every `REFRESH_SECONDS` (default 30); each machine is read once per refresh
  however many browsers are open.
- Sign-in with one username and password and a lockout after 10 wrong passwords in 15 minutes.
- Light and dark looks, Help, About and `GET /healthz`.
