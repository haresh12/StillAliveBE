# stillalive-backend (Wellness OS BE) — CLAUDE.md

---

## 🚨 RULE #1 — NEVER DEPLOY WITHOUT ASKING 3× IN BIG CAPS

Before `git push`, `fly deploy`, `flyctl deploy`, or any operation that hits real users — **ASK 3 SEPARATE TIMES IN BIG CAPS** and wait for explicit "yes" each time:

1. **"ARE YOU SURE YOU WANT TO DEPLOY TO PRODUCTION?"**
2. **"THIS WILL AFFECT REAL USERS. CONFIRM AGAIN?"**
3. **"FINAL CONFIRMATION — DEPLOY NOW?"**

Any non-yes answer → STOP. See `/CLAUDE.md` at project root for full rule.

---

## Repo-specific laws

- **No `users` collection.** Use `wellness_users/{deviceId}`. Any new collection must start with `wellness_` or be domain-specific (`community_users`, `aliveChecks` are pre-existing exceptions).
- **No API versioning suffixes pre-launch.** Edit existing routes in place. No `/v2`, `/v3`, `_legacy/*` on canonical paths.
- **OpenAI calls:** `max_completion_tokens:` only. Never `max_tokens:` or `temperature:`.
- **Per-agent sandbox:** agent code reads only its own `wellness_users/{id}/agents/{coach}/*`. Cross-agent reads only in `wellness-cross-v2`.
- **Model registry:** `lib/ai/models.js` is the single source of truth for model IDs. Don't hardcode model strings anywhere else.
- **Deploy target:** `wellness-os-api.fly.dev`. Build before deploy: `npm test` (when applicable), confirm health endpoint, then ask 3× in BIG CAPS.
