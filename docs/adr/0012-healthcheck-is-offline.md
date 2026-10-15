# Health check never touches the network

The Docker `HEALTHCHECK` reads results the daemon caches in SQLite (GitHub auth every 30 min, last firewall check, disk). A live call would let a GitHub blip mark the container unhealthy and churn restarts.
