# GitHub API over fetch, not gh or Octokit

The runner calls GraphQL and REST with Node's `fetch` behind a `GitHub` interface. This keeps tokens in memory, makes `DRY_RUN` a simple decorator that logs writes, and keeps tests on fakes with no extra dependency. `gh` stays in the image only for manual debugging.
