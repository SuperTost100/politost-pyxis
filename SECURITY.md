# Security

Pyxis keeps the workspace on this computer. Chat, plans, sources and keys do not leave the machine unless you turn on crash reports in Settings, and that switch does not send anything yet.

API keys are encrypted with the operating system's safe storage and written to `userData/keys.json`. The renderer cannot read the database or the key file. It talks to the core process through a message port.

Report a problem by opening an issue once the repository has a remote. Until then, write it down for the owner. Include the version from `package.json` and what you were doing. Do not paste an API key, a prompt, or text from your sources.
