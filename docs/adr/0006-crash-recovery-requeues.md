# Crash recovery requeues instead of blocking

With checkpoints and a SQLite job log, a restart mid-job (update, reboot) is normal. An issue stuck in `proposing`/`building` with no live lease goes back to `ready`/`approved` and resumes from its branch. It is blocked only if the same issue is recovered twice within 24 h, which signals a crash loop rather than a restart.
