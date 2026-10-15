# One job at a time via a SQLite lease

`docker compose run --rm runner <cmd>` starts a second container beside the daemon, so an in-process queue alone can't guarantee one job at a time. A `job_lock` row (pid, host, heartbeat) is the lease; CLI jobs that find it held exit 75, and read-only commands skip it. `docker exec` is the documented way to run commands.
