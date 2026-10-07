#!/bin/sh
# git calls this for credentials. The token comes from the calling process's environment
# (set per git invocation by the runner), never from disk.
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "$GIT_PASSWORD" ;;
esac
