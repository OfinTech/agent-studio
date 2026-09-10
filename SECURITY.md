# Security policy

This is an initial single-administrator release. Security fixes apply to the current main branch.

Please report suspected vulnerabilities privately through the repository hosting service's private vulnerability reporting feature when available. If it is unavailable, contact the repository owner privately to arrange a secure channel. Do not post secrets, active exploit payloads, or private receipt data in public issues.

Include affected versions, reproduction steps using synthetic data, and the expected versus observed security boundary. Relevant areas include credential encryption/isolation, webhook authentication, SSRF protections, session handling, workflow version integrity, and replay of API writes.

Deploy behind HTTPS, restrict access to PostgreSQL and mounted volumes, use narrowly scoped credentials, and configure exact tool origins. Private-origin exceptions deliberately bypass the public-address restriction for an administrator-selected origin; use them only for trusted internal services. The platform cannot undo external API side effects. Investigate any run marked `needs_review` before retrying it.

Encrypted credentials protect database contents only when the encryption key is stored separately. Email text, attachments, extracted receipt data, and execution checkpoints may contain personal information. Apply appropriate access controls, backups, and retention to your deployment.
