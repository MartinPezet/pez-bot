Read `{{PRD_PATH}}` and convert it into `{{OUT_DIR}}/backlog.json`: an array of backlog items that will become GitHub issues. Don't create any issues yourself, and only write the two files named here.

Each item:

```json
{
  "title": "string",
  "body": "markdown string",
  "type": "feature | bug | chore | spike",
  "area": ["string"],
  "priority": "p1 | p2 | p3",
  "source": "the PRD heading this came from"
}
```

Rules:

- One item per independently shippable outcome. Split long sections; merge fragments that only make sense together.
- Titles are imperative, specific and under 70 characters ("Render water strikes on the log", not "Water strikes").
- Body sections: `## Context` (the relevant PRD lines quoted verbatim in a blockquote), `## Outcome` (one sentence), `## Notes` (anything else from the PRD). Don't invent requirements or acceptance criteria; triage adds those.
- Check the codebase. Skip anything clearly already implemented, and list skipped items with the evidence (file paths) in `{{OUT_DIR}}/skipped.md`.
- `area` uses only: {{AREAS}}.
- Priority from PRD signals: MVP / beta / must → p1; default p2; later / nice to have → p3.

Finish by printing counts per type, area and priority.
